// Compositing checks (Chromium, through the DevTools protocol). A card list
// beside a sticky panel must paint in the page's own layer: a card's
// `z-index: 1` part (its links, its sparkline, above the card's stretched
// link) paints after the sticky panel, which moves as the window scrolls, so
// Chromium gave every such part a compositing layer of its own ("assumed
// overlap"). Thirty dams made thirty layers, each rasterised on its own, and a
// card scrolled into view showed its sparkline and links blank until its
// layer caught up. `isolation: isolate` on the card keeps them in the card's
// stacking context (ui-playbook.md § 4, "A card with a stretched link beside
// a sticky panel isolates itself"). Pinned by dams-page.spec.ts and
// supply-page.spec.ts.
import type { Page } from '@playwright/test';

/**
 * The compositing layers whose node sits inside `selector` (the card list),
 * each as `tag.class`, once the page has drawn two frames. Empty when the list
 * paints in the page's layer; a layer the cards share (squashed, named for the
 * first card) shows as that card.
 */
export async function layersInside(page: Page, selector: string): Promise<string[]> {
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('DOM.getDocument', { depth: -1 });
		let layers: { backendNodeId?: number }[] = [];
		const changed = (e: { layers?: { backendNodeId?: number }[] }) => {
			if (e.layers) layers = e.layers;
		};
		cdp.on('LayerTree.layerTreeDidChange', changed);
		await cdp.send('LayerTree.enable');
		// Two frames, so the tree reported is the one for the page as it stands.
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
		const { root } = (await cdp.send('DOM.getDocument', { depth: 0 })) as { root: { nodeId: number } };
		const { nodeId } = (await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })) as { nodeId: number };
		if (!nodeId) throw new Error(`layersInside: nothing matches ${selector}`);
		const { node: list } = (await cdp.send('DOM.describeNode', { nodeId })) as { node: { backendNodeId: number } };
		const { object: listObj } = (await cdp.send('DOM.resolveNode', { backendNodeId: list.backendNodeId })) as { object: { objectId: string } };
		const inside: string[] = [];
		for (const l of layers) {
			if (!l.backendNodeId) continue;
			// A pseudo-element’s layer (a chart’s ::before) has no node of its own to resolve: skipped.
			const object = await cdp
				.send('DOM.resolveNode', { backendNodeId: l.backendNodeId })
				.then((r) => (r as { object: { objectId?: string } }).object)
				.catch(() => null);
			if (!object?.objectId) continue;
			const { result } = (await cdp.send('Runtime.callFunctionOn', {
				objectId: listObj.objectId,
				functionDeclaration: 'function (n) { const el = n.nodeType === 1 ? n : n.parentElement; return this.contains(el) && el !== this ? `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\\s+/).join(".")}` : null; }',
				arguments: [{ objectId: object.objectId }],
				returnByValue: true
			})) as { result: { value: string | null } };
			if (result.value) inside.push(result.value);
		}
		await cdp.send('LayerTree.disable');
		return inside;
	} finally {
		await cdp.detach();
	}
}
