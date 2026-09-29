// Helpers for turning API daily series into uPlot's aligned-array format.
import { toEpochDay } from '@water-management/engine';
import { fmtDay } from '$lib/format/number';

export interface DailyInput {
	startDate: string;
	values: (number | null)[];
}

export interface ChartSeries extends DailyInput {
	label: string;
	/** line (default), points (e.g. observations), dashed, or step (monthly targets such as EWR). */
	style?: 'line' | 'points' | 'dashed' | 'step';
	/** CSS custom property holding the colour, e.g. '--series-2'. */
	color?: string;
	width?: number;
	/** Starts switched off; clicking its legend entry shows it. */
	hidden?: boolean;
}

/**
 * Indices of values with no value either side. A line needs two points, so
 * a lone reading between gaps would draw nothing; the chart marks these with
 * a dot instead. Gaps are never bridged.
 */
export function isolatedIndices(ys: readonly (number | null)[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < ys.length; i++) {
		if (ys[i] != null && ys[i - 1] == null && ys[i + 1] == null) out.push(i);
	}
	return out;
}

/**
 * Short axis labels: 30 000 000 → "30M", 250 000 → "250k", 1 500 → "1.5k",
 * 0.25 → "0.25". Keeps the y axis narrow for big m³/day figures. Below 0.01
 * (a log axis's lower decades) it writes the decimal, two significant
 * figures at most: 0.001 → "0.001", 0.00025 → "0.00025" (issue #162: not
 * "1e-3"). Only below 1e-6, float noise rather than a flow, is it an
 * exponent, as fmtQty writes one.
 */
export function fmtCompact(v: number): string {
	const a = Math.abs(v);
	const trim = (x: number, d: number) => String(Number(x.toFixed(d)));
	if (a >= 1e9) return `${trim(v / 1e9, 1)}G`;
	if (a >= 1e6) return `${trim(v / 1e6, 1)}M`;
	if (a >= 1e4) return `${trim(v / 1e3, 0)}k`;
	if (a >= 1e3) return `${trim(v / 1e3, 1)}k`;
	if (a >= 1 || a === 0) return trim(v, 1);
	if (a >= 0.01) return trim(v, 3);
	if (a < 1e-6) return v.toExponential(0);
	// toFixed never writes an exponent: two figures past the first non-zero digit, trailing zeros dropped.
	const digits = Math.ceil(-Math.log10(a)) + 1;
	return v.toFixed(digits).replace(/0+$/, '');
}

/**
 * Align several daily series (possibly different start dates and lengths) on
 * one x axis of epoch seconds covering their union. Missing days are null.
 */
export function alignDaily(series: DailyInput[]): { x: number[]; ys: (number | null)[][] } {
	if (series.length === 0) return { x: [], ys: [] };
	const starts = series.map((s) => toEpochDay(s.startDate));
	const start = Math.min(...starts);
	const end = Math.max(...series.map((s, i) => starts[i]! + s.values.length - 1));
	const len = Math.max(0, end - start + 1);
	const x = Array.from({ length: len }, (_, i) => (start + i) * 86_400);
	const ys = series.map((s, i) => {
		const out: (number | null)[] = new Array(len).fill(null);
		const off = starts[i]! - start;
		s.values.forEach((v, j) => {
			out[off + j] = v == null || !Number.isFinite(v) ? null : v;
		});
		return out;
	});
	return { x, ys };
}

/**
 * Shift the visible window [min, max] by `delta`, keeping its width and
 * stopping at the data's ends [lo, hi] rather than scrolling past them. A
 * window as wide as the data (or wider) is the whole range.
 */
export function panWindow(min: number, max: number, delta: number, lo: number, hi: number): { min: number; max: number } {
	const width = max - min;
	if (width >= hi - lo) return { min: lo, max: hi };
	const start = Math.min(Math.max(min + delta, lo), hi - width);
	return { min: start, max: start + width };
}

/** Device pixels per CSS pixel a printed chart is drawn at. */
export const PRINT_PIXEL_RATIO = 2;

/**
 * How much larger than its box a print-mode chart is laid out, so its canvas
 * holds PRINT_PIXEL_RATIO device pixels per CSS pixel. uPlot sizes its canvas
 * by the screen's devicePixelRatio and has no option to override it, so the
 * chart is built this many times larger (fonts, strokes and axes too) and
 * scaled back down into its box. 1 on a screen already that sharp.
 */
export function printScale(devicePixelRatio: number): number {
	const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	return dpr >= PRINT_PIXEL_RATIO ? 1 : PRINT_PIXEL_RATIO / dpr;
}

/**
 * A daily chart's labelled band (the forecast days, WP-2.12): its span in
 * epoch seconds, from the start of `from` to the end of `to` (the data's last
 * day when absent), clipped to the data. null when the band misses the data
 * entirely, or there is no data.
 */
export function bandSpan(band: { from: string; to?: string }, x: readonly number[]): { start: number; end: number } | null {
	if (!x.length) return null;
	const lo = x[0]!;
	const hi = x[x.length - 1]! + 86_400;
	const start = Math.max(lo, Date.parse(`${band.from}T00:00:00Z`) / 1000);
	const end = Math.min(hi, band.to ? Date.parse(`${band.to}T00:00:00Z`) / 1000 + 86_400 : hi);
	return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

const isoDayOf = (epochSec: number) => new Date(epochSec * 1000).toISOString().slice(0, 10);

/**
 * A line chart's accessible name (ui-playbook § 3, "Label every chart"): its
 * title, its series, its unit and its span. `x` is the daily x axis (epoch
 * seconds, UTC), or null for an x–y chart, which names its x axis instead:
 * "Supply vs demand: line chart of Demand, Supplied, in m³/day, 1 Oct 2021 to
 * 28 Jan 2022".
 */
export function chartName(title: string, series: readonly { label: string }[], unit: string, x: readonly number[] | null, xLabel?: string): string {
	const parts = [`${title}: line chart of ${series.map((s) => s.label).join(', ')}`];
	if (unit) parts.push(`in ${unit}`);
	if (x && x.length) parts.push(`${fmtDay(isoDayOf(x[0]!))} to ${fmtDay(isoDayOf(x[x.length - 1]!))}`);
	else if (!x && xLabel) parts.push(`against ${xLabel}`);
	return parts.join(', ');
}
