// Helpers for turning API daily series into uPlot's aligned-array format.
import { toEpochDay } from '@water-management/engine';

export interface DailyInput {
	startDate: string;
	values: (number | null)[];
}

export interface ChartSeries extends DailyInput {
	label: string;
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
