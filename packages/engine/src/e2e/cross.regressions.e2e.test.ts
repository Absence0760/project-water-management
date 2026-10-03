// Regression tests for the round-2 cross-feature bugs the engine end-to-end
// tests found (fixed in engine 1.69.0; bug 2 is errata ER-23, bug 1 changed no
// result a user reads), each pinned by the behaviour docs/model.md specifies.
// Synthetic values only.
//
// 1. A run resumed from a snapshot on or after a dam's in-service date
//    (§2.7g) drops the dam's `dam_capacity` column, which the uninterrupted
//    run carries: §2.16 promises every series, in the same order, to the bit.
// 2. A seasonal outlook (§2.15) on a full-allocation project (§2.12a) whose
//    decision date lies inside the base record (a hindcast): every member
//    from the snapshot keeps the base run's factor for the decision year,
//    fitted on that year's REAL days after the decision date. A member then
//    doesn't ask for its registered volume (§2.12a: a part year asks for the
//    prorated volume; the year a forecast tail starts in is fitted on its
//    historical days), it reads days after the decision date ("nothing after
//    the decision date is known", §2.15), and it differs from the older
//    re-run-the-history path, which §2.16 says the snapshot path equals but
//    for the listed record-wide statistics.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { runSeasonalOutlook } from '../outlook/outlook';
import { runReviewTriggers } from '../outlook/triggers';

const keys = (o: ModelOutput) => o.series.map((s) => `${s.nodeId}:${s.key}`);

describe('fixed in 1.69.0, cross bug 1: a resumed run keeps the dam_capacity column of a dam that came into service (§2.16, §2.7g)', () => {
	const X = testCatchment({ start: '2002-10-01', end: '2006-09-30', seed: 31, ewrM3Day: 600 });
	const input: ModelInput = { ...X, model: { ...X.model, nodes: X.model.nodes.map((n) => (n.id === 'b' ? { ...n, damInServiceFrom: '2004-02-29' } : n)) } };
	const full = runModelWithoutChecks(input);

	for (const at of ['2004-02-29', '2005-01-01']) {
		it(`resumed on ${at}: the same series as the uninterrupted run, dam_capacity included, equal on its days`, () => {
			expect(keys(full)).toContain('b:dam_capacity');
			const resumed = runModelFrom(captureModelState(input, at), input);
			expect(keys(resumed)).toEqual(keys(full));
			const k = toEpochDay(at) - toEpochDay(full.startDate);
			const cap = resumed.series.find((s) => s.nodeId === 'b' && s.key === 'dam_capacity')!.values;
			expect(cap).toEqual(full.series.find((s) => s.nodeId === 'b' && s.key === 'dam_capacity')!.values.slice(k));
		});
	}
});

describe('fixed in 1.69.0, cross bug 2: a full-allocation outlook in a hindcast asks each member for its registered volume (§2.15, §2.12a)', () => {
	const RAW = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
	const V = 200_000;
	const BASE: ModelInput = { ...RAW, settings: { ...RAW.settings, allocationMode: 'fullAllocation' }, model: { ...RAW.model, allocations: [{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: V }] } };
	const baseRun = runModelWithoutChecks(BASE);
	const levels = [{ id: '100', label: '100 %', ops: [] }];

	it('a season from 1 October: a member is a part year, asking for the volume over its days (V × 212 ÷ 365)', () => {
		const season = { decisionDate: '2008-10-01', seasonEnd: '2009-04-30' };
		const days = toEpochDay(season.seasonEnd) - toEpochDay(season.decisionDate) + 1;
		const warm = runSeasonalOutlook(BASE, { ...season, levels, baseRun });
		const bad = warm.levels[0]!.years.filter((y) => Math.abs(y.farms['a']!.demandM3 - (V * days) / 365) > 1e-6 * V).map((y) => `${y.label}: ${Math.round(y.farms['a']!.demandM3)}`);
		// Before the fix every member asked k(2008/09 of the real record) × its own demand, e.g. 212 213 m³ in
		// 212 days, more than the whole year's 200 000 m³.
		expect(bad, `want ${Math.round((V * days) / 365)}`).toEqual([]);
	});

	it('a season from 15 December: the snapshot path’s members ask what the older path’s do (the factor fitted on the days before the decision date)', () => {
		const season = { decisionDate: '2008-12-15', seasonEnd: '2009-04-30' };
		const warm = runSeasonalOutlook(BASE, { ...season, levels, baseRun });
		const cold = runSeasonalOutlook(BASE, { ...season, levels, baseRun, warmStart: false });
		const bad: string[] = [];
		for (const [i, y] of warm.levels[0]!.years.entries()) {
			const z = cold.levels[0]!.years[i]!;
			if (Math.abs(y.demandM3 - z.demandM3) > 1e-6 * z.demandM3) bad.push(`${y.label}: warm ${Math.round(y.demandM3)} vs cold ${Math.round(z.demandM3)}`);
		}
		expect(bad).toEqual([]);
	});

	it('the member’s decision-year factor reads no day on or after the decision date: two base records that differ only after it give the same members', () => {
		const season = { decisionDate: '2008-12-15', seasonEnd: '2009-04-30' };
		const rain = BASE.series.rain_catchment_mm!;
		const cut = toEpochDay(season.decisionDate) - toEpochDay(rain.startDate);
		// The same history, a different (wetter) record from the decision date on.
		const other: ModelInput = { ...BASE, series: { rain_catchment_mm: { startDate: rain.startDate, values: rain.values.map((v, t) => (t >= cut && v !== null ? v * 3 + 2 : v)) } } };
		// Control: with no allocation mode the two bases give the same members (the history is the same).
		const none = (x: ModelInput): ModelInput => ({ ...x, settings: { ...x.settings, allocationMode: 'none' } });
		const ca = runSeasonalOutlook(none(BASE), { ...season, levels, analogueYears: [2000, 2001, 2002] });
		const cb = runSeasonalOutlook(none(other), { ...season, levels, analogueYears: [2000, 2001, 2002] });
		expect(cb.levels[0]!.years.map((y) => y.demandM3)).toEqual(ca.levels[0]!.years.map((y) => y.demandM3));
		const a = runSeasonalOutlook(BASE, { ...season, levels, analogueYears: [2000, 2001, 2002] });
		const b = runSeasonalOutlook(other, { ...season, levels, analogueYears: [2000, 2001, 2002] });
		const da = a.levels[0]!.years.map((y) => y.demandM3);
		const db = b.levels[0]!.years.map((y) => y.demandM3);
		expect(db, `decision ${fromEpochDay(toEpochDay(season.decisionDate))}`).toEqual(da);
	});

	it('the review triggers (§2.15a) start from the same snapshot: a review in a hindcast reads no day on or after its review date either', () => {
		const reviewDate = '2008-12-15';
		const rain = BASE.series.rain_catchment_mm!;
		const cut = toEpochDay(reviewDate) - toEpochDay(rain.startDate);
		const other: ModelInput = { ...BASE, series: { rain_catchment_mm: { startDate: rain.startDate, values: rain.values.map((v, t) => (t >= cut && v !== null ? v * 3 + 2 : v)) } } };
		// Explicit band edges, so the bands don't come from the base run's storage on later years' review dates.
		const opts = { reviewDate, seasonEnd: '2009-04-30', levels, edgesM3: [150_000], analogueYears: [2000, 2001, 2002] };
		const demands = (x: ModelInput) => runReviewTriggers(x, opts).rows.map((r) => r.outlook.levels[0]!.years.map((y) => y.demandM3));
		expect(demands(other)).toEqual(demands(BASE));
	});
});
