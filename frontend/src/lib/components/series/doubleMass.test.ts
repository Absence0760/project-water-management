import type { DoubleMass } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { doubleMassChart } from './doubleMass';

/** Synthetic: three years at 2 × CHIRPS, then two at 3 ×, 100 mm of CHIRPS a year. */
const year = (wy: number, cumX: number, cumY: number, ratio: number) => ({
	waterYear: wy, days: 365, catchmentMm: 100 * ratio, chirpsMm: 100, ratio, cumChirpsMm: cumX, cumCatchmentMm: cumY, residualPct: ((cumY - 2.4 * cumX) / cumY) * 100
});
const dm: DoubleMass = {
	years: [year(2000, 100, 200, 2), year(2001, 200, 400, 2), year(2002, 300, 600, 2), year(2003, 400, 900, 3), year(2004, 500, 1200, 3)],
	skippedYears: [],
	wholeSlope: 2.4,
	segments: [
		{ fromWaterYear: 2000, toWaterYear: 2002, years: 3, days: 1095, slope: 2 },
		{ fromWaterYear: 2003, toWaterYear: 2004, years: 2, days: 730, slope: 3 }
	],
	breaks: [{ afterWaterYear: 2002, slopeBefore: 2, slopeAfter: 3, change: 0.5, pettittP: 0.01, bicGain: 10 }]
};

describe('doubleMassChart', () => {
	it('draws the curve from the origin, the whole-record line and segments that meet the curve at each break', () => {
		const c = doubleMassChart(dm);
		expect(c.curve.xy.x).toEqual([0, 100, 200, 300, 400, 500]);
		expect(c.curve.xy.ys[0]).toEqual([null, 200, 400, 600, 900, 1200]);
		expect(c.curve.xy.ys[1]).toEqual([0, 240, 480, 720, 960, 1200]);
		// Segment 1 slope 2 from the origin, then slope 3 from (300, 600): on the curve at every year here.
		expect(c.curve.xy.ys[2]).toEqual([0, 200, 400, 600, 900, 1200]);
		expect(c.curve.series.map((s) => s.style ?? 'line')).toEqual(['points', 'dashed', 'line']);
		expect(c.residual.xy.x).toEqual([2000, 2001, 2002, 2003, 2004]);
		expect(c.residual.xy.ys[0]![4]).toBeCloseTo(0, 12);
		expect(c.segments).toEqual(['2000/01 to 2002/03: 2.00 × CHIRPS', '2003/04 to 2004/05: 3.00 × CHIRPS']);
		expect(c.caption).toBe(
			'Water-year totals on the days both series have a reading (5 years). Dashed: the whole-record slope, 2.40. ' +
				'Solid: the segments between breaks (2000/01 to 2002/03: 2.00 × CHIRPS; 2003/04 to 2004/05: 3.00 × CHIRPS).'
		);
	});

	it('says when one straight line fits', () => {
		const one = { ...dm, segments: [{ fromWaterYear: 2000, toWaterYear: 2004, years: 5, days: 1825, slope: 2.4 }], breaks: [] };
		const c = doubleMassChart(one);
		expect(c.curve.xy.ys[2]).toEqual([0, 240, 480, 720, 960, 1200]);
		expect(c.curve.series[2]!.label).toBe('Fitted line');
		expect(c.caption).toMatch(/No break found: one straight line fits\.$/);
	});
});
