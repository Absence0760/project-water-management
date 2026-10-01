// Label checks for the app's SVG diagrams (the Network schematic, the help
// diagrams): no two labels overlap, no label runs across a line or a symbol,
// no label is cut by a box's edge, and the smallest text is drawn big enough
// to read. Measured in the browser, on screen, after layout
// (docs/design/ui-playbook.md § 3, "Labels on diagrams").
import { expect, type Locator, type Page } from '@playwright/test';
import { mapFitSettled, type MapFitReading } from './mapFit.ts';

export interface LabelReport {
	/** Labels found (a group of lines that belong together counts once). */
	labels: number;
	/** One line per problem, naming the label and what it runs into. */
	problems: string[];
	/** The smallest rendered text height (px) of any label: the font size times the drawing's scale. */
	smallestPx: number;
}

export interface LabelCheckOptions {
	/**
	 * CSS selector for a label's group: lines inside one such element are one
	 * label (the schematic's `g.node`: a name and its figure). Default: each
	 * text element is its own label, except lines that sit in the same box.
	 */
	group?: string;
	/** Lines a label must not cross (default: river, transfer and wire paths, and `line`s). */
	lines?: string;
	/** Symbols a label must not cover (default: node symbols). A label's own group's symbols are exempt. */
	symbols?: string;
	/** Boxes a label must sit wholly inside or wholly outside of. */
	boxes?: string;
	/** Pixels of overlap tolerated (anti-aliasing, a descender's tail). */
	slack?: number;
}

/**
 * Checks every label in one `<svg>` (the locator). The label's box is its
 * text's bounding box on screen, which Chromium takes from the font's
 * ascent and descent, so it covers accents and descenders.
 */
export async function checkDiagramLabels(svg: Locator, opts: LabelCheckOptions = {}): Promise<LabelReport> {
	return svg.evaluate(
		(root, o) => {
			type R = { x0: number; y0: number; x1: number; y1: number };
			const slack = o.slack;
			const rectOf = (r: DOMRect): R => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
			const overlap = (a: R, b: R) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > slack && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > slack;
			const inside = (p: { x: number; y: number }, r: R) => p.x > r.x0 + slack && p.x < r.x1 - slack && p.y > r.y0 + slack && p.y < r.y1 - slack;
			const shown = (el: Element) => {
				const s = getComputedStyle(el);
				return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
			};
			const texts = [...root.querySelectorAll('text')].filter((t) => (t.textContent ?? '').trim() && shown(t));
			const boxes = o.boxes ? [...root.querySelectorAll(o.boxes)].map((b) => rectOf(b.getBoundingClientRect())) : [];
			// Lines in one box (a title and its subtitle) form one label.
			const keyOf = (t: SVGTextElement): Element | number => {
				if (o.group) {
					const g = t.closest(o.group);
					if (g) return g;
				}
				const r = rectOf(t.getBoundingClientRect());
				const c = { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
				const i = boxes.findIndex((b) => c.x > b.x0 && c.x < b.x1 && c.y > b.y0 && c.y < b.y1);
				return i >= 0 ? i : t;
			};
			const groups = new Map<Element | number, SVGTextElement[]>();
			for (const t of texts) {
				const k = keyOf(t);
				groups.set(k, [...(groups.get(k) ?? []), t]);
			}
			const name = (ts: SVGTextElement[]) => `"${ts.map((t) => t.textContent!.trim()).join(' / ')}"`;
			const labels = [...groups.entries()].map(([key, ts]) => ({ key, ts, rects: ts.map((t) => rectOf(t.getBoundingClientRect())) }));
			const problems: string[] = [];

			// Label against label.
			for (let i = 0; i < labels.length; i++)
				for (let j = i + 1; j < labels.length; j++)
					if (labels[i]!.rects.some((a) => labels[j]!.rects.some((b) => overlap(a, b))))
						problems.push(`${name(labels[i]!.ts)} overlaps ${name(labels[j]!.ts)}`);

			// Label against a line: sample the line every 2 px on screen.
			const lines = [...root.querySelectorAll<SVGGeometryElement>(o.lines)].filter(shown);
			for (const line of lines) {
				const m = line.getScreenCTM();
				if (!m) continue;
				const len = line.getTotalLength();
				const scale = Math.hypot(m.a, m.b) || 1;
				const steps = Math.max(2, Math.ceil((len * scale) / 2));
				const pts: { x: number; y: number }[] = [];
				for (let s = 0; s <= steps; s++) {
					const p = line.getPointAtLength((len * s) / steps);
					pts.push({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
				}
				for (const l of labels)
					if (l.rects.some((r) => pts.some((p) => inside(p, r))))
						problems.push(`${name(l.ts)} is crossed by a line (${line.getAttribute('class') ?? line.tagName})`);
			}

			// Label against a symbol (not its own).
			const symbols = [...root.querySelectorAll(o.symbols)].filter(shown);
			for (const s of symbols) {
				const sr = rectOf(s.getBoundingClientRect());
				for (const l of labels) {
					if (l.key instanceof Element && l.key.contains(s)) continue;
					if (l.rects.some((r) => overlap(r, sr))) problems.push(`${name(l.ts)} covers a symbol (${s.getAttribute('class') ?? s.tagName})`);
				}
			}

			// Label against a box edge: wholly in or wholly out.
			for (const b of boxes)
				for (const l of labels)
					for (const r of l.rects) {
						const isIn = r.x0 >= b.x0 - slack && r.x1 <= b.x1 + slack && r.y0 >= b.y0 - slack && r.y1 <= b.y1 + slack;
						if (!isIn && overlap(r, b)) problems.push(`${name(l.ts)} runs across a box's edge`);
					}

			// The smallest text, as drawn: font size × the drawing's scale on screen.
			let smallestPx = Infinity;
			for (const t of texts) {
				const m = t.getScreenCTM();
				const px = parseFloat(getComputedStyle(t).fontSize) * (m ? Math.hypot(m.a, m.b) : 1);
				smallestPx = Math.min(smallestPx, px);
			}
			return { labels: labels.length, problems: [...new Set(problems)], smallestPx };
		},
		{
			group: opts.group ?? '',
			lines: opts.lines ?? 'path.river, path.transfer, path.wire, line',
			symbols: opts.symbols ?? '.farm, .gauge, .user, .node, .node-open, .outlet',
			boxes: opts.boxes ?? '',
			slack: opts.slack ?? 1
		}
	);
}

/**
 * Waits until the Network map's drawing is laid out for the window as it is
 * now (support/mapFit.ts): after `setViewportSize`, and before measuring
 * anything on the map. The drawing is re-laid out a frame or more after the
 * resize, so a check straight after it can read the old width's drawing, or
 * straddle the re-layout between two reads (issue #138).
 */
export async function waitForMapFit(page: Page) {
	const scroller = page.locator('.map-card .scroller');
	await expect
		.poll(() =>
			scroller.evaluate((el): MapFitReading => {
				const layout = el.closest('.map-layout');
				return {
					fit: el.getAttribute('data-fit'),
					width: el.clientWidth,
					height: el.clientHeight,
					wide: matchMedia('(min-width: 900px)').matches,
					mapTop: layout instanceof HTMLElement ? layout.style.getPropertyValue('--map-top') || null : null,
					top: layout ? layout.getBoundingClientRect().top + window.scrollY : null,
					busy: el.closest('.map-card')?.getAttribute('aria-busy') === 'true'
				};
			}).then(mapFitSettled),
			{ message: 'the map is laid out for the current window' }
		)
		.toBe(true);
}
