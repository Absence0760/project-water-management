// The diversion curve's preview (engine 1.113.0, docs/model.md §2.6a): what a river off-take sized by a share of
// the river diverts at a few example flows and which limit binds, read off the engine's own curve. Invented
// numbers of the shape the client's hydrologist gave: 2000 × x^−0.9 %, at most 95 %, a canal of 0.25 m³/s.
import { describe, expect, it } from 'vitest';
import type { Transfer } from '@water-management/engine';
import { canalM3Day, diversionPreview, diversionPreviews, PREVIEW_FLOWS_M3S } from './diversionPreview';

const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 't',
	fromNodeId: 'a',
	toNodeId: 'b',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.25,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'diversionCurve',
	diversionCoefficient: 2000,
	diversionExponent: -0.9,
	diversionMaxPct: 0.95,
	diversionFlowUnit: 'L/s',
	...over
});

describe('diversionPreview', () => {
	it('in L/s: the largest share at a trickle, the curve above 29.5 L/s, the 0.25 m³/s canal never full', () => {
		const p = diversionPreview(rule())!;
		expect(p.unit).toBe('L/s');
		expect(p.canalM3Day).toBeCloseTo(21_600, 9);
		expect(p.canal).toBeCloseTo(250, 9);
		expect(p.rows.map((r) => r.flow)).toEqual(PREVIEW_FLOWS_M3S.map((q) => (q * 86_400) / 86.4));
		// 5 L/s and 20 L/s: 95 %; 50 L/s: 2000 × 50^−0.9 = 59.2 %; 10 000 L/s: 0.5 %.
		expect(p.rows.map((r) => r.limit)).toEqual(['largest', 'largest', 'curve', 'curve', 'curve', 'curve', 'curve']);
		expect(p.rows[0]!.share).toBe(0.95);
		expect(p.rows[2]!.share).toBeCloseTo((2000 * Math.pow(50, -0.9)) / 100, 12);
		expect(p.rows[2]!.diverted).toBeCloseTo(50 * p.rows[2]!.share, 9);
		expect(p.rows[6]!.diverted).toBeLessThan(p.canal);
	});

	it('in m³/s: 95 % of the river until the canal binds', () => {
		const p = diversionPreview(rule({ diversionFlowUnit: 'm3/s' }))!;
		expect(p.rows.map((r) => r.limit)).toEqual(['largest', 'largest', 'largest', 'largest', 'canal', 'canal', 'canal']);
		expect(p.rows[3]!.diverted).toBeCloseTo(0.95 * 0.2, 12);
		expect(p.rows[4]!.diverted).toBeCloseTo(0.25, 12);
		expect(p.rows[4]!.divertedM3Day).toBeCloseTo(21_600, 9);
	});

	it('reads the canal off the rule: its largest month within its daily cap, and none when it never runs', () => {
		expect(canalM3Day(rule({ dailyCapM3: 10_000 }))).toBe(10_000);
		expect(canalM3Day(rule({ monthlyRateM3s: [0.1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2], months: [10, 11, 9], maxRateM3s: 0.3 }))).toBeCloseTo(0.3 * 86_400, 9);
		const off = diversionPreview(rule({ maxRateM3s: 0 }))!;
		expect(off.canalM3Day).toBe(0);
		expect(off.rows.every((r) => r.diverted === 0 && r.limit === 'canal')).toBe(true);
	});

	it('by month (engine 1.114.0): one preview per formula, its canal the largest rate of its months, a split’s shares after the losses', () => {
		const a = { coefficient: 2000, exponent: -0.9, maxPct: 0.95 };
		const b = { coefficient: 50, exponent: 0, maxPct: null };
		const t = rule({
			diversionCoefficient: null,
			diversionExponent: null,
			diversionMaxPct: null,
			diversionFlowUnit: 'm3/s',
			monthlyRateM3s: [0.25, 0.25, 0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
			months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			maxRateM3s: 0.3,
			monthlyDiversion: [a, a, b, b, { ...b, coefficient: 0 }, null, null, null, null, null, null, null],
			lossPct: 0.2,
			destinations: [
				{ nodeId: 'b', pct: 0.4 },
				{ nodeId: 'c', pct: 0.6 }
			]
		});
		const ps = diversionPreviews(t);
		// February's incomplete formula and the months up to their maximum have no preview.
		expect(ps.map((p) => p.months)).toEqual([[0, 1], [2, 3]]);
		expect(ps[0]!.canal).toBeCloseTo(0.25, 12);
		expect(ps[1]!.canal).toBeCloseTo(0.1, 12);
		// 50 % of 0.2 m³/s is 0.1, the canal: delivered 0.1 × 0.8, split 40/60.
		const r = ps[1]!.rows[3]!;
		expect(r.diverted).toBeCloseTo(0.1, 12);
		expect(r.delivered[0]).toBeCloseTo(0.032, 12);
		expect(r.delivered[1]).toBeCloseTo(0.048, 12);
		expect(diversionPreviews(rule({ diversionFlowUnit: null }))).toEqual([]);
	});

	it('is null while the curve is incomplete', () => {
		for (const over of [{ diversionCoefficient: null }, { diversionExponent: null }, { diversionFlowUnit: null }, { diversionMaxPct: 2 }]) expect(diversionPreview(rule(over)), JSON.stringify(over)).toBeNull();
	});
});
