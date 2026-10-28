// Modelled vs observed dam area (./compare.ts, issue #604 R5-B): pairing by
// date, the clear-view threshold, the composite dam's sum, the source rules,
// the spill / empty / mismatch flags at their thresholds, and the summary.
// Dates, so under a skewed TZ (CLAUDE.md rule 7): UTC+14 would move a
// local-midnight date a day, UTC−11 the other way.
import { estimatedDamAreaM2 } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareDam, flags, fullAreaOf, OBSERVED, type CompareInput, type ObservationIn } from './compare.js';

const F = 10_000;
const full = { areaM2: F, from: 'entered' as const };
const obs = (date: string, wetAreaM2: number, more: Partial<ObservationIn> = {}): ObservationIn => ({ featureId: 'a', source: 'wofs', date, wetAreaM2, pctObserved: 100, ...more });
/** A run from 1 Jan 2024 whose dam_area is `values` (one a day). */
const run = (values: (number | null)[]) => ({ startDate: '2024-01-01', values });
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

const base = (over: Partial<CompareInput>): CompareInput => ({ features: [{ id: 'a', match: 'matched' }], observations: [], modelled: run(new Array(31).fill(5_000)), full, ...over });

describe('fullAreaOf', () => {
	it('takes the survey curve’s top area first, then the entered area, then the engine’s estimate', () => {
		const curve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 2, areaM2: 4_000, volumeM3: 5_000 },
			{ levelM: 4, areaM2: 9_000, volumeM3: 20_000 }
		];
		expect(fullAreaOf({ damCapacityM3: 20_000, damAreaFullM2: 7_000, damCurve: curve })).toEqual({ areaM2: 9_000, from: 'survey' });
		expect(fullAreaOf({ damCapacityM3: 20_000, damAreaFullM2: 7_000, damCurve: [] })).toEqual({ areaM2: 7_000, from: 'entered' });
		expect(fullAreaOf({ damCapacityM3: 20_000, damAreaFullM2: null })).toEqual({ areaM2: estimatedDamAreaM2(20_000), from: 'estimated' });
	});

	it('uses the estimate the run’s own engine used (capacity ÷ 3 m before 1.63.0), and a broken curve falls back as the run did', () => {
		expect(fullAreaOf({ damCapacityM3: 30_000, damAreaFullM2: null }, '1.62.9')).toEqual({ areaM2: 10_000, from: 'estimated' });
		const bad = [{ levelM: 0, areaM2: 5, volumeM3: 10 }];
		expect(fullAreaOf({ damCapacityM3: 30_000, damAreaFullM2: 6_000, damCurve: bad })).toEqual({ areaM2: 6_000, from: 'entered' });
	});

	it('is null for a unit with no dam or no node', () => {
		expect(fullAreaOf({ damCapacityM3: 0, damAreaFullM2: 5_000 })).toBeNull();
		expect(fullAreaOf(undefined)).toBeNull();
	});
});

describe('flags', () => {
	it('marks full at 95 % of the full area and empty at 5 % (never under one pixel on the observed side)', () => {
		expect(flags(OBSERVED.fullShare * F, OBSERVED.fullShare * F, F)).toMatchObject({ seenFull: true, modelFull: true, mismatch: null });
		expect(flags(OBSERVED.fullShare * F - 1, 9_000, F)).toMatchObject({ seenFull: false, modelFull: false });
		// 5 % of 10 000 m² is 500 m², under a pixel: the observed side is empty up to 900 m², the model's at 500.
		expect(flags(900, 500, F)).toMatchObject({ seenEmpty: true, modelEmpty: true, mismatch: null });
		expect(flags(901, 501, F)).toMatchObject({ seenEmpty: false, modelEmpty: false });
		expect(flags(40_000, 0, 1_000_000)).toMatchObject({ seenEmpty: true });
		expect(flags(50_001, 0, 1_000_000)).toMatchObject({ seenEmpty: false });
	});

	it('calls a mismatch only when the other side is clearly not in that state', () => {
		expect(flags(7_999, 9_600, F).mismatch).toBe('model-full');
		expect(flags(8_000, 9_600, F).mismatch).toBeNull();
		expect(flags(2_001, 400, F).mismatch).toBe('model-empty');
		expect(flags(2_000, 400, F).mismatch).toBeNull();
		expect(flags(9_600, 7_999, F).mismatch).toBe('seen-full');
		expect(flags(9_600, 8_000, F).mismatch).toBeNull();
		expect(flags(500, 2_001, F).mismatch).toBe('seen-empty');
		expect(flags(500, 2_000, F).mismatch).toBeNull();
	});
});

describe('compareDam', () => {
	it('pairs each clear observation with the run’s dam area that day (start of day), oldest first', () => {
		const values = new Array(31).fill(5_000);
		values[4] = 6_000;
		values[9] = 4_000;
		const r = compareDam(base({ modelled: run(values), observations: [obs('2024-01-10', 4_500), obs('2024-01-05', 6_500)] }));
		expect(r.points.map((p) => [p.date, p.wetAreaM2, p.modelledAreaM2, p.compared])).toEqual([
			['2024-01-05', 6_500, 6_000, true],
			['2024-01-10', 4_500, 4_000, true]
		]);
		// Model − observed = −500 both times: −5 % of the full area, both within 10 %.
		expect(r.summary).toMatchObject({ compared: 2, skipped: 0, withinShare: 1, mismatches: 0 });
		expect(r.summary.biasPctOfFull).toBeCloseTo(-5, 9);
	});

	it('leaves out a view under 90 % clear, says why, and counts it as skipped', () => {
		const r = compareDam(base({ observations: [obs('2024-01-02', 5_000, { pctObserved: 89.9 }), obs('2024-01-03', 5_000, { pctObserved: 90 })] }));
		expect(r.points.map((p) => p.skip)).toEqual(['partly-seen', null]);
		expect(r.summary).toMatchObject({ compared: 1, skipped: 1 });
		expect(r.summary.latestClear).toMatchObject({ date: '2024-01-03' });
	});

	it('sums a composite dam’s polygons, and only on a day every one was seen by that source', () => {
		const features = [
			{ id: 'a', match: 'matched' as const },
			{ id: 'b', match: 'matched' as const }
		];
		const r = compareDam(
			base({
				features,
				observations: [obs('2024-01-02', 2_000), obs('2024-01-02', 3_000, { featureId: 'b', pctObserved: 95 }), obs('2024-01-03', 2_000), obs('2024-01-02', 9_999, { featureId: 'elsewhere' })]
			})
		);
		expect(r.points.map((p) => [p.date, p.wetAreaM2, p.pctObserved, p.skip])).toEqual([
			['2024-01-02', 5_000, 95, null],
			['2024-01-03', 2_000, 100, 'partial-unit']
		]);
	});

	it('compares a Waterbodies view only for a polygon matched to this dam alone, and prefers WOfS on the same day', () => {
		const wb = (date: string, a: number) => obs(date, a, { source: 'waterbodies' });
		const matched = compareDam(base({ observations: [wb('2024-01-02', 5_000), wb('2024-01-03', 5_100), obs('2024-01-03', 5_200)] }));
		expect(matched.points.map((p) => [p.date, p.source, p.skip])).toEqual([
			['2024-01-02', 'waterbodies', null],
			['2024-01-03', 'waterbodies', 'other-source'],
			['2024-01-03', 'wofs', null]
		]);
		for (const match of ['merged', 'none', null] as const) {
			const r = compareDam(base({ features: [{ id: 'a', match }], observations: [wb('2024-01-02', 5_000), obs('2024-01-02', 5_000)] }));
			expect(r.points.map((p) => [p.source, p.skip])).toEqual([
				['waterbodies', 'not-this-dam'],
				['wofs', null]
			]);
		}
	});

	it('leaves out days outside the run and its forecast days, and keeps them as the latest clear view', () => {
		const r = compareDam(base({ forecastFrom: '2024-01-20', observations: [obs('2023-12-31', 1), obs('2024-01-15', 5_000), obs('2024-01-20', 5_000), obs('2024-02-01', 7_000)] }));
		expect(r.points.map((p) => p.skip)).toEqual(['outside-run', null, 'outside-run', 'outside-run']);
		expect(r.points[0]!.modelledAreaM2).toBeNull();
		expect(r.summary.latestClear).toEqual({ date: '2024-02-01', source: 'wofs', wetAreaM2: 7_000, pctObserved: 100 });
	});

	it('with no run, still lists the views and the latest clear one, with no flags or summary figures', () => {
		const r = compareDam(base({ modelled: null, full: null, observations: [obs('2024-01-02', 9_900), obs('2024-01-03', 0, { pctObserved: 50 })] }));
		expect(r.points.map((p) => [p.skip, p.seenFull, p.mismatch])).toEqual([
			['no-run', false, null],
			['partly-seen', false, null]
		]);
		expect(r.summary).toMatchObject({ compared: 0, skipped: 2, biasPctOfFull: null, withinShare: null, latestClear: { date: '2024-01-02' } });
	});

	it('counts the spill, empty and mismatch flags over the compared points', () => {
		const values = new Array(31).fill(9_800);
		values[3] = 300;
		const r = compareDam(base({ modelled: run(values), observations: [obs('2024-01-02', 9_700), obs('2024-01-03', 6_000), obs('2024-01-04', 3_000), obs('2024-01-05', 0, { pctObserved: 40 })] }));
		expect(r.points.map((p) => [p.date, p.seenFull, p.seenEmpty, p.mismatch])).toEqual([
			['2024-01-02', true, false, null],
			['2024-01-03', false, false, 'model-full'],
			['2024-01-04', false, false, 'model-empty'],
			['2024-01-05', false, false, null]
		]);
		expect(r.summary).toMatchObject({ compared: 3, skipped: 1, seenFull: 1, seenEmpty: 0, mismatches: 2 });
		expect(r.summary.withinShare).toBeCloseTo(1 / 3, 9);
	});

	it('pairs the run’s first and last day with their own values, and the days either side are outside it, in any zone', () => {
		// 31 days from 1 Jan 2024: index 0 on 1 Jan, index 30 on 31 Jan.
		const values = new Array(31).fill(5_000);
		values[0] = 1_000;
		values[30] = 9_000;
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
			process.env.TZ = zone;
			const r = compareDam(base({ modelled: run(values), observations: [obs('2023-12-31', 1_000), obs('2024-01-01', 1_000), obs('2024-01-31', 9_000), obs('2024-02-01', 9_000)] }));
			expect(
				r.points.map((p) => [p.date, p.modelledAreaM2, p.skip]),
				zone
			).toEqual([
				['2023-12-31', null, 'outside-run'],
				['2024-01-01', 1_000, null],
				['2024-01-31', 9_000, null],
				['2024-02-01', null, 'outside-run']
			]);
		}
		process.env.TZ = 'Pacific/Kiritimati';
	});

	it('is empty with no observations', () => {
		expect(compareDam(base({}))).toEqual({
			points: [],
			summary: { compared: 0, skipped: 0, biasPctOfFull: null, withinShare: null, seenFull: 0, seenEmpty: 0, mismatches: 0, latestClear: null }
		});
	});
});
