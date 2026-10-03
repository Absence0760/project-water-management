// End-to-end: the seasonal outlook (docs/model.md §2.15, §2.16). Each
// ensemble member must be a plain run with shifted climate: the base input's
// rain up to the day before the decision date, then the base run's
// rain_final on the analogue's days (the day mapping of §2.15, 29 February
// → 28 February in a common year), the run ending on the season end, the
// level's demand factor from the decision date. Here that plain run is built
// by hand and run with runModel; the member (from a snapshot) must equal its
// season days, and the outlook's figures (season-end storage, demand met,
// days below the EWR, percentiles type 7, years met, the planning figure)
// must equal what those plain runs give. Synthetic catchment.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { runModelWithoutChecks } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { outlookAnalogues, outlookSeasonInput, runSeasonalOutlook } from '../outlook/outlook';
import { captureModelState, runModelFrom } from '../run';

function series(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The analogue's first day for water year W (§2.15): the decision date's month and day in W (Oct–Dec) or W + 1 (Jan–Sep). */
function handAnalogueStart(decisionDate: string, wy: number): number {
	const [, m, d] = decisionDate.split('-').map(Number) as [number, number, number];
	const y = m >= 10 ? wy : wy + 1;
	const day = m === 2 && d === 29 && !isLeap(y) ? 28 : d;
	return toEpochDay(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/** The plain run a member stands for, built by hand. */
function plainMemberInput(base: ModelInput, baseRun: ModelOutput, decisionDate: string, seasonEnd: string, wy: number, factor: number): ModelInput {
	const from = toEpochDay(decisionDate);
	const days = toEpochDay(seasonEnd) - from + 1;
	const rain = base.series.rain_catchment_mm!;
	const r0 = toEpochDay(rain.startDate);
	const history = rain.values.slice(0, from - r0);
	const rf = series(baseRun, null, 'rain_final');
	const a = handAnalogueStart(decisionDate, wy) - toEpochDay(baseRun.startDate);
	const season = rf.slice(a, a + days);
	expect(season).toHaveLength(days);
	return {
		...base,
		settings: { ...base.settings, simulationEnd: seasonEnd, ...(factor !== 1 ? { demandFactorFrom: decisionDate } : {}) },
		model: factor === 1 ? base.model : { ...base.model, nodes: base.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, demandFactor: new Array(12).fill(factor) } : n)) },
		series: { rain_catchment_mm: { startDate: rain.startDate, values: [...history, ...season] } }
	};
}

/** Type 7 percentile of sorted values. */
function q7(sorted: number[], p: number): number {
	const h = (sorted.length - 1) * (p / 100);
	const lo = Math.floor(h);
	return lo + 1 < sorted.length ? sorted[lo]! + (h - lo) * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}

const BASE = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
const SEASONS: [string, string, string][] = [
	['the default season', '2008-10-01', '2009-04-30'],
	['a season from 29 February', '2008-02-29', '2008-08-31'],
	['a season across 1 October', '2007-09-01', '2008-03-31']
];
const KEYS: [string | null, string][] = [
	[null, 'natural_flow'],
	[null, 'simulated_outflow'],
	[null, 'ewr_shortfall'],
	['a', 'demand'],
	['a', 'supplied'],
	['a', 'dam_storage'],
	['b', 'demand'],
	['b', 'supplied'],
	['b', 'dam_storage']
];

describe('outputs e2e: outlook members are plain runs with shifted climate (§2.15)', () => {
	const baseRun = runModelWithoutChecks(BASE);
	for (const [name, decisionDate, seasonEnd] of SEASONS) {
		it(`${name}: every analogue at 100 % and 70 %, the member’s season equals the plain run’s`, () => {
			const season = { decisionDate, seasonEnd };
			const { analogues, excluded } = outlookAnalogues(baseRun, season);
			// The season's own water year is not an analogue in a hindcast.
			const own = excluded.find((e) => e.reason === 'theSeason');
			expect(own).toBeDefined();
			expect(analogues.length).toBeGreaterThanOrEqual(10);
			const snap = captureModelState(BASE, decisionDate);
			const d0 = toEpochDay(baseRun.startDate);
			const k = toEpochDay(decisionDate) - d0;
			const problems: string[] = [];
			for (const a of analogues) {
				expect(toEpochDay(a.from), `${a.label} start`).toBe(handAnalogueStart(decisionDate, a.waterYear));
				for (const f of [1, 0.7]) {
					const ops = f === 1 ? [] : [{ op: 'demand.scale' as const, factor: f }];
					const member = runModelFrom(snap, outlookSeasonInput(BASE, baseRun, season, a, ops).input);
					const plain = runModelWithoutChecks(plainMemberInput(BASE, baseRun, decisionDate, seasonEnd, a.waterYear, f));
					expect(plain.endDate).toBe(seasonEnd);
					for (const [n, key] of KEYS) {
						const m = series(member, n, key);
						const p = series(plain, n, key).slice(k);
						for (let t = 0; t < m.length; t++) {
							if (!Object.is(m[t], p[t])) {
								problems.push(`${a.label} ×${f} ${n}:${key} ${fromEpochDay(toEpochDay(decisionDate) + t)}: member ${m[t]} vs plain ${p[t]}`);
								break;
							}
						}
					}
				}
			}
			expect(problems.slice(0, 10)).toEqual([]);
		});
	}

	it('a forecast, not a hindcast: the record ends the day before the decision date (snapshot of the day after the run), members still equal plain runs', () => {
		const short = testCatchment({ start: '1996-10-01', end: '2008-09-30', seed: 7, ewrM3Day: 900 });
		const shortRun = runModelWithoutChecks(short);
		const season = { decisionDate: '2008-10-01', seasonEnd: '2009-04-30' };
		const { analogues, excluded } = outlookAnalogues(shortRun, season);
		// The season's own year lies wholly past the record: not a candidate at all, so not listed.
		expect(excluded.some((e) => e.waterYear === 2008)).toBe(false);
		expect(analogues.map((a) => a.waterYear)).toEqual(Array.from({ length: 12 }, (_, i) => 1996 + i));
		const snap = captureModelState(short, season.decisionDate);
		const k = shortRun.days;
		const problems: string[] = [];
		for (const a of analogues) {
			const member = runModelFrom(snap, outlookSeasonInput(short, shortRun, season, a).input);
			const plain = runModelWithoutChecks(plainMemberInput(short, shortRun, season.decisionDate, season.seasonEnd, a.waterYear, 1));
			// The plain run's history is the base run itself.
			expect(series(plain, 'a', 'dam_storage').slice(0, k)).toEqual(series(shortRun, 'a', 'dam_storage'));
			for (const [n, key] of KEYS) {
				const m = series(member, n, key);
				const p = series(plain, n, key).slice(k);
				const t = m.findIndex((v, i) => !Object.is(v, p[i]));
				if (t >= 0) problems.push(`${a.label} ${n}:${key} day ${t}: ${m[t]} vs ${p[t]}`);
			}
		}
		expect(problems).toEqual([]);
		// The whole outlook on this base: the start storage is the record's last day's.
		const o = runSeasonalOutlook(short, { ...season, levels: [{ id: '100', label: '100 %', ops: [] }] });
		expect(o.startStorageM3).toBe(series(shortRun, 'a', 'dam_storage')[k - 1]! + series(shortRun, 'b', 'dam_storage')[k - 1]!);
		expect(o.nYears).toBe(12);
	});

	it('the outlook’s per-level figures are the plain runs’: storage, demand met, days below, percentiles, years met, planning figure', () => {
		const [, decisionDate, seasonEnd] = SEASONS[0]!;
		const levels = [
			{ id: '100', label: '100 %', ops: [] },
			{ id: '85', label: '85 %', ops: [{ op: 'demand.scale' as const, factor: 0.85 }] },
			{ id: '50', label: '50 %', ops: [{ op: 'demand.scale' as const, factor: 0.5 }] }
		];
		const o = runSeasonalOutlook(BASE, { decisionDate, seasonEnd, levels, baseRun });
		expect(o.metric).toBe('daysBelowEwr');
		const k = toEpochDay(decisionDate) - toEpochDay(baseRun.startDate);
		const storageBefore = series(baseRun, 'a', 'dam_storage')[k - 1]! + series(baseRun, 'b', 'dam_storage')[k - 1]!;
		expect(o.startStorageM3).toBe(storageBefore);
		const ranked: { id: string; mean: number; met: number }[] = [];
		for (const [li, l] of levels.entries()) {
			const f = l.ops.length ? l.ops[0]!.factor : 1;
			const res = o.levels[li]!;
			const storage: number[] = [];
			const met: number[] = [];
			let yearsMet = 0;
			let meanDemand = 0;
			for (const [yi, a] of o.analogues.entries()) {
				const plain = runModelWithoutChecks(plainMemberInput(BASE, baseRun, decisionDate, seasonEnd, a.waterYear, f));
				const last = plain.days - 1;
				let D = 0;
				let G = 0;
				for (const id of ['a', 'b']) {
					D += series(plain, id, 'demand').slice(k).reduce((s, v) => s + v, 0);
					G += series(plain, id, 'supplied').slice(k).reduce((s, v) => s + v, 0);
				}
				const below = series(plain, null, 'ewr_shortfall').slice(k).filter((v) => v < 0).length;
				const st = series(plain, 'a', 'dam_storage')[last]! + series(plain, 'b', 'dam_storage')[last]!;
				const y = res.years[yi]!;
				expect(y.seasonEndStorageM3!).toBeCloseTo(st, 6);
				expect(y.demandM3).toBeCloseTo(D, 4);
				expect(y.suppliedM3).toBeCloseTo(G, 4);
				expect(y.ewrDays).toEqual({ days: plain.days - k, below });
				expect(y.ewr.met).toBe(below === 0);
				storage.push(st);
				met.push(G / D);
				if (below === 0) yearsMet++;
				meanDemand += D / o.analogues.length;
			}
			storage.sort((p, q) => p - q);
			met.sort((p, q) => p - q);
			expect(res.seasonEndStorageM3!.p10).toBeCloseTo(q7(storage, 10), 4);
			expect(res.seasonEndStorageM3!.p50).toBeCloseTo(q7(storage, 50), 4);
			expect(res.seasonEndStorageM3!.p90).toBeCloseTo(q7(storage, 90), 4);
			expect(res.demandMet!.p50).toBeCloseTo(q7(met, 50), 10);
			expect(res.yearsEwrMet).toBe(yearsMet);
			expect(res.meanDemandM3!).toBeCloseTo(meanDemand, 3);
			ranked.push({ id: l.id, mean: meanDemand, met: yearsMet });
		}
		// The planning figure: the highest demand level meeting the requirement in ≥ 80 % of years.
		ranked.sort((p, q) => q.mean - p.mean);
		const pick = ranked.find((r) => r.met >= 0.8 * o.analogues.length - 1e-9);
		expect(o.planning.levelId).toBe(pick?.id ?? null);
		expect(o.planning.reason).toBe(pick ? 'met' : 'noLevelMeets');
	});
});

describe('outputs e2e: the default season and review date (§2.15, §2.15a)', () => {
	it('defaultOutlookSeason: the next 1 October to 30 April on or after the day', async () => {
		const { defaultOutlookSeason } = await import('../outlook/season');
		expect(defaultOutlookSeason('2026-09-26')).toEqual({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
		expect(defaultOutlookSeason('2026-10-01')).toEqual({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' });
		expect(defaultOutlookSeason('2026-10-02')).toEqual({ decisionDate: '2027-10-01', seasonEnd: '2028-04-30' });
		expect(defaultOutlookSeason('2028-02-29')).toEqual({ decisionDate: '2028-10-01', seasonEnd: '2029-04-30' });
	});
	it('defaultReviewDate: the first of the month holding the middle day, or the middle day when that month starts on or before the decision date', async () => {
		const { defaultReviewDate } = await import('../outlook/triggers');
		// 212 days: the middle day is 14 January → 1 January.
		expect(defaultReviewDate({ decisionDate: '2026-10-01', seasonEnd: '2027-04-30' })).toBe('2027-01-01');
		// A leap season of 213 days from 1 Oct 2027 to 30 Apr 2028: middle day 15 January → 1 January.
		expect(defaultReviewDate({ decisionDate: '2027-10-01', seasonEnd: '2028-04-30' })).toBe('2028-01-01');
		// 27 days inside October: the month starts before the decision date, so the middle day itself (15 + 13 = 28 October).
		expect(defaultReviewDate({ decisionDate: '2026-10-15', seasonEnd: '2026-11-10' })).toBe('2026-10-28');
		// From 29 February to 31 August 2028 (185 days): middle day 31 May → 1 May.
		expect(defaultReviewDate({ decisionDate: '2028-02-29', seasonEnd: '2028-08-31' })).toBe('2028-05-01');
	});
});
