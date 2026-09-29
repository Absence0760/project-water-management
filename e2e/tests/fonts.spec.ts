import { expect, test } from '../support/fixtures.ts';

// The e2e browser lays text out in the pinned DejaVu fonts (e2e/fonts/fonts.conf,
// playwright.config.ts), on a laptop as in CI. Before the pin the body text was
// Noto Sans on a Fedora laptop and DejaVu Sans on the Ubuntu runner, and layout
// checks passed locally and failed in CI (issue #162). This fails if the pin
// stops reaching the browser: Chromium reports the platform font it drew with.
test('the browser draws body and monospace text in the pinned DejaVu fonts', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
	const fontsOf = async (selector: string) => {
		const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
		expect(nodeId, selector).toBeGreaterThan(0);
		const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
		return fonts.map((f) => f.familyName);
	};
	// A label is body text (system-ui); the display face (Outfit) is a web font and not pinned.
	expect(await fontsOf('label')).toEqual(['DejaVu Sans']);
	await page.evaluate(() => {
		const code = document.createElement('code');
		code.id = 'font-probe';
		code.textContent = 'x = 1';
		document.body.append(code);
	});
	expect(await fontsOf('#font-probe')).toEqual(['DejaVu Sans Mono']);
});
