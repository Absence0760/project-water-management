// Non-text contrast (WCAG 2.2 SC 1.4.11), which axe doesn't check: a form
// control's boundary and a chart's marks against the ground they sit on, 3:1.
// axe's color-contrast rule reads text only, so the flow unit picker's 1.3:1
// outline and the reserve chart's 1.9:1 faded bars passed every scan in both
// themes (issue #521, round 4's dark-mode audit). Reusable from any spec:
// call it in light and in dark (`test.use({ colorScheme })` or
// `page.emulateMedia({ colorScheme })`) on a screen that has loaded.
//
// Canvas charts (uPlot, charts/LineChart.svelte) have no marks in the DOM
// (issue #521, round 6). A series is judged by the colour uPlot was configured
// with: uPlot paints each legend swatch from the series' own resolved stroke
// (or fill), alpha included, so the swatch is the config, read where uPlot
// put it. Sampling the canvas can't judge a series: one line drawn over
// another hides it (Supplied over Abstraction demand, when they agree, left
// the demand's strongest pixels at 5 %; run B over run A, 75 %), and
// anti-aliasing leaves a thin line no pixel at full strength at 1×. What the
// chart draws itself, outside uPlot's config, is measured from the pixels:
// the lane strips (keyed under the plot; a strip drawn fainter than its key fails), and
// the axis labels (the `--chart-axis` the chart read, text, so 4.5:1). Each
// is looked for in the canvas, and the most opaque it is drawn is what is
// compared. Run canvas checks at `deviceScaleFactor: 2`. Gridlines and ticks
// are decoration (as in SVG charts); the tints LineChart draws under the lines
// (`shade`, a `band`) are keyed in words beside a full-strength edge and are
// not checked (docs/design/ui-playbook.md § 3).
import { expect, type Page } from '@playwright/test';

export interface ContrastOptions {
	/** Check only inside this element (a CSS selector); default the whole page. */
	within?: string;
	/** The chart marks to check (a CSS selector); default every drawn shape but a `<line>` (gridlines and ticks) in an SVG chart (`svg[role="img"]`). */
	marks?: string;
	/** Skip what matches this selector (a decoration, not a control or a mark). Gridlines are
	 * decoration (WCAG 1.4.11 needs only what is required to read the chart); pass them here when a chart
	 * draws them as anything but a `<line>`. */
	except?: string;
	/** The least ratio (default 3, WCAG 1.4.11). */
	min?: number;
	/** Check uPlot canvas charts too (default true). */
	canvas?: boolean;
}

export interface ContrastFailure {
	/** "control", "mark", or for a canvas chart "series", "swatch", "lane" or "axis". */
	kind: string;
	/** The element, as a short selector-like name. */
	what: string;
	/** Its best ratio against the ground: the larger of its edge's and its fill's. */
	ratio: number;
	/** The colours compared, for the failure message. */
	detail: string;
}

/**
 * Every visible, enabled text field, select and textarea whose boundary (its
 * border, or its own fill when that stands off the ground) is under `min`
 * against the composited background around it; and every chart mark whose
 * fill and outline (each with its opacity) are both under `min` against the
 * chart's ground. A mark too small to see (under 2 px both ways) or drawn in
 * no colour is skipped, as is anything disabled (WCAG exempts it).
 */
export async function nonTextContrast(page: Page, options: ContrastOptions = {}): Promise<ContrastFailure[]> {
	return page.evaluate(({ within, marks, except, min, canvas }) => {
		type RGBA = [number, number, number, number];
		const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
		/** Any CSS colour (rgb(), color(srgb …), oklch, a name) as 0–255 sRGB plus alpha, via a canvas. */
		const parse = (css: string): RGBA => {
			if (!css || css === 'none' || css === 'transparent') return [0, 0, 0, 0];
			// reset() clears the pixel and puts fillStyle back to its default black, so a colour the canvas
			// can't parse (the assignment is ignored) reads as black, not as the previous colour.
			probe.reset();
			probe.fillStyle = css;
			probe.fillRect(0, 0, 1, 1);
			const d = probe.getImageData(0, 0, 1, 1).data;
			return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
		};
		const over = (top: RGBA, under: RGBA): RGBA => {
			const a = top[3] + under[3] * (1 - top[3]);
			if (a === 0) return [0, 0, 0, 0];
			const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
			return [mix(0), mix(1), mix(2), a];
		};
		const lum = ([r, g, b]: RGBA) => {
			const ch = (v: number) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
		};
		const ratio = (a: RGBA, b: RGBA) => {
			const x = lum(a);
			const y = lum(b);
			return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
		};
		const hex = ([r, g, b]: RGBA) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
		/** The colour behind an element: its ancestors' backgrounds, composited from the first opaque one up. */
		const ground = (el: Element): RGBA => {
			const layers: RGBA[] = [];
			for (let p: Element | null = el.parentElement; p; p = p.parentElement) {
				const c = parse(getComputedStyle(p).backgroundColor);
				if (c[3] > 0) layers.push(c);
				if (c[3] >= 1) break;
			}
			// Nothing opaque: the canvas, which follows the colour scheme.
			let acc: RGBA = matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [18, 18, 18, 1] : [255, 255, 255, 1];
			for (const layer of layers.reverse()) acc = over(layer, acc);
			return acc;
		};
		const name = (el: Element) => {
			const label = el.getAttribute('aria-label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : null);
			const c = el.getAttribute('class')?.trim();
			const cls = c ? `.${c.split(/\s+/).slice(0, 2).join('.')}` : '';
			return `${el.tagName.toLowerCase()}${cls}${label ? ` "${label.slice(0, 60)}"` : ''}`;
		};
		const scope = within ? [...document.querySelectorAll(within)] : [document.body];
		const all = (sel: string) => scope.flatMap((s) => [...s.querySelectorAll(sel)]).filter((el) => !(except && el.matches(except)));
		const failures: { kind: string; what: string; ratio: number; detail: string }[] = [];

		const controls = all('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]):not([type="color"]):not([type="file"]):not([type="submit"]):not([type="button"]), select, textarea');
		for (const el of controls) {
			if ((el as HTMLInputElement).disabled || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) continue;
			const cs = getComputedStyle(el);
			const g = ground(el);
			const fill = over(parse(cs.backgroundColor), g);
			const fillRatio = ratio(fill, g);
			const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).filter((s) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0 && cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none');
			// The weakest drawn side counts (a field with only a bottom rule is judged by that rule).
			const edgeRatio = sides.length ? Math.min(...sides.map((s) => ratio(over(parse(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)), g), g))) : 1;
			const best = Math.max(edgeRatio, fillRatio);
			if (best < min) failures.push({ kind: 'control', what: name(el), ratio: Math.round(best * 100) / 100, detail: `edge ${sides.length ? cs.borderTopColor : 'none'} ${edgeRatio.toFixed(2)}:1, fill ${hex(fill)} ${fillRatio.toFixed(2)}:1, on ${hex(g)}` });
		}

		const shapes = all(marks ?? 'svg[role="img"] :is(rect, circle, ellipse, polygon, path, polyline)');
		for (const el of shapes) {
			if (!el.checkVisibility({ visibilityProperty: true })) continue;
			const box = (el as SVGGraphicsElement).getBBox?.();
			const cs = getComputedStyle(el);
			const strokeW = parseFloat(cs.strokeWidth) || 0;
			const drawn = cs.stroke !== 'none' && strokeW > 0;
			if (!box || (box.width < 2 && box.height < 2 && !drawn)) continue;
			const svg = el.closest('svg')!;
			const g = ground(svg);
			const svgOwn = parse(getComputedStyle(svg).backgroundColor);
			const base = svgOwn[3] > 0 ? over(svgOwn, g) : g;
			// The opacity of the mark and of every group around it, up to the svg.
			let alpha = 1;
			for (let p: Element | null = el; p && p !== svg; p = p.parentElement) alpha *= parseFloat(getComputedStyle(p).opacity);
			const paint = (css: string, own: string): RGBA => {
				const c = parse(css);
				return [c[0], c[1], c[2], c[3] * (parseFloat(own) || 0) * alpha];
			};
			const hasFill = cs.fill !== 'none' && box.width >= 2 && box.height >= 2 && el.tagName !== 'line' && el.tagName !== 'polyline';
			const fill = hasFill ? over(paint(cs.fill, cs.fillOpacity), base) : base;
			const stroke = drawn ? over(paint(cs.stroke, cs.strokeOpacity), base) : base;
			if (!hasFill && !drawn) continue;
			const best = Math.max(ratio(fill, base), ratio(stroke, base));
			// Painted in the ground's own colour: a backdrop or a halo, not a mark.
			if (best < 1.02) continue;
			if (best < min) failures.push({ kind: 'mark', what: name(el), ratio: Math.round(best * 100) / 100, detail: `fill ${hasFill ? hex(fill) : 'none'}, stroke ${drawn ? hex(stroke) : 'none'}, on ${hex(base)}` });
		}

		// Canvas charts: every uPlot chart in scope that is on screen.
		const charts = canvas ? scope.flatMap((s) => [...s.querySelectorAll('.uplot')]).filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) : [];
		for (const root of charts) {
			const cv = root.querySelector('canvas');
			if (!cv || cv.width < 2 || cv.height < 2) continue;
			const figure = root.closest('figure') ?? root.parentElement!;
			const title = figure.querySelector('.ttl')?.textContent?.trim() ?? root.parentElement?.getAttribute('aria-label')?.slice(0, 40) ?? 'chart';
			const px = cv.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data;
			/** The highest alpha (0–1, in 1/20 steps) at which at least three pixels are drawn in `c`'s colour; 0 if none is. */
			const drawnAlpha = (c: RGBA): number => {
				const bins = new Array<number>(21).fill(0);
				for (let i = 0; i < px.length; i += 4) {
					const a = px[i + 3]!;
					if (a < 13) continue;
					// getImageData un-premultiplies, which rounds harder the fainter the pixel.
					const tol = a > 200 ? 6 : 14;
					if (Math.abs(px[i]! - c[0]) <= tol && Math.abs(px[i + 1]! - c[1]) <= tol && Math.abs(px[i + 2]! - c[2]) <= tol) bins[Math.round((a / 255) * 20)]!++;
				}
				for (let b = 20; b > 0; b--) if (bins[b]! >= 3) return b / 20;
				return 0;
			};
			const g = ground(cv);
			/** One colour the chart draws itself: found on the canvas, and at `least` against the plot's ground at the strength it is drawn. */
			const drawn = (kind: string, what: string, css: string, least: number) => {
				const c = parse(css);
				if (c[3] === 0) {
					failures.push({ kind, what, ratio: 0, detail: `drawn in no colour (${css || 'none'})` });
					return;
				}
				const a = drawnAlpha(c);
				if (a === 0) {
					failures.push({ kind, what, ratio: 0, detail: `${hex(c)} is not on the canvas` });
					return;
				}
				// Anti-aliasing tops a line out a little under full strength; past 85 % it is drawn whole.
				const shown = over([c[0], c[1], c[2], c[3] * (a >= 0.85 ? 1 : a)], g);
				const r = ratio(shown, g);
				if (r < least) failures.push({ kind, what, ratio: Math.round(r * 100) / 100, detail: `${hex(c)} drawn at ${Math.round((a >= 0.85 ? 1 : a) * 100)} % (${hex(shown)}) on ${hex(g)}` });
			};

			// Series: uPlot paints each legend swatch from the series' resolved stroke (or, with no stroke, its fill).
			// A live legend (LineChart's) leads with the x row; a switched-off series is not drawn (inactive, like a disabled control).
			const rows = [...figure.querySelectorAll('.u-legend tr.u-series')].filter((r, i) => i > 0 && r.querySelector('.u-marker') && !r.classList.contains('u-off'));
			for (const row of rows) {
				const marker = row.querySelector('.u-marker')!;
				const label = `${title}: ${row.querySelector('.u-label')?.textContent?.trim() ?? '?'}`;
				const ms = getComputedStyle(marker);
				const edged = parseFloat(ms.borderTopWidth) > 0 && ms.borderTopStyle !== 'none' && parse(ms.borderTopColor)[3] > 0;
				const c = parse(edged ? ms.borderTopColor : ms.backgroundColor);
				if (c[3] === 0) {
					failures.push({ kind: 'swatch', what: label, ratio: 0, detail: 'the legend swatch is drawn in no colour' });
					continue;
				}
				const line = over(c, g);
				const lr = ratio(line, g);
				if (lr < min) failures.push({ kind: 'series', what: label, ratio: Math.round(lr * 100) / 100, detail: `${hex(line)} on ${hex(g)}` });
				// The swatch against the legend it sits in (a legend on another ground).
				const sg = ground(marker);
				if (sg.some((v, i) => Math.abs(v - g[i]!) > 1)) {
					const sr = ratio(over(c, sg), sg);
					if (sr < min) failures.push({ kind: 'swatch', what: label, ratio: Math.round(sr * 100) / 100, detail: `${hex(over(c, sg))} on ${hex(sg)}` });
				}
			}
			// The printable chart's plain key.
			for (const key of figure.querySelectorAll('.key > span')) {
				const c = parse(getComputedStyle(key.querySelector('i')!).borderTopColor);
				const r = ratio(over(c, g), g);
				if (r < min) failures.push({ kind: 'series', what: `${title}: ${key.textContent?.trim()}`, ratio: Math.round(r * 100) / 100, detail: `${hex(over(c, g))} on ${hex(g)}` });
			}
			// Lanes: thin strips along the plot's foot, keyed under it.
			for (const li of [...figure.querySelectorAll('.lane-key li')].filter((el) => !(except && el.matches(except)))) drawn('lane', `${title}: ${li.textContent?.trim().slice(0, 60)}`, getComputedStyle(li.querySelector('i')!).backgroundColor, min);
			// The axis labels: text on the canvas, so 4.5:1 (axe can't read it).
			const axis = getComputedStyle(root).getPropertyValue('--chart-axis').trim();
			if (axis) drawn('axis', `${title}: axis labels`, axis, Math.max(min, 4.5));
		}
		return failures;
	}, { within: options.within ?? null, marks: options.marks ?? null, except: options.except ?? null, min: options.min ?? 3, canvas: options.canvas ?? true });
}

/** Fails with every control and chart mark under 3:1 (or `min`), named, with its colours. */
export async function expectNonTextContrast(page: Page, options: ContrastOptions = {}) {
	expect(await nonTextContrast(page, options)).toEqual([]);
}
