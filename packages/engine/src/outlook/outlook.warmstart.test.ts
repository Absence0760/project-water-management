// The seasonal outlook and the review triggers from a snapshot of the base
// run (engine 1.1.0, docs/model.md §2.15, §2.15a, §2.16): the history runs
// once, and each member runs only the season. Against the older path, where
// every member re-runs the history, on the invented catchment.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import { ModelStateMismatchError } from '../warmstart/snapshot';
import { outlookAnalogues, outlookBaseAndSnapshot, outlookMember, outlookMemberInput, outlookSeasonInput, runOutlookMember, runSeasonalOutlook } from './outlook';
import { outlookAnalogue, resolveSeason, seasonWaterYear, type OutlookSeason } from './season';
import { testCatchment } from './testCatchment';
import { runReviewTriggers } from './triggers';

const SEASON: OutlookSeason = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const scale = (factor: number): ScenarioOp[] => [{ op: 'demand.scale', factor }];
const levels = (fs: number[]) => fs.map((f) => ({ id: `f${f}`, label: `${Math.round(f * 100)} %`, ops: scale(f) }));
const col = (out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;

const input = testCatchment({ dailyApan: true });
const base = runModelWithoutChecks(input);

describe('a member from the snapshot', () => {
	const snapshot = captureModelState(input, SEASON.decisionDate);
	const a = outlookAnalogue(resolveSeason(SEASON), 2005);

	it('outlookSeasonInput carries only the season: the analogue’s rain and A-pan from the decision date, the season’s window', () => {
		const m = outlookSeasonInput(input, base, SEASON, a, scale(0.85));
		expect(m.problems).toEqual([]);
		expect(Object.keys(m.input.series).sort()).toEqual(['evap_apan_mm', 'rain_forecast_mm']);
		const full = outlookMemberInput(input, base, SEASON, a, scale(0.85)).input;
		const from = toEpochDay(SEASON.decisionDate) - toEpochDay(full.series.rain_forecast_mm!.startDate);
		expect(m.input.series.rain_forecast_mm).toEqual({ startDate: SEASON.decisionDate, values: full.series.rain_forecast_mm!.values.slice(from) });
		expect(m.input.series.evap_apan_mm!.values).toEqual(full.series.evap_apan_mm!.values.slice(toEpochDay(SEASON.decisionDate) - toEpochDay(base.startDate)));
		expect(m.input.settings).toMatchObject({ simulationStart: SEASON.decisionDate, simulationEnd: SEASON.seasonEnd, demandFactorFrom: SEASON.decisionDate });
		expect(m.input.model).toEqual(full.model);
	});

	it('is the re-run member’s season to the bit, on every series', () => {
		const m = outlookSeasonInput(input, base, SEASON, a, scale(0.7));
		const warm = runModelFrom(snapshot, m.input);
		const cold = runModelWithoutChecks(outlookMemberInput(input, base, SEASON, a, scale(0.7)).input);
		const i0 = toEpochDay(SEASON.decisionDate) - toEpochDay(cold.startDate);
		for (const s of warm.series) {
			const c = col(cold, s.nodeId, s.key);
			// A column the season-only input has no series for (observed flow) isn't there; everything the member reads is.
			if (!c) continue;
			expect(s.values, `${s.nodeId}/${s.key}`).toEqual(c.slice(i0));
		}
		for (const k of ['demand', 'supplied', 'dam_storage']) expect(col(warm, 'a', k)).toBeDefined();
		expect(outlookMember(warm, m.input.model, SEASON, a)).toEqual(outlookMember(cold, m.input.model, SEASON, a));
	});

	it('runOutlookMember is those three steps, and refuses a snapshot of another day', () => {
		const one = runOutlookMember(snapshot, input, base, SEASON, a, scale(0.7));
		expect(one.problems).toEqual([]);
		const m = outlookSeasonInput(input, base, SEASON, a, scale(0.7));
		expect(one.member).toEqual(outlookMember(runModelFrom(snapshot, m.input), m.input.model, SEASON, a));
		expect(runOutlookMember(snapshot, input, base, SEASON, a, [{ op: 'demand.scale', factor: 0.5, nodeIds: ['nope'] }])).toMatchObject({ member: null });
		expect(() => runOutlookMember(captureModelState(input, '2012-09-01'), input, base, SEASON, a)).toThrow(/not the season's first day/);
	});

	it('refuses a snapshot of another input', () => {
		const other = structuredClone(input);
		other.model.nodes[1]!.damCapacityM3 = 200_000;
		expect(() => runOutlookMember(captureModelState(other, SEASON.decisionDate), input, base, SEASON, a)).toThrow(ModelStateMismatchError);
	});
});

describe('runSeasonalOutlook and runReviewTriggers from the snapshot', () => {
	it('the invented catchment’s outlook is the re-run path’s, to the bit (no record-wide statistic in play)', () => {
		const opts = { ...SEASON, baseRun: base, levels: levels([1, 0.85, 0.7, 0.55]) };
		expect(runSeasonalOutlook(input, opts)).toEqual(runSeasonalOutlook(input, { ...opts, warmStart: false }));
		// A season across 1 October and one from 29 February, too.
		for (const season of [{ decisionDate: '2011-09-01', seasonEnd: '2012-03-31' }, { decisionDate: '2012-02-29', seasonEnd: '2012-06-30' }]) {
			const o = { ...season, baseRun: base, levels: levels([1, 0.7]) };
			expect(runSeasonalOutlook(input, o), season.decisionDate).toEqual(runSeasonalOutlook(input, { ...o, warmStart: false }));
		}
	});

	it('the actual year as the analogue reproduces the base run’s season', () => {
		const own = outlookAnalogues(base, SEASON, [seasonWaterYear(SEASON)]).analogues[0]!;
		const r = runOutlookMember(captureModelState(input, SEASON.decisionDate), input, base, SEASON, own, scale(1));
		const last = toEpochDay(SEASON.seasonEnd) - toEpochDay(base.startDate);
		expect(r.member!.seasonEndStorageM3).toBe(col(base, 'a', 'dam_storage')![last]! + col(base, 'b', 'dam_storage')![last]!);
	});

	it('the triggers are the re-run path’s, to the bit, with the band’s storage set in the snapshot', () => {
		const opts = { reviewDate: '2013-01-01', seasonEnd: SEASON.seasonEnd, baseRun: base, levels: levels([1, 0.85, 0.7]) };
		const warm = runReviewTriggers(input, opts);
		expect(warm).toEqual(runReviewTriggers(input, { ...opts, warmStart: false }));
		expect(warm.rows).toHaveLength(3);
		// A snapshot given is used as it is.
		expect(runReviewTriggers(input, { ...opts, snapshot: captureModelState(input, '2013-01-01') })).toEqual(warm);
		expect(() => runReviewTriggers(input, { ...opts, snapshot: captureModelState(input, '2012-12-01') })).toThrow(/not 2013-01-01/);
	});

	it('runs the base and the snapshot in one run when neither is given', () => {
		const got = outlookBaseAndSnapshot(input, SEASON.decisionDate);
		expect(got.baseRun).toEqual(base);
		expect(got.snapshot).toEqual(captureModelState(input, SEASON.decisionDate));
		// A decision date the run doesn't reach: no snapshot, and the member builders say why.
		const late = { decisionDate: '2014-10-01', seasonEnd: '2015-04-30' };
		expect(outlookBaseAndSnapshot(input, late.decisionDate).snapshot).toBeNull();
		expect(() => runSeasonalOutlook(input, { ...late, levels: levels([1]), analogueYears: [2004] })).toThrow(/the state there isn't known/);
	});
});

describe('with record-wide statistics in play (land cover, a Reserve rule table)', () => {
	const x = testCatchment({ dailyApan: true, recordWide: true });
	const xBase = runModelWithoutChecks(x);
	const opts = { ...SEASON, baseRun: xBase, levels: levels([1, 0.85, 0.7, 0.55]) };
	const warm = runSeasonalOutlook(x, opts);
	const cold = runSeasonalOutlook(x, { ...opts, warmStart: false });

	it('a member reads the base run’s statistics, where a re-run member refits them on its history before the decision date', () => {
		const a = outlookAnalogue(resolveSeason(SEASON), 2005);
		const snap = captureModelState(x, SEASON.decisionDate);
		const w = runModelFrom(snap, outlookSeasonInput(x, xBase, SEASON, a, scale(0.85)).input);
		const c = runModelWithoutChecks(outlookMemberInput(x, xBase, SEASON, a, scale(0.85)).input);
		expect(w.summary.landCover!.lowFlowThresholdM3Day).toBe(xBase.summary.landCover!.lowFlowThresholdM3Day);
		expect(c.summary.landCover!.lowFlowThresholdM3Day).not.toBe(xBase.summary.landCover!.lowFlowThresholdM3Day);
		const curves = (o: ModelOutput) => o.summary.ewrAssurance![0]!.byMonth.map((m) => m.naturalCurve);
		expect(curves(w)).toEqual(curves(xBase));
		expect(curves(c)).not.toEqual(curves(xBase));
	});

	it('moves the outlook by what model.md §2.16 records: storage under 0.1 %, a few Reserve months', () => {
		expect(warm.metric).toBe('reserveMonthsMet');
		let months = 0;
		let moved = 0;
		for (const [i, l] of cold.levels.entries()) {
			for (const [k, y] of l.years.entries()) {
				const z = warm.levels[i]!.years[k]!;
				expect(Math.abs(z.seasonEndStorageM3! - y.seasonEndStorageM3!)).toBeLessThan(1e-3 * y.seasonEndStorageM3!);
				expect(Math.abs(z.demandMet! - y.demandMet!)).toBeLessThan(1e-4);
				months += y.ewr.units;
				moved += Math.abs(z.ewr.count - y.ewr.count);
			}
		}
		expect(months).toBe(4 * 12 * 7);
		// 16 of the 336 level-year-months: the pinned curves rank the base run's whole record, a
		// re-run member's the history before the decision date (engine ≥ 1.28.0: the analogue
		// season is a forecast tail, which no record-wide statistic reads; 9 before, when the
		// re-run member's curves took in the season too).
		expect(moved).toBe(16);
		expect(warm.levels.map((l) => l.yearsEwrMet)).toEqual([4, 5, 5, 4]);
		expect(cold.levels.map((l) => l.yearsEwrMet)).toEqual([10, 8, 8, 8]);
	});
});
