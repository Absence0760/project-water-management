import { describe, expect, it } from 'vitest';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { dotAt, extremeIndex, markText, nearestPoint, readout, sparkDescription, sparkPaths, sparkPoints, SPARK_H, SPARK_W } from './sparkline';

const f2 = (v: number) => v.toFixed(2);
const pc = (v: number) => `${Math.round(v)}%`;

describe('sparkPoints and sparkPaths', () => {
	it('spaces the points evenly from lo (bottom) to hi (top), clamps, and skips gaps', () => {
		const pts = sparkPoints([0, 0.5, null, 2], 0, 1);
		expect(pts).toEqual([
			{ i: 0, x: 0, y: 1 },
			{ i: 1, x: 1 / 3, y: 0.5 },
			{ i: 3, x: 1, y: 0 } // 2 is above hi: clamped to the top
		]);
		const { line, fill } = sparkPaths(pts);
		expect(line).toBe(`0,${SPARK_H - 2} 66.7,${SPARK_H / 2} ${SPARK_W},2`);
		expect(fill).toBe(`M0,${SPARK_H} L0,${SPARK_H - 2} L66.7,${SPARK_H / 2} L${SPARK_W},2 L${SPARK_W},${SPARK_H} Z`);
	});

	it('takes each point’s place across when given, and draws nothing with no values', () => {
		expect(sparkPoints([1, 2], 0, 2, [0.25, 0.75]).map((p) => p.x)).toEqual([0.25, 0.75]);
		expect(sparkPaths([])).toEqual({ line: '', fill: '' });
	});

	it('puts the dot where the line is drawn, as fractions of the element', () => {
		expect(dotAt({ i: 0, x: 0.5, y: 0 })).toEqual({ left: 0.5, top: 2 / SPARK_H });
		expect(dotAt({ i: 0, x: 1, y: 1 })).toEqual({ left: 1, top: (SPARK_H - 2) / SPARK_H });
	});
});

describe('the marked point and the read-out', () => {
	const values = [0.4, 0.8, 0.8, null, 0.2];
	const labels = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb'];

	it('marks the first highest or lowest value', () => {
		expect(extremeIndex(values, 'max')).toBe(1);
		expect(extremeIndex(values, 'min')).toBe(4);
		expect(extremeIndex([null, null], 'max')).toBe(-1);
	});

	it('words the mark, with its label where there is room', () => {
		const w = { values, labels, format: f2, mark: 'max' as const, markWord: 'max' };
		expect(markText(w, false)).toBe('max 0.80');
		expect(markText(w, true)).toBe('max 0.80 · Nov');
		expect(markText({ ...w, values: [null] }, false)).toBe('');
	});

	it('reads out the point nearest the pointer', () => {
		const pts = sparkPoints(values, 0, 1);
		expect(nearestPoint(pts, 0.1)!.i).toBe(0);
		expect(nearestPoint(pts, 0.7)!.i).toBe(2); // Jan is a gap: the nearest drawn point
		expect(readout(labels, values, 1, f2)).toBe('Nov 0.80');
		expect(readout(labels, values, 3, f2)).toBe('Jan no value');
		expect(nearestPoint([], 0.5)).toBeNull();
	});
});

describe('sparkDescription', () => {
	it('lists every value for a dozen or fewer, after the mark', () => {
		const factors = [0.6, 0.7, 0.8, 0.8, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.5, 0.6];
		expect(sparkDescription({ values: factors, labels: WATER_YEAR_MONTHS, format: f2, mark: 'max', markWord: 'max' }, ['Oct', 'Sep'])).toBe(
			'max 0.80 in Dec; Oct 0.60, Nov 0.70, Dec 0.80, Jan 0.80, Feb 0.80, Mar 0.70, Apr 0.60, May 0.50, Jun 0.40, Jul 0.40, Aug 0.50, Sep 0.60'
		);
	});

	it('gives the span, the ends, the mark and the other extreme for a long series', () => {
		const values: number[] = Array.from({ length: 30 }, (_, i) => (i === 10 ? 15 : i === 20 ? 100 : 60));
		values[29] = 45;
		const labels = values.map((_, i) => `${i + 1} Mar 2024`);
		expect(sparkDescription({ values, labels, format: pc, mark: 'min', markWord: 'low' }, ['1 Mar 2024', '30 Mar 2024'])).toBe(
			'1 Mar 2024 to 30 Mar 2024: 60% at the start, 45% at the end; low 15% on 11 Mar 2024, high 100% on 21 Mar 2024'
		);
	});

	it('says so when there is nothing to draw', () => {
		expect(sparkDescription({ values: [null], labels: ['Oct'], format: f2, mark: 'max', markWord: 'max' }, ['Oct', 'Oct'])).toBe('no values');
	});
});
