// Chart data for the Data tab's double-mass panel (engine doubleMass,
// docs/model.md §2.10a): the cumulative curve with the whole-record line and
// the fitted segments, and the residual from the whole-record line by year.
import { waterYearLabel, type DoubleMass } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';

export interface DoubleMassChart {
	curve: { series: ChartSeries[]; xy: { x: number[]; ys: (number | null)[][] } };
	residual: { series: ChartSeries[]; xy: { x: number[]; ys: (number | null)[][] } };
	/** One line per segment, for the caption and the text summary: "1990/91 to 2001/02: 1.94 × CHIRPS". */
	segments: string[];
	/** The chart caption: what the lines are. */
	caption: string;
}

const noDates = { startDate: '', values: [] as (number | null)[] };
const f2 = (x: number) => x.toFixed(2);

export function doubleMassChart(dm: DoubleMass): DoubleMassChart {
	const x = [0, ...dm.years.map((y) => y.cumChirpsMm)];
	const observed = [null, ...dm.years.map((y) => y.cumCatchmentMm)];
	const whole = x.map((v) => dm.wholeSlope * v);
	// Each segment's line starts where the curve stands at the end of the one before it:
	// its slope is Σ catchment / Σ CHIRPS over the segment, so it ends on the curve too.
	const fitted: number[] = [0];
	let seg = 0;
	let x0 = 0;
	let y0 = 0;
	dm.years.forEach((y, i) => {
		while (seg < dm.segments.length - 1 && y.waterYear > dm.segments[seg]!.toWaterYear) {
			x0 = dm.years[i - 1]!.cumChirpsMm;
			y0 = dm.years[i - 1]!.cumCatchmentMm;
			seg++;
		}
		fitted.push(y0 + dm.segments[seg]!.slope * (y.cumChirpsMm - x0));
	});
	const segments = dm.segments.map((s) => `${waterYearLabel(s.fromWaterYear)} to ${waterYearLabel(s.toWaterYear)}: ${f2(s.slope)} × CHIRPS`);
	return {
		curve: {
			series: [
				{ ...noDates, label: 'Catchment rain, cumulative', style: 'points', color: '--chart-obs' },
				{ ...noDates, label: `Whole record (${f2(dm.wholeSlope)} ×)`, style: 'dashed', color: '--series-2' },
				{ ...noDates, label: dm.segments.length > 1 ? 'Segments' : 'Fitted line', color: '--series-1' }
			],
			xy: { x, ys: [observed, whole, fitted] }
		},
		residual: {
			series: [{ ...noDates, label: 'Departure from the whole-record line', color: '--series-1' }],
			xy: { x: dm.years.map((y) => y.waterYear), ys: [dm.years.map((y) => y.residualPct)] }
		},
		segments,
		caption:
			`Water-year totals on the days both series have a reading (${dm.years.length} years). ` +
			`Dashed: the whole-record slope, ${f2(dm.wholeSlope)}. ` +
			(dm.breaks.length ? `Solid: the segments between breaks (${segments.join('; ')}).` : 'No break found: one straight line fits.')
	};
}
