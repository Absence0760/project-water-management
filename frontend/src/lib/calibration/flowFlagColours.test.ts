// The flow-quality strips' colours, computed (issue #557 follow-up, PR #570).
// Each class has its own strip, in a fixed order the key repeats, so a class
// reads by its place; the colours must still stay apart for colour-blind
// readers wherever two strips can sit side by side, light and dark. Colour
// vision deficiency is simulated with Machado, Oliveira & Fernandes (2009) at
// full severity (protanopia, deuteranopia, tritanopia), on linear sRGB; the
// difference is CIEDE2000 (ΔE00). A strip is a non-text mark, so it holds 3:1
// against the ground (WCAG 1.4.11). docs/design/ui-playbook.md § 3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FlowDayFlag } from '@water-management/engine';
import { LANE_COLOR, LANE_FLAGS, LANE_DOUBLED } from './flowFlags';

const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
const THEMES = { light: css.slice(0, darkAt), dark: css.slice(darkAt) } as const;
type Theme = keyof typeof THEMES;
/** A token's hex value in a theme (the dark block lists every colour token it changes; the rest keep light's). */
function hex(theme: Theme, token: string): string {
	const find = (src: string) => src.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})\\b`, 'i'))?.[1]?.toLowerCase();
	const v = find(THEMES[theme]) ?? find(THEMES.light);
	if (!v) throw new Error(`${token} has no hex value in app.css`);
	return v;
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linRgb = (h: string) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];

type Vision = 'normal' | 'protan' | 'deutan' | 'tritan';
const VISIONS: readonly Vision[] = ['normal', 'protan', 'deutan', 'tritan'];
/** Machado et al. 2009, severity 1.0. */
const MACHADO: Record<Exclude<Vision, 'normal'>, number[][]> = {
	protan: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998]
	],
	deutan: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881]
	],
	tritan: [
		[1.255528, -0.076749, -0.178779],
		[-0.078411, 0.930809, 0.147602],
		[0.004733, 0.691367, 0.3039]
	]
};
function seen(h: string, v: Vision): [number, number, number] {
	const c = linRgb(h);
	if (v === 'normal') return c;
	return MACHADO[v].map((row) => Math.min(1, Math.max(0, row[0]! * c[0] + row[1]! * c[1] + row[2]! * c[2]))) as [number, number, number];
}
function lab([r, g, b]: [number, number, number]): [number, number, number] {
	const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
	const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
	const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const rad = (d: number) => (d * Math.PI) / 180;
/** CIEDE2000 (Sharma, Wu & Dalal 2005). */
function de00([L1, a1, b1]: [number, number, number], [L2, a2, b2]: [number, number, number]): number {
	const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
	const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
	const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
	const [C1, C2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
	const hue = (b: number, a: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
	const [h1, h2] = [hue(b1, a1p), hue(b2, a2p)];
	let dh = C1 * C2 === 0 ? 0 : h2 - h1;
	if (dh > 180) dh -= 360;
	else if (dh < -180) dh += 360;
	const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(rad(dh / 2));
	const Lb = (L1 + L2) / 2;
	const Cbp = (C1 + C2) / 2;
	const hb = C1 * C2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
	const T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb)) + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
	const Rt = -Math.sin(rad(60 * Math.exp(-(((hb - 275) / 25) ** 2)))) * 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
	const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
	const Sc = 1 + 0.045 * Cbp;
	const Sh = 1 + 0.015 * Cbp * T;
	const [l, c, h] = [(L2 - L1) / Sl, (C2 - C1) / Sc, dH / Sh];
	return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}
/** The smallest ΔE00 between two colours over normal vision and the three deficiencies. */
const worstDe = (a: string, b: string) => Math.min(...VISIONS.map((v) => de00(lab(seen(a, v)), lab(seen(b, v)))));
const lum = (h: string) => {
	const [r, g, b] = linRgb(h);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x! + 0.05) / (y! + 0.05);
};

const colour = (theme: Theme, flag: FlowDayFlag) => hex(theme, LANE_COLOR[flag]);
/** Below this ΔE00, under any of the four visions, two strips side by side read as one colour. */
const APART = 10;

/**
 * Pairs of plain (not doubled) strips already closer than APART when #557 added the
 * period strip (their own place and the key's order tell them apart): listed so
 * a new pair can't join them silently. Worst ΔE00 when measured, PR #570.
 */
const KNOWN_CLOSE: Record<Theme, Record<string, number>> = {
	light: { 'belowRating|humanUse': 4.8, 'suspect|humanUse': 8.2 },
	dark: { 'aboveRating|suspect': 7.6, 'aboveRating|humanUse': 5.7, 'belowRating|infilled': 8.4 }
};

describe('the flow-quality strips’ colours (issue #557, PR #570)', () => {
	const themes: readonly Theme[] = ['light', 'dark'];

	it('reads the colours from app.css: the methods give their published values', () => {
		// Sharma et al. 2005, Table 1, pair 1.
		expect(de00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
		// The palette as app.css has it (a token moved means this file's numbers need measuring again).
		expect(hex('light', '--series-7')).toBe('#008300');
		expect(hex('dark', '--series-9')).toBe('#e66767');
	});

	for (const theme of themes) {
		it(`${theme}: the period strip stays apart from the strips always beside it (above-range above, below-range below) for every reader`, () => {
			const p = colour(theme, 'periodHigh');
			for (const n of ['aboveRating', 'belowRating'] as const) expect(worstDe(p, colour(theme, n)), `periodHigh vs ${n}`).toBeGreaterThanOrEqual(APART);
		});

		it(`${theme}: the period strip is at least 3:1 on the card and the page (WCAG 1.4.11)`, () => {
			const p = colour(theme, 'periodHigh');
			for (const ground of ['--surface', '--bg']) expect(contrast(p, hex(theme, ground)), ground).toBeGreaterThanOrEqual(3);
		});

		it(`${theme}: two strips that can sit side by side are ΔE00 ≥ ${APART} for every reader, or one is a double line, or the pair predates #557`, () => {
			const close: Record<string, number> = {};
			for (let i = 0; i < LANE_FLAGS.length; i++)
				for (let j = i + 1; j < LANE_FLAGS.length; j++) {
					const [a, b] = [LANE_FLAGS[i]!, LANE_FLAGS[j]!];
					const d = worstDe(colour(theme, a), colour(theme, b));
					if (d < APART && LANE_DOUBLED.has(a) === LANE_DOUBLED.has(b)) close[`${a}|${b}`] = Math.round(d * 10) / 10;
				}
			expect(close).toEqual(KNOWN_CLOSE[theme]);
		});
	}

	it('draws the period strip as a double line: in the dark theme a protanope sees its green ΔE00 7.9 from the suspect strip’s amber, which it sits beside when no day is below the gauged range', () => {
		expect(worstDe(colour('dark', 'periodHigh'), colour('dark', 'suspect'))).toBeLessThan(APART);
		expect([...LANE_DOUBLED]).toEqual(['periodHigh']);
	});
});
