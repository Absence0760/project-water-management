// Helpers for turning API daily series into uPlot's aligned-array format.
import { toEpochDay } from '@water-management/engine';

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
 * 0.25 → "0.25". Keeps the y axis narrow for big m³/day figures.
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
	return v.toExponential(0);
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
