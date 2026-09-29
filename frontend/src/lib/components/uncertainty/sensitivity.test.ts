import { describe, expect, it } from 'vitest';
import type { SensitivityResult, SiteValues } from '@water-management/engine';
import { factorsLine, metricsFor, rowText, thresholdOn, tornadoRows, tornadoScale, verdictsAt } from './sensitivity';

const v = (daysNotMet: number, shortfallMm3: number, reserveRate: number | null = null, days = 1000): SiteValues => ({
	daysNotMet,
	daysMet: 1 - daysNotMet / days,
	shortfallMm3,
	reserveRate
});

const scaled = (factor: string, label: string, low: SiteValues, high: SiteValues, lo = '× 0.9', hi = '× 1.1') => ({
	factor,
	label,
	low: { setting: 0.9, label: lo, values: [low] },
	high: { setting: 1.1, label: hi, values: [high] },
	notes: []
});

/** A synthetic result: one outlet site, central 150 days not met of 1000. */
function result(over: Partial<SensitivityResult> = {}): SensitivityResult {
	return {
		engineVersion: 'test',
		reportStart: '2001-10-01',
		reportEnd: '2004-06-26',
		days: 1000,
		sites: [{ key: 'outlet', name: 'Outlet', isOutlet: true, hasRuleTable: false }],
		central: [v(150, 2)],
		factors: [
			scaled('rain', 'Rain', v(260, 3.5), v(90, 1.1)),
			scaled('pan', 'Pan coefficient', v(120, 1.6), v(190, 2.6), '× 0.85', '× 1.15'),
			scaled('abstraction', 'Abstraction (demand)', v(140, 1.8), v(160, 2.2), '× 0.7', '× 1.3'),
			scaled('damStorage', 'Initial dam storage', v(150, 2), v(150, 2), 'empty', 'full')
		] as SensitivityResult['factors'],
		skipped: [],
		ranges: { rain: { low: 0.9, high: 1.1 }, pan: { low: 0.85, high: 1.15 }, lakeEvap: { low: 0.85, high: 1.15 }, abstraction: { low: 0.7, high: 1.3 } },
		thresholds: { daysMet: 0.8, reserveRate: 0.8 },
		verdicts: [],
		...over
	};
}

describe('tornadoRows', () => {
	it('puts the largest swing first, ties in the factors’ own order', () => {
		const rows = tornadoRows(result(), 0, 'daysNotMet');
		expect(rows.map((r) => [r.factor, r.swing])).toEqual([
			['rain', 170],
			['pan', 70],
			['abstraction', 20],
			['damStorage', 0]
		]);
		expect(rows[0]).toMatchObject({ label: 'Rain', lowLabel: '× 0.9', highLabel: '× 1.1', low: 260, high: 90 });
	});

	it('sorts on the metric shown, and gives no swing where a value is missing', () => {
		const r = result({
			sites: [{ key: 'outlet', name: 'Outlet', isOutlet: true, hasRuleTable: true }],
			factors: [scaled('rain', 'Rain', v(0, 0, null), v(0, 0, 0.9)), scaled('pan', 'Pan coefficient', v(0, 0, 0.5), v(0, 0, 0.7))] as SensitivityResult['factors']
		});
		expect(tornadoRows(r, 0, 'reserveRate').map((x) => [x.factor, x.swing])).toEqual([
			['pan', expect.closeTo(0.2, 9)],
			['rain', 0]
		]);
	});
});

describe('tornadoScale', () => {
	it('holds the central value, every end and the threshold on round ticks', () => {
		const s = tornadoScale(tornadoRows(result(), 0, 'daysNotMet'), 150, 200);
		expect([s.lo, s.hi]).toEqual([50, 300]);
		expect(s.ticks).toEqual([50, 100, 150, 200, 250, 300]);
		expect(s.at(50)).toBe(0);
		expect(s.at(300)).toBe(1);
		expect(s.at(175)).toBeCloseTo(0.5, 9);
	});

	it('widens a scale with nothing to span, and copes with no values', () => {
		const flat = tornadoScale([{ factor: 'x', label: 'x', lowLabel: 'a', highLabel: 'b', low: 5, high: 5, swing: 0 }], 5);
		expect(flat.lo).toBeLessThan(5);
		expect(flat.hi).toBeGreaterThan(5);
		const none = tornadoScale([], null);
		expect(none.hi).toBeGreaterThan(none.lo);
	});
});

describe('thresholdOn', () => {
	const days = { key: 'outlet', metric: 'daysMet' as const, threshold: 0.8, central: 0.85, min: 0.74, max: 0.91, verdict: 'notDeterminable' as const, text: '' };
	it('draws a days-met threshold as the days not met it allows, a Reserve one as is, and none on the shortfall', () => {
		expect(thresholdOn('daysNotMet', days, 1000)).toBe(200);
		expect(thresholdOn('shortfallMm3', days, 1000)).toBeNull();
		expect(thresholdOn('reserveRate', days, 1000)).toBeNull();
		expect(thresholdOn('reserveRate', { ...days, metric: 'reserveRate', threshold: 0.9 }, 1000)).toBe(0.9);
		expect(thresholdOn('daysNotMet', undefined, 1000)).toBeNull();
	});
});

describe('verdictsAt', () => {
	it('re-judges the envelope at the thresholds on screen', () => {
		// Days met: central 85 %, envelope 74 %–91 %.
		const r = result();
		expect(verdictsAt(r, { daysMet: 0.8, reserveRate: 0.8 })[0]).toMatchObject({ verdict: 'notDeterminable', min: 0.74, max: 0.91 });
		expect(verdictsAt(r, { daysMet: 0.7, reserveRate: 0.8 })[0]!.verdict).toBe('meets');
		expect(verdictsAt(r, { daysMet: 0.95, reserveRate: 0.8 })[0]!.verdict).toBe('fails');
	});
});

describe('labels', () => {
	it('names the metrics a site has, the Reserve rate first with a rule table', () => {
		expect(metricsFor(false)).toEqual(['daysNotMet', 'shortfallMm3']);
		expect(metricsFor(true)).toEqual(['reserveRate', 'daysNotMet', 'shortfallMm3']);
	});

	it('says each factor’s settings in one line, and a row in words', () => {
		expect(factorsLine(result())).toBe('Rain × 0.9 / × 1.1 · Pan coefficient × 0.85 / × 1.15 · Abstraction (demand) × 0.7 / × 1.3 · Initial dam storage empty / full');
		const [rain] = tornadoRows(result(), 0, 'daysNotMet');
		expect(rowText(rain!, 'daysNotMet')).toBe('Rain: × 0.9 gives 260, × 1.1 gives 90 days.');
		const pan = tornadoRows(result(), 0, 'shortfallMm3').find((x) => x.factor === 'pan')!;
		expect(rowText(pan, 'shortfallMm3')).toBe('Pan coefficient: × 0.85 gives 1.60, × 1.15 gives 2.60 Mm³.');
	});
});
