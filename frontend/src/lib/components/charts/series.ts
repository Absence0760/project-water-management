// Helpers for turning API daily series into uPlot's aligned-array format.
import { toEpochDay } from '@water-management/engine';
import { fmtDay } from '#lib/format/number.js';

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
	/** A points series' dot size in CSS px (3 by default; sparse observations, such as a dam seen from space, read better larger). */
	pointSize?: number;
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

/** The fewest days of context a focused period opens with on each side. */
export const FOCUS_PAD_DAYS = 30;

/**
 * The window a daily chart opens on to show one period (a warning's View, e.g.): the period with as many days again
 * on each side, at least FOCUS_PAD_DAYS, clipped to the data. Null when the period misses the data or isn't a date.
 */
export function focusWindow(focus: { start: string; end: string }, lo: number, hi: number): { min: number; max: number } | null {
	const start = Date.parse(`${focus.start}T00:00:00Z`) / 1000;
	const end = Date.parse(`${focus.end}T00:00:00Z`) / 1000;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end < lo || start > hi) return null;
	const pad = Math.max(FOCUS_PAD_DAYS * 86_400, end - start + 86_400);
	return { min: Math.max(lo, start - pad), max: Math.min(hi, end + pad) };
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

const DAY = 86_400;
/**
 * The time axis's tick labels, day before month ("30 Dec", year under the first tick of each year).
 * uPlot's own are American ("12/30"), which a South African reader takes as day/month: "1/9" read
 * as 1 September on a chart of 9 January. The rows are uPlot's `values` table: tick step (seconds),
 * the label, then the label at a new year, month, day, hour, minute and second (null keeps the
 * label), and 1 to show the extra line only where the larger unit changes.
 */
export const TIME_TICKS: (string | number | null)[][] = [
	[DAY * 365, '{YYYY}', null, null, null, null, null, null, 1],
	[DAY * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
	[DAY, '{D} {MMM}', '\n{YYYY}', null, null, null, null, null, 1],
	[3600, '{HH}:{mm}', '\n{D} {MMM} {YYYY}', null, '\n{D} {MMM}', null, null, null, 1],
	[60, '{HH}:{mm}', '\n{D} {MMM} {YYYY}', null, '\n{D} {MMM}', null, null, null, 1]
];

/**
 * The decades a log axis spans at most. A series that reaches float noise
 * (a recession tailing off to 1e-19 m³/s) stretched the Flow duration curve's
 * axis over twenty decades, whose labels piled into a block (issue #521).
 * Six decades below the largest value keeps every real low flow on the chart;
 * anything smaller runs off its foot, and the read-out still gives its value.
 */
export const LOG_DECADES = 6;

/** The lower end of a log axis: the data's least positive value, but no more than LOG_DECADES decades under its largest. */
export function logFloor(min: number, max: number, decades = LOG_DECADES): number {
	if (!(max > 0)) return min;
	const floor = max / 10 ** decades;
	return min > floor ? min : floor;
}

/**
 * Which ticks of a log axis get a label: only whole decades, and of those
 * every second, third… so that at most `room` labels are drawn. The step is
 * aligned on the exponent (1, 100, 10k, not 10, 1k), so panning keeps the
 * same labels. Others are null (no label, no grid line).
 */
export function decadeTicks(splits: readonly number[], room: number): (number | null)[] {
	const isDecade = (v: number) => v > 0 && Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9;
	const decades = splits.filter(isDecade);
	const step = Math.max(1, Math.ceil(decades.length / Math.max(1, Math.floor(room))));
	return splits.map((v) => (isDecade(v) && ((Math.round(Math.log10(v)) % step) + step) % step === 0 ? v : null));
}

/**
 * Room under a linear y axis for the lanes along the plot's foot (LineChart `lanesRoom`): the axis's
 * lower end moved down so that `lo` (the lowest value the axis would start at) sits `lanePx` above the
 * plot's foot, over the strips rather than under them. A dam seen empty is a reading of 0 ha, and the
 * strips at 0 hid it (issue #604 R5-B). `plotPx` and `lanePx` in the same pixels; unchanged when the
 * plot is no taller than the lanes.
 */
export function laneRoom(lo: number, hi: number, plotPx: number, lanePx: number): [number, number] {
	if (!(plotPx > lanePx) || !(lanePx > 0)) return [lo, hi];
	// A flat range (every value the same) gets a span to place the value in, as uPlot gives one.
	const top = hi > lo ? hi : lo + (Math.abs(lo) || 1);
	return [lo - ((top - lo) * lanePx) / (plotPx - lanePx), top];
}
