// The Crops & demand page's pictures (issue #17, option A · A3): a card per
// crop with its factor sparkline, one stacked bar per farm, the header's one
// line, and the crop colours the demand chart and the farm bars share. Pure,
// so the page stays markup and the numbers are unit-tested.
import type { CropStack } from './demand';
import { joinNames } from './demand';

type CropLike = { id: string; name: string; cropFactor: readonly number[] };
type AreaLike = { nodeId: string; cropId: string; areaM2: number };

/** Crop colours: theme tokens, so they follow light and dark mode. Past these, grey ("Other"). */
export const CROP_PALETTE = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--brand-node)', 'var(--warning)', 'var(--accent)'];
export const OTHER_COLOUR = 'var(--text-muted)';

/**
 * A colour per crop id, shared by the demand chart and the farm bars. A crop
 * with its own part in the chart takes that part's colour (the chart's parts
 * are in crop order, `cropStacks`); one grouped into "Other" is grey; a crop
 * with no demand yet (no A-pan, no area, factors all 0) takes the next unused
 * colour in crop order, then grey.
 */
export function cropColours(crops: readonly { id: string }[], stacks: readonly CropStack[], palette: readonly string[] = CROP_PALETTE): Map<string, string> {
	const out = new Map<string, string>();
	let used = 0;
	stacks.forEach((s, i) => {
		if (s.id !== 'other') {
			out.set(s.id, palette[i] ?? OTHER_COLOUR);
			used = i + 1;
		}
	});
	const grouped = stacks.some((s) => s.id === 'other');
	for (const c of crops) {
		if (out.has(c.id)) continue;
		// A crop left out of the chart's own parts while "Other" exists is in "Other" (it has demand) or has none.
		out.set(c.id, grouped ? OTHER_COLOUR : (palette[used++] ?? OTHER_COLOUR));
	}
	return out;
}

/** Index of the largest value (the first on a tie), or -1 when every value is 0 or less. */
function peakIndex(values: readonly number[]): number {
	let best = -1;
	values.forEach((v, i) => {
		if (v > 0 && (best < 0 || v > values[best]!)) best = i;
	});
	return best;
}

export interface CropCard {
	id: string;
	name: string;
	/** Planted area on the farms shown, m². */
	areaM2: number;
	/** Water-year month index of the highest gross need (A-pan × factor; the factor alone while A-pan is unset), or -1. */
	peak: number;
	/** The sparkline's points in a 240 × 70 box, Oct → Sep ("x,y x,y …"). */
	line: string;
	/** The same, closed along the bottom, for the shaded area under it. */
	fill: string;
	/** The sparkline's accessible name. */
	label: string;
	/** Months with a factor above 1.0 (the high-factor hint, `highCropFactors`). */
	high: string[];
}

export const SPARK_W = 240;
export const SPARK_H = 70;
const SPARK_BASE = SPARK_H - 4;

/** One card per crop, in crop order. `farmIds`: the farms whose areas count (the Crops tab's rows). */
export function cropCards(
	crops: readonly CropLike[],
	areas: readonly AreaLike[],
	farmIds: readonly string[],
	apanMm: readonly number[],
	months: readonly string[]
): CropCard[] {
	const farms = new Set(farmIds);
	const apanSet = apanMm.some((v) => v > 0);
	return crops.map((c) => {
		const f = Array.from({ length: 12 }, (_, i) => Math.max(0, c.cropFactor[i] || 0));
		const top = Math.max(1, ...f);
		const pts = f.map((v, i) => `${round((i * SPARK_W) / 11)},${round(SPARK_BASE - (v / top) * (SPARK_BASE - 4))}`);
		const need = apanSet ? f.map((v, i) => v * (apanMm[i] || 0)) : f;
		const peak = peakIndex(need);
		const name = c.name || '(unnamed)';
		const lo = Math.min(...f);
		const hi = Math.max(...f);
		const label =
			hi === 0
				? `${name} crop factor by month: 0 in every month`
				: `${name} crop factor by month, October to September: ${fmt2(lo)} to ${fmt2(hi)}, highest in ${months[peakIndex(f)] ?? ''}`;
		return {
			id: c.id,
			name,
			areaM2: areas.filter((a) => a.cropId === c.id && farms.has(a.nodeId)).reduce((s, a) => s + a.areaM2, 0),
			peak,
			line: pts.join(' '),
			fill: `M0,${SPARK_BASE} L${pts.join(' L')} L${SPARK_W},${SPARK_BASE} Z`,
			label,
			high: f.flatMap((v, i) => (v > 1 ? [months[i] ?? String(i + 1)] : []))
		};
	});
}

const round = (n: number) => Math.round(n * 10) / 10;
const fmt2 = (n: number) => n.toFixed(2);

export interface FarmBar {
	id: string;
	name: string;
	/** Total planted area, m². */
	totalM2: number;
	/** Each crop's share of the widest farm's total, in crop order; crops not planted here are left out. */
	parts: { cropId: string; name: string; areaM2: number; pct: number }[];
}

/**
 * One stacked bar per farm with something planted, in the farms' order; the
 * widest farm's bar fills the track. Farms with nothing planted are left out
 * (the page names them in the no-planted-area note).
 */
export function farmBars(farms: readonly { id: string; name: string }[], crops: readonly { id: string; name: string }[], areas: readonly AreaLike[]): FarmBar[] {
	const rows = farms.map((f) => {
		const parts = crops.flatMap((c) => {
			const areaM2 = areas.filter((a) => a.nodeId === f.id && a.cropId === c.id).reduce((s, a) => s + a.areaM2, 0);
			return areaM2 > 0 ? [{ cropId: c.id, name: c.name || '(unnamed)', areaM2, pct: 0 }] : [];
		});
		return { id: f.id, name: f.name || '(unnamed)', totalM2: parts.reduce((s, p) => s + p.areaM2, 0), parts };
	});
	const planted = rows.filter((r) => r.totalM2 > 0);
	const widest = Math.max(0, ...planted.map((r) => r.totalM2));
	for (const r of planted) for (const p of r.parts) p.pct = widest ? (p.areaM2 / widest) * 100 : 0;
	return planted;
}

/** A farm bar's accessible name: "Upper farm: 30.0 ha, Orchard 20.0 ha and Vines 10.0 ha". */
export function farmBarLabel(bar: FarmBar, ha: (m2: number) => string): string {
	return `${bar.name}: ${ha(bar.totalM2)} ha, ${joinNames(bar.parts.map((p) => `${p.name} ${ha(p.areaM2)} ha`))}`;
}

/** The header's line: "4 crops · 312.5 ha irrigated on 6 farms · water year October to September". */
export function cropsSummary(cropCount: number, totalM2: number, plantedFarms: number, ha: (m2: number) => string): string {
	const crops = `${cropCount} crop${cropCount === 1 ? '' : 's'}`;
	const planted = plantedFarms ? `${ha(totalM2)} ha irrigated on ${plantedFarms} farm${plantedFarms === 1 ? '' : 's'}` : 'nothing planted yet';
	return `${crops} · ${planted} · water year October to September`;
}
