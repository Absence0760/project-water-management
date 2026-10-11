// Non-text contrast (WCAG 2.2 SC 1.4.11), which axe doesn't check: a form
// control's boundary and a chart's marks against the ground they sit on, 3:1.
// axe's color-contrast rule reads text only, so the flow unit picker's 1.3:1
// outline and the reserve chart's 1.9:1 faded bars passed every scan in both
// themes (issue #521, round 4's dark-mode audit). Reusable from any spec:
// call it in light and in dark (`test.use({ colorScheme })` or
// `page.emulateMedia({ colorScheme })`) on a screen that has loaded.
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
}

export interface ContrastFailure {
	/** "control" or "mark". */
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
	return page.evaluate(({ within, marks, except, min }) => {
		type RGBA = [number, number, number, number];
		const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
		/** Any CSS colour (rgb(), color(srgb …), oklch, a name) as 0–255 sRGB plus alpha, via a canvas. */
		const parse = (css: string): RGBA => {
			if (!css || css === 'none' || css === 'transparent') return [0, 0, 0, 0];
			probe.clearRect(0, 0, 1, 1);
			probe.fillStyle = '#000';
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
		return failures;
	}, { within: options.within ?? null, marks: options.marks ?? null, except: options.except ?? null, min: options.min ?? 3 });
}

/** Fails with every control and chart mark under 3:1 (or `min`), named, with its colours. */
export async function expectNonTextContrast(page: Page, options: ContrastOptions = {}) {
	expect(await nonTextContrast(page, options)).toEqual([]);
}
