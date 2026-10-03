// The Crops & demand page's pictures (issue #17, option A · A3): a row per
// crop in the compact crop list with its factor sparkline, one stacked bar
// per unit, the header's one line, and the crop colours the list, the demand
// chart and the unit bars share. Pure, so the page stays markup and the
// numbers are unit-tested.
import { joinNames } from './demand';

type CropLike = { id: string; name: string; cropFactor: readonly number[] };
type AreaLike = { nodeId: string; cropId: string; areaM2: number };

/**
 * Crop colours: theme tokens (app.css, a light and a dark step each), in the
 * order that keeps neighbouring series apart for colour-blind readers (every
 * adjacent pair validated in both themes; the chart and the unit bars stack
 * crops in this order). `--series-4` is the line charts' own violet, so the
 * crop set skips it. Nine named colours, then "Other".
 */
export const CROP_PALETTE = [
	'var(--series-1)',
	'var(--series-2)',
	'var(--series-3)',
	'var(--series-5)',
	'var(--series-6)',
	'var(--series-7)',
	'var(--series-8)',
	'var(--series-9)',
	'var(--series-10)'
];
/** The "Other" group's colour: neutral, never one of the named crops' hues. */
export const OTHER_COLOUR = 'var(--text-muted)';

/** Planted area per crop id on the units shown (`nodeIds`), m². */
export function cropAreaTotals(areas: readonly AreaLike[], nodeIds: readonly string[]): Map<string, number> {
	const nodes = new Set(nodeIds);
	const out = new Map<string, number>();
	for (const a of areas) if (nodes.has(a.nodeId)) out.set(a.cropId, (out.get(a.cropId) ?? 0) + a.areaM2);
	return out;
}

/**
 * The crops by planted area, largest first; equal areas (unplanted crops
 * included) keep crop order, so the ranking is stable. The list's order, the
 * colour ranking and the stacking order of the chart and the bars.
 */
export function rankCrops<C extends { id: string }>(crops: readonly C[], areaM2: ReadonlyMap<string, number>): C[] {
	return crops
		.map((c, i) => ({ c, i, a: areaM2.get(c.id) ?? 0 }))
		.sort((x, y) => y.a - x.a || x.i - y.i)
		.map((x) => x.c);
}

export interface CropColouring {
	/** A colour per crop id: a palette colour for a named crop, OTHER_COLOUR for one in "Other". */
	colours: Map<string, string>;
	/** Crops with their own colour, in rank order. */
	named: string[];
	/** Crops grouped as "Other" (past the palette), in rank order; empty when every crop has a colour. */
	other: string[];
}

/**
 * Colours for crops already ranked (`rankCrops`): each of the first
 * `palette.length` takes the next palette colour, so no two named crops share
 * one; the rest are grouped as "Other". Ranked by planted area, not demand:
 * area is known before A-pan is set, it is what the list and the unit bars
 * show, and it doesn't move when a month's evaporation is edited.
 */
export function cropColouring(ranked: readonly { id: string }[], palette: readonly string[] = CROP_PALETTE): CropColouring {
	const colours = new Map<string, string>();
	const named: string[] = [];
	const other: string[] = [];
	ranked.forEach((c, i) => {
		if (i < palette.length) {
			colours.set(c.id, palette[i]!);
			named.push(c.id);
		} else {
			colours.set(c.id, OTHER_COLOUR);
			other.push(c.id);
		}
	});
	return { colours, named, other };
}

/** Index of the largest value (the first on a tie), or -1 when every value is 0 or less. */
function peakIndex(values: readonly number[]): number {
	let best = -1;
	values.forEach((v, i) => {
		if (v > 0 && (best < 0 || v > values[best]!)) best = i;
	});
	return best;
}

export interface CropRow {
	id: string;
	name: string;
	/** Planted area on the units shown, m². */
	areaM2: number;
	/** Water-year month index of the highest gross need (A-pan × factor; the factor alone while A-pan is unset), or -1. */
	peak: number;
	/** Its 12 crop factors, Oct → Sep (0 for a missing or negative one): the row's sparkline. */
	factors: number[];
	/** The sparkline's top: 1.0, or the highest factor when one is above it. */
	top: number;
	/** Months with a factor above 1.0 (the high-factor hint, `highCropFactors`). */
	high: string[];
}

/** The crop list's sparkline caption, its column header (charts/Sparkline.svelte). */
export const FACTOR_CAPTION = 'Crop factor by month, Oct–Sep';

/** One row per crop, in the order given (the page passes them ranked, `rankCrops`). `areaM2`: `cropAreaTotals`. */
export function cropRows(
	crops: readonly CropLike[],
	areaM2: ReadonlyMap<string, number>,
	apanMm: readonly number[],
	months: readonly string[]
): CropRow[] {
	const apanSet = apanMm.some((v) => v > 0);
	return crops.map((c) => {
		const f = Array.from({ length: 12 }, (_, i) => Math.max(0, c.cropFactor[i] || 0));
		const need = apanSet ? f.map((v, i) => v * (apanMm[i] || 0)) : f;
		return {
			id: c.id,
			name: c.name || '(unnamed)',
			areaM2: areaM2.get(c.id) ?? 0,
			peak: peakIndex(need),
			factors: f,
			top: Math.max(1, ...f),
			high: f.flatMap((v, i) => (v > 1 ? [months[i] ?? String(i + 1)] : []))
		};
	});
}

/** The list's "Other" row: "Other: Maize, Lucerne and Wheat". */
export function otherLabel(names: readonly string[]): string {
	return `Other: ${joinNames(names)}`;
}


export interface FarmBar {
	id: string;
	name: string;
	/** Total planted area, m². */
	totalM2: number;
	/** Each crop's share of the widest unit's total, in the crops' order (ranked); crops not planted here are left out. */
	parts: { cropId: string; name: string; areaM2: number; pct: number }[];
}

/**
 * One stacked bar per unit with something planted, largest total first
 * (equal totals keep the units' order); the widest unit's bar fills the
 * track. Parts follow `crops`' order (the page passes them ranked, so every
 * bar stacks like the chart). Units with nothing planted are left out (the
 * page names them in the no-planted-area note).
 */
export function farmBars(farms: readonly { id: string; name: string }[], crops: readonly { id: string; name: string }[], areas: readonly AreaLike[]): FarmBar[] {
	const rows = farms.map((f) => {
		const parts = crops.flatMap((c) => {
			const areaM2 = areas.filter((a) => a.nodeId === f.id && a.cropId === c.id).reduce((s, a) => s + a.areaM2, 0);
			return areaM2 > 0 ? [{ cropId: c.id, name: c.name || '(unnamed)', areaM2, pct: 0 }] : [];
		});
		return { id: f.id, name: f.name || '(unnamed)', totalM2: parts.reduce((s, p) => s + p.areaM2, 0), parts };
	});
	const planted = rows.filter((r) => r.totalM2 > 0).sort((a, b) => b.totalM2 - a.totalM2);
	const widest = Math.max(0, ...planted.map((r) => r.totalM2));
	for (const r of planted) for (const p of r.parts) p.pct = widest ? (p.areaM2 / widest) * 100 : 0;
	return planted;
}

/** A farm bar's accessible name: "Upper farm: 30.0 ha, Orchard 20.0 ha and Vines 10.0 ha". */
export function farmBarLabel(bar: FarmBar, ha: (m2: number) => string): string {
	return `${bar.name}: ${ha(bar.totalM2)} ha, ${joinNames(bar.parts.map((p) => `${p.name} ${ha(p.areaM2)} ha`))}`;
}

/** The header's line: "4 crops · 312.5 ha irrigated on 6 hydrological units · water year October to September" (the workspace says unit, playbook § 3). */
export function cropsSummary(cropCount: number, totalM2: number, plantedFarms: number, ha: (m2: number) => string): string {
	const crops = `${cropCount} crop${cropCount === 1 ? '' : 's'}`;
	const planted = plantedFarms ? `${ha(totalM2)} ha irrigated on ${plantedFarms} hydrological unit${plantedFarms === 1 ? '' : 's'}` : 'nothing planted yet';
	return `${crops} · ${planted} · water year October to September`;
}
