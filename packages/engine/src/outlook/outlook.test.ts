// The seasonal outlook (issue #53 R5, docs/model.md §2.15), on an invented
// catchment (./testCatchment.ts) and on hand-made members.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { EwrAssuranceMonth, EwrAssuranceSite } from '../reserve/assurance';
import type { ModelOutput } from '../project';
import { runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import {
	DEFAULT_PLANNING_SHARE,
	describePlanningFigure,
	OUTLOOK_MIN_YEARS,
	outlookAnalogues,
	outlookLevelProblems,
	outlookMember,
	outlookMemberInput,
	runSeasonalOutlook,
	summariseOutlook,
	type OutlookMember,
	type OutlookSummaryInput
} from './outlook';
import { outlookAnalogue, resolveSeason, seasonWaterYear, type OutlookSeason } from './season';
import { testCatchment } from './testCatchment';

const SEASON: OutlookSeason = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const scale = (factor: number, extra: Partial<Extract<ScenarioOp, { op: 'demand.scale' }>> = {}): ScenarioOp[] => [{ op: 'demand.scale', factor, ...extra }];
const levels = (fs: number[]) => fs.map((f) => ({ id: `f${f}`, label: `${Math.round(f * 100)} %`, ops: scale(f) }));
const col = (out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;

const input = testCatchment({ dailyApan: true });
const base = runModelWithoutChecks(input);

describe('a member continues the base run from the decision date', () => {
	const seasons: [string, OutlookSeason][] = [
		['the default season', SEASON],
		['a season crossing 1 October', { decisionDate: '2011-09-01', seasonEnd: '2012-03-31' }],
		['a season from 29 February', { decisionDate: '2012-02-29', seasonEnd: '2012-06-30' }]
	];
	for (const [name, season] of seasons) {
		it(`factor 1 with the actual year as the analogue reproduces the base run: ${name}`, () => {
			const s = resolveSeason(season);
			const own = outlookAnalogues(base, season, [seasonWaterYear(season)]).analogues;
			expect(own).toHaveLength(1);
			expect(own[0]).toMatchObject({ from: season.decisionDate, to: season.seasonEnd });
			const m = outlookMemberInput(input, base, season, own[0]!, scale(1));
			expect(m.problems).toEqual([]);
			const out = runModelWithoutChecks(m.input);
			expect(out.startDate).toBe(base.startDate);
			expect(out.endDate).toBe(season.seasonEnd);
			const last = s.to - toEpochDay(base.startDate);
			const keys: [string | null, string][] = [
				[null, 'natural_flow'],
				[null, 'simulated_outflow'],
				[null, 'ewr_shortfall'],
				...['a', 'b'].flatMap((id) => ['demand', 'supplied', 'dam_storage', 'outflow'].map((k) => [id, k] as [string, string]))
			];
			for (const [id, k] of keys) {
				const want = col(base, id, k)!.slice(0, last + 1);
				const got = col(out, id, k)!;
				expect(got.length, `${id}/${k}`).toBe(want.length);
				for (let t = 0; t < want.length; t++) expect(Math.abs(got[t]! - want[t]!), `${id}/${k} day ${t}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want[t]!)));
			}
			const member = outlookMember(out, m.input.model, season, own[0]!);
			expect(member.seasonEndStorageM3).toBeCloseTo(col(base, 'a', 'dam_storage')![last]! + col(base, 'b', 'dam_storage')![last]!, 6);
		});
	}

	it('keeps the history of every level the same and scales demand only from the decision date', () => {
		const s = resolveSeason(SEASON);
		const a = outlookAnalogue(s, 2004);
		const [full, half] = [1, 0.5].map((f) => {
			const m = outlookMemberInput(input, base, SEASON, a, scale(f));
			return runModelWithoutChecks(m.input);
		});
		const i0 = s.from - toEpochDay(base.startDate);
		for (const x of full!.series) expect(col(half!, x.nodeId, x.key)!.slice(0, i0), `${x.nodeId}/${x.key}`).toEqual(x.values.slice(0, i0));
		const [D1, D5] = [col(full!, 'a', 'demand')!, col(half!, 'a', 'demand')!];
		let days = 0;
		for (let t = i0; t < D1.length; t++) {
			expect(Math.abs(D5[t]! - 0.5 * D1[t]!)).toBeLessThanOrEqual(1e-9 * Math.max(1, D1[t]!));
			if (D1[t]! > 0) days++;
		}
		expect(days).toBeGreaterThan(100);
	});

	it('drives the season with the analogue’s rain and daily A-pan, cutting every series at the decision date', () => {
		const s = resolveSeason(SEASON);
		const a = outlookAnalogue(s, 2005);
		const m = outlookMemberInput(input, base, SEASON, a).input;
		const d0 = toEpochDay(base.startDate);
		const aFrom = toEpochDay(a.from) - d0;
		expect(m.series.rain_catchment_mm!.values).toHaveLength(s.from - d0);
		const f = m.series.rain_forecast_mm!;
		expect(f.startDate).toBe(SEASON.decisionDate);
		expect(f.values).toEqual(col(base, null, 'rain_final')!.slice(aFrom, aFrom + s.days));
		const ev = m.series.evap_apan_mm!;
		expect(ev.startDate).toBe(base.startDate);
		expect(ev.values.slice(0, s.from - d0)).toEqual(input.series.evap_apan_mm!.values.slice(0, s.from - d0));
		expect(ev.values.slice(s.from - d0)).toEqual(input.series.evap_apan_mm!.values.slice(aFrom, aFrom + s.days));
		expect(m.settings).toMatchObject({ simulationStart: base.startDate, simulationEnd: SEASON.seasonEnd, demandFactorFrom: SEASON.decisionDate });
	});

	it('clips rain-source periods to the history', () => {
		const withPeriods = {
			...input,
			settings: {
				...input.settings,
				rainSource: [
					{ start: '2005-01-01', end: '2006-01-01', series: 'rain_catchment_alt_mm' as const, factors: new Array<number>(12).fill(1), reason: 'test' },
					{ start: '2012-06-01', end: '2013-01-31', series: 'rain_catchment_alt_mm' as const, factors: new Array<number>(12).fill(1), reason: 'test' },
					{ start: '2012-11-01', end: '2013-01-31', series: 'rain_catchment_alt_mm' as const, factors: new Array<number>(12).fill(1), reason: 'test' }
				]
			}
		};
		const m = outlookMemberInput(withPeriods, base, SEASON, outlookAnalogue(resolveSeason(SEASON), 2004)).input;
		expect(m.settings.rainSource!.map((p) => [p.start, p.end])).toEqual([
			['2005-01-01', '2006-01-01'],
			['2012-06-01', '2012-09-30']
		]);
	});

	it('refuses a base that carries a demand factor, a run that stops short of the decision date, and no history', () => {
		const a = outlookAnalogue(resolveSeason(SEASON), 2004);
		const scaled = { ...input, model: { ...input.model, nodes: input.model.nodes.map((n) => (n.id === 'a' ? { ...n, demandFactor: new Array(12).fill(0.9) } : n)) } };
		expect(() => outlookMemberInput(scaled, base, SEASON, a)).toThrow(/demand factor/);
		// A part's factor (engine ≥ 1.45.0) likewise.
		const byPart = { ...input, model: { ...input.model, nodes: input.model.nodes.map((n) => (n.id === 'a' ? { ...n, partDemandFactor: { domestic: new Array(12).fill(0.9) } } : n)) } };
		expect(() => outlookMemberInput(byPart, base, SEASON, a)).toThrow(/demand factor/);
		const short = { ...base, days: toEpochDay('2012-09-29') - toEpochDay(base.startDate) + 1 };
		expect(() => outlookMemberInput(input, short, SEASON, a)).toThrow(/before 2012-09-30/);
		expect(() => outlookMemberInput(input, base, { decisionDate: base.startDate, seasonEnd: '2001-04-30' }, a)).toThrow(/no history/);
	});
});

describe('analogue years', () => {
	it('by default: every water year the record holds but the season’s own', () => {
		const { analogues, excluded } = outlookAnalogues(base, SEASON);
		expect(analogues.map((a) => a.waterYear)).toEqual([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011]);
		expect(excluded).toEqual([{ waterYear: 2012, reason: 'theSeason' }]);
	});

	it('lists a stretch the record only partly holds, and one with a day of no rain', () => {
		const cut = { ...base, startDate: '2000-12-01', days: base.days - 61, series: base.series.map((s) => ({ ...s, values: s.values.slice(61) })) };
		const holed = { ...cut, series: cut.series.map((s) => (s.key === 'rain_final' ? { ...s, values: s.values.map((v, t) => (fromEpochDay(toEpochDay(cut.startDate) + t) === '2005-11-11' ? NaN : v)) } : s)) };
		const r = outlookAnalogues(holed, SEASON);
		expect(r.excluded).toEqual([
			{ waterYear: 2000, reason: 'outsideRecord' },
			{ waterYear: 2005, reason: 'missingRain' },
			{ waterYear: 2012, reason: 'theSeason' }
		]);
		expect(r.analogues.map((a) => a.waterYear)).toEqual([2001, 2002, 2003, 2004, 2006, 2007, 2008, 2009, 2010, 2011]);
	});

	it('as listed: in order, the season’s own allowed, the rest flagged', () => {
		const r = outlookAnalogues(base, SEASON, [2005, 2012, 2005, 1990, 2003.5, 2001]);
		expect(r.analogues.map((a) => a.waterYear)).toEqual([2005, 2012, 2001]);
		expect(r.excluded).toEqual([
			{ waterYear: 2005, reason: 'duplicate' },
			{ waterYear: 1990, reason: 'outsideRecord' },
			{ waterYear: 2003.5, reason: 'notAYear' }
		]);
	});
});

describe('runSeasonalOutlook on the invented catchment', () => {
	const outlook = runSeasonalOutlook(input, { ...SEASON, baseRun: base, levels: levels([1, 0.85, 0.7]) });

	it('reports every level over every analogue year, with its percentiles', () => {
		expect(outlook.nYears).toBe(12);
		expect(outlook.enoughYears).toBe(true);
		expect(outlook.metric).toBe('daysBelowEwr');
		expect(outlook.capacityM3).toBe(450_000);
		expect(outlook.startStorageM3).toBeCloseTo(col(base, 'a', 'dam_storage')![toEpochDay('2012-09-30') - toEpochDay(base.startDate)]! + col(base, 'b', 'dam_storage')![toEpochDay('2012-09-30') - toEpochDay(base.startDate)]!, 6);
		for (const l of outlook.levels) {
			expect(l.problems).toEqual([]);
			expect(l.years.map((y) => y.waterYear)).toEqual(outlook.analogues.map((a) => a.waterYear));
			for (const st of [l.seasonEndStorageM3!, l.demandMet!, l.ewr!]) {
				expect(st.p10).toBeLessThanOrEqual(st.p50);
				expect(st.p50).toBeLessThanOrEqual(st.p90);
			}
			expect(l.storageByDam.map((d) => d.nodeId)).toEqual(['a', 'b']);
			for (const y of l.years) {
				expect(y.seasonEndStorageM3).toBeCloseTo(y.storageM3ByDam.a! + y.storageM3ByDam.b!, 6);
				expect(y.ewr.units).toBe(212);
				expect(y.demandMet!).toBeLessThanOrEqual(1 + 1e-12);
			}
			expect(l.userDemandMet).toBeNull();
		}
		// A lower demand level takes less, and leaves the dams no lower, in every year.
		const [l1, l85, l70] = outlook.levels;
		expect(l1!.meanDemandM3!).toBeGreaterThan(l85!.meanDemandM3!);
		for (let i = 0; i < 12; i++) expect(l70!.years[i]!.seasonEndStorageM3!).toBeGreaterThanOrEqual(l1!.years[i]!.seasonEndStorageM3! - 1e-6);
	});

	it('is deterministic, and the same under a skewed TZ', () => {
		const opts = { ...SEASON, baseRun: base, levels: levels([1, 0.7]), analogueYears: [2003, 2004, 2011] };
		const utc = runSeasonalOutlook(input, opts);
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(runSeasonalOutlook(input, opts)).toEqual(utc);
			}
		} finally {
			process.env.TZ = tz;
		}
	});

	it('runs the base itself when no base run is given', () => {
		const opts = { ...SEASON, levels: levels([0.85]), analogueYears: [2004, 2008] };
		expect(runSeasonalOutlook(input, opts)).toEqual(runSeasonalOutlook(input, { ...opts, baseRun: base }));
	});

	it('flags too few analogue years: no percentiles and no planning figure, every year kept', () => {
		const o = runSeasonalOutlook(input, { ...SEASON, baseRun: base, levels: levels([1]), analogueYears: [2001, 2002, 2003] });
		expect(o.enoughYears).toBe(false);
		expect(o.levels[0]!.years).toHaveLength(3);
		expect(o.levels[0]!.seasonEndStorageM3).toBeNull();
		expect(o.levels[0]!.storageByDam[0]!.stat).toBeNull();
		expect(o.planning.reason).toBe('notEnoughYears');
		expect(o.warnings).toContain(`Only 3 analogue years: at least ${OUTLOOK_MIN_YEARS} are needed for percentiles and a planning figure.`);
		expect(describePlanningFigure(o)).toBe(`Only 3 analogue years in the record: not enough to judge (at least ${OUTLOOK_MIN_YEARS} are needed).`);
	});

	it('reports a level whose ops are not all demand.scale, or do not apply, without running it', () => {
		const o = runSeasonalOutlook(input, {
			...SEASON,
			baseRun: base,
			analogueYears: [2004],
			levels: [
				{ id: 'dam', label: 'Bigger dam', ops: [{ op: 'node.set', nodeId: 'a', field: 'damCapacityM3', value: 1e6 }] },
				{ id: 'ghost', label: 'Ghost farm', ops: scale(0.8, { nodeIds: ['nope'] }) },
				{ id: 'ok', label: '80 %', ops: scale(0.8) }
			]
		});
		expect(o.levels.map((l) => [l.id, l.problems.length > 0, l.years.length])).toEqual([
			['dam', true, 0],
			['ghost', true, 0],
			['ok', false, 1]
		]);
		expect(o.levels[0]!.problems[0]).toMatch(/only demand.scale ops/);
		expect(o.planning.ranked.map((r) => r.levelId)).toEqual(['ok']);
		expect(outlookLevelProblems({ id: 'x', label: 'x', ops: scale(1) })).toEqual([]);
	});

	it('a monthly plan (R1’s months form) scales only its months of the season', () => {
		const o = runSeasonalOutlook(input, { ...SEASON, baseRun: base, analogueYears: [2004], levels: [{ id: 'flat', label: '100 %', ops: [] }, { id: 'taper', label: 'Taper', ops: scale(0.5, { months: [3, 4] }) }] });
		const [flat, taper] = o.levels;
		expect(taper!.years[0]!.demandM3).toBeLessThan(flat!.years[0]!.demandM3);
		expect(taper!.years[0]!.demandM3).toBeGreaterThan(0.5 * flat!.years[0]!.demandM3);
	});
});

describe('each farm’s own demand met (engine 1.19.0, the farmer view E3)', () => {
	const o = runSeasonalOutlook(input, { ...SEASON, levels: levels([1, 0.5]) });

	it('a member’s farms add up to its catchment demand and supply', () => {
		for (const l of o.levels) {
			for (const y of l.years) {
				const farms = Object.values(y.farms);
				expect(farms.reduce((a, f) => a + f.demandM3, 0)).toBeCloseTo(y.demandM3, 6);
				expect(farms.reduce((a, f) => a + f.suppliedM3, 0)).toBeCloseTo(y.suppliedM3, 6);
				for (const f of farms) expect(f.suppliedM3).toBeLessThanOrEqual(f.demandM3 + 1e-6);
			}
		}
	});

	it('each farm’s statistic is its own supplied ÷ demand across the years, in 0–1', () => {
		expect(o.enoughYears).toBe(true);
		for (const l of o.levels) {
			expect(l.demandMetByFarm.map((f) => f.nodeId).sort()).toEqual(['a', 'b']);
			for (const f of l.demandMetByFarm) {
				const own = l.years.flatMap((y) => (y.farms[f.nodeId] ? [y.farms[f.nodeId]!.suppliedM3 / y.farms[f.nodeId]!.demandM3] : []));
				expect(f.nYears).toBe(own.length);
				if (f.nYears < OUTLOOK_MIN_YEARS) expect(f.stat).toBeNull();
				else {
					expect(f.stat!.p10).toBeLessThanOrEqual(f.stat!.p50);
					expect(f.stat!.p50).toBeLessThanOrEqual(f.stat!.p90);
					expect(f.stat!.p10).toBeGreaterThanOrEqual(Math.min(...own) - 1e-12);
					expect(f.stat!.p90).toBeLessThanOrEqual(Math.max(...own) + 1e-12);
					expect(f.stat!.p90).toBeLessThanOrEqual(1 + 1e-9);
				}
			}
		}
	});

	it('a farm with no demand in any year has no row', () => {
		const r = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: years(10).map((w) => member(w, { farms: { a: { demandM3: 100, suppliedM3: 80 } } })) }]));
		expect(r.levels[0]!.demandMetByFarm).toHaveLength(1);
		expect(r.levels[0]!.demandMetByFarm[0]).toMatchObject({ nodeId: 'a', name: 'Farm A', nYears: 10 });
		expect(r.levels[0]!.demandMetByFarm[0]!.stat!.p50).toBeCloseTo(0.8, 12);
		// Fewer years with demand than the minimum: counted, no statistic.
		const few = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: years(10).map((w, i) => member(w, { farms: i < 3 ? { b: { demandM3: 50, suppliedM3: 50 } } : {} })) }]));
		expect(few.levels[0]!.demandMetByFarm).toEqual([{ nodeId: 'b', name: 'Farm B', nYears: 3, stat: null }]);
	});
});

describe('return flows: why the EWR half of the monotonicity invariant needs β = 0 (model.md §2.15)', () => {
	const at = (x: ReturnType<typeof testCatchment>) =>
		runSeasonalOutlook(x, { ...SEASON, levels: levels([1, 0.7]), analogueYears: [2000, 2001, 2002] }).levels.map((l) => l.years.map((y) => y.ewrDays.below));
	it('with losses returning to the river, a lower demand level can add days below the EWR; without them it never does', () => {
		const withReturns = testCatchment({ ewrM3Day: 1500 });
		const [full, lower] = at(withReturns);
		expect(lower!.some((b, i) => b > full![i]!)).toBe(true);
		const noReturns = { ...withReturns, model: { ...withReturns.model, nodes: withReturns.model.nodes.map((n) => ({ ...n, lossReturnFraction: 0 })) } };
		const [f0, l0] = at(noReturns);
		expect(l0!.every((b, i) => b <= f0![i]!)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Hand-made members: the statistics, the metric and the planning figure
// ---------------------------------------------------------------------------

function member(waterYear: number, over: Partial<OutlookMember> = {}): OutlookMember {
	return {
		waterYear,
		label: `${waterYear}`,
		analogueFrom: `${waterYear}-10-01`,
		analogueTo: `${waterYear + 1}-04-30`,
		seasonEndStorageM3: 0,
		storageM3ByDam: {},
		farms: {},
		demandM3: 100,
		suppliedM3: 100,
		demandMet: 1,
		userDemandM3: 0,
		userSuppliedM3: 0,
		userDemandMet: null,
		ewrDays: { days: 212, below: 0 },
		reserve: null,
		...over
	};
}

const years = (n: number) => Array.from({ length: n }, (_, i) => 2000 + i);
const summary = (lv: OutlookSummaryInput['levels'], extra: Partial<OutlookSummaryInput> = {}): OutlookSummaryInput => {
	const n = lv.find((l) => !l.problems.length)?.members.length ?? 0;
	return {
		season: SEASON,
		model: input.model,
		analogues: years(n).map((w) => outlookAnalogue(resolveSeason(SEASON), w)),
		excluded: [],
		levels: lv,
		startStorageM3: null,
		...extra
	};
};
/** A level of n years whose EWR is met (no day below) in the first `met` of them. */
const levelMeeting = (id: string, n: number, met: number, demand = 100) => ({
	id,
	label: id,
	problems: [],
	members: years(n).map((w, i) => member(w, { demandM3: demand, ewrDays: { days: 212, below: i < met ? 0 : 5 } }))
});

describe('summariseOutlook', () => {
	it('takes the 10th, 50th and 90th percentiles linearly (type 7)', () => {
		const vals = [11, 3, 7, 1, 9, 5, 2, 10, 4, 8, 6];
		const o = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: vals.map((v, i) => member(2000 + i, { seasonEndStorageM3: v * 1000, demandMet: v / 20, ewrDays: { days: 100, below: v } })) }]));
		const l = o.levels[0]!;
		expect(l.seasonEndStorageM3).toEqual({ p10: 2000, p50: 6000, p90: 10_000 });
		expect(l.demandMet!.p10).toBeCloseTo(0.1, 12);
		expect(l.demandMet!.p50).toBeCloseTo(0.3, 12);
		expect(l.ewr).toEqual({ p10: 0.02, p50: 0.06, p90: 0.1 });
		// 10 values: between order statistics, h = 9 × 0.1 = 0.9.
		const ten = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: years(10).map((w, i) => member(w, { seasonEndStorageM3: (i + 1) * 10 })) }]));
		expect(ten.levels[0]!.seasonEndStorageM3!.p10).toBeCloseTo(19, 12);
		expect(ten.levels[0]!.seasonEndStorageM3!.p50).toBeCloseTo(55, 12);
		expect(ten.levels[0]!.seasonEndStorageM3!.p90).toBeCloseTo(91, 12);
	});

	it('leaves years without a dam or demand out of those statistics', () => {
		const o = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: years(10).map((w) => member(w, { seasonEndStorageM3: null, demandM3: 0, suppliedM3: 0, demandMet: null })) }]));
		expect(o.levels[0]!.seasonEndStorageM3).toBeNull();
		expect(o.levels[0]!.demandMet).toBeNull();
	});

	describe('the planning figure (share O6, confirmed by the client)', () => {
		const three = (m100: number, m85: number, m70: number, n = 10) => [levelMeeting('100 %', n, m100, 300), levelMeeting('85 %', n, m85, 255), levelMeeting('70 %', n, m70, 210)];

		it('is the highest demand level meeting the EWR in at least the share of years: at the cut it counts', () => {
			const o = summariseOutlook(summary(three(7, 8, 10)));
			expect(o.planning).toMatchObject({ share: DEFAULT_PLANNING_SHARE, shareIsDefault: true, reason: 'met', levelId: '85 %', yearsMet: 8, nYears: 10 });
			expect(o.planning.ranked.map((r) => [r.levelId, r.meets])).toEqual([
				['100 %', false],
				['85 %', true],
				['70 %', true]
			]);
			expect(describePlanningFigure(o)).toBe('85 %: met the EWR on every day of the season in 8 of 10 analogue years, the highest demand level to do so in at least 80 % of them.');
		});

		it('above the cut the next level down; below every level, none', () => {
			expect(summariseOutlook(summary(three(7, 8, 10), { planningShare: 0.81 })).planning).toMatchObject({ reason: 'met', levelId: '70 %', shareIsDefault: false });
			const none = summariseOutlook(summary(three(2, 5, 7)));
			expect(none.planning).toMatchObject({ reason: 'noLevelMeets', levelId: null, label: null, yearsMet: null });
			expect(describePlanningFigure(none)).toBe('No demand level met the EWR on every day of the season in at least 80 % of the 10 analogue years; the most was 7 of 10, at 70 %.');
			expect(summariseOutlook(summary(three(7, 8, 10), { planningShare: 0.7 })).planning.levelId).toBe('100 %');
		});

		it('is exact at a share whose product is not a whole number in floating point (0.56 × 25)', () => {
			expect(0.56 * 25).toBeGreaterThan(14);
			expect(summariseOutlook(summary(three(14, 14, 14, 25), { planningShare: 0.56 })).planning).toMatchObject({ reason: 'met', levelId: '100 %', yearsMet: 14 });
			expect(summariseOutlook(summary(three(13, 13, 13, 25), { planningShare: 0.56 })).planning.reason).toBe('noLevelMeets');
		});

		it('ranks the levels by their season demand, not by the order given', () => {
			const lv = [levelMeeting('70 %', 10, 10, 210), levelMeeting('100 %', 10, 9, 300), levelMeeting('85 %', 10, 9, 255)];
			const o = summariseOutlook(summary(lv));
			expect(o.planning.ranked.map((r) => r.levelId)).toEqual(['100 %', '85 %', '70 %']);
			expect(o.planning.levelId).toBe('100 %');
		});

		it('refuses a share outside (0, 1], and has none without a level that ran', () => {
			for (const bad of [0, -0.1, 1.2, NaN]) expect(() => summariseOutlook(summary(three(1, 1, 1), { planningShare: bad }))).toThrow(/planning share/);
			const o = summariseOutlook(summary([{ id: 'x', label: 'x', problems: ['op 1 (node.set): …'], members: [] }], { analogues: years(10).map((w) => outlookAnalogue(resolveSeason(SEASON), w)) }));
			expect(o.planning.reason).toBe('noLevels');
			expect(describePlanningFigure(o)).toBe('No demand level could be run.');
		});

		it('never words the figure as advice or likelihood', () => {
			for (const o of [summariseOutlook(summary(three(7, 8, 10))), summariseOutlook(summary(three(2, 5, 7)))]) expect(describePlanningFigure(o)).not.toMatch(/likely|recommend|should|expected/i);
		});
	});

	describe('the metric (as the outcome matrix chooses)', () => {
		const withReserve = (n: number, months: number, met: number) => years(n).map((w) => member(w, { reserve: { months, met } }));

		it('Reserve months met when every member has the table and a whole month', () => {
			const o = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: withReserve(10, 7, 7).map((m, i) => (i < 2 ? { ...m, reserve: { months: 7, met: 5 } } : m)) }]));
			expect(o.metric).toBe('reserveMonthsMet');
			expect(o.levels[0]!.years[0]!.ewr).toEqual({ units: 7, count: 5, share: 5 / 7, met: false });
			expect(o.levels[0]!.yearsEwrMet).toBe(8);
			expect(describePlanningFigure(o)).toMatch(/^x: met the Reserve in every month of the season in 8 of 10/);
		});

		it('falls back to days below the EWR, with a warning, when only some have it or the season holds no whole month', () => {
			const some = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: withReserve(10, 7, 7).map((m, i) => (i === 3 ? { ...m, reserve: null } : m)) }]));
			expect(some.metric).toBe('daysBelowEwr');
			expect(some.warnings.join(' ')).toMatch(/Only some members have a Reserve rule table/);
			const none = summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: withReserve(10, 0, 0) }]));
			expect(none.metric).toBe('daysBelowEwr');
			expect(none.warnings.join(' ')).toMatch(/no whole calendar month/);
			expect(() => summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: withReserve(10, 0, 0) }], { metric: 'reserveMonthsMet' }))).toThrow(/reserveMonthsMet needs/);
			expect(summariseOutlook(summary([{ id: 'x', label: 'x', problems: [], members: withReserve(10, 7, 7) }], { metric: 'daysBelowEwr' })).metric).toBe('daysBelowEwr');
		});
	});

	it('refuses duplicate level ids and a level whose members do not match the analogues', () => {
		expect(() => summariseOutlook(summary([levelMeeting('a', 10, 1), levelMeeting('a', 10, 1)]))).toThrow(/duplicate level id/);
		expect(() => summariseOutlook(summary([levelMeeting('a', 10, 1), levelMeeting('b', 9, 1)]))).toThrow(/9 members for 10/);
	});
});

describe('outlookMember reads the Reserve over the season’s whole months only', () => {
	it('counts calendar months that start on or after the decision date and end by the season end', () => {
		const season: OutlookSeason = { decisionDate: '2012-10-15', seasonEnd: '2013-01-20' };
		const start = '2012-01-01';
		const days = toEpochDay('2013-01-20') - toEpochDay(start) + 1;
		const month = (year: number, m: number, met: boolean): EwrAssuranceMonth => ({ year, month: m, waterYear: m >= 10 ? year : year - 1, days: new Date(Date.UTC(year, m, 0)).getUTCDate(), natural: 0, percentile: 50, beyond: null, required: 0, actual: 0, met, deficitM3: 0 });
		const site = { nodeId: null, isOutlet: true, months: [month(2012, 9, false), month(2012, 10, false), month(2012, 11, true), month(2012, 12, false)] } as unknown as EwrAssuranceSite;
		const out = {
			startDate: start,
			days,
			series: [{ nodeId: null, key: 'ewr_shortfall', label: '', unit: '', values: new Array(days).fill(0).map((_, t) => (t === days - 1 ? -1 : 0)) }],
			summary: { ewrAssurance: [site] } as unknown as ModelOutput['summary']
		};
		const a = outlookAnalogue(resolveSeason(season), 2005);
		const m = outlookMember(out, { nodes: [], crops: [], cropAreas: [], transfers: [] }, season, a);
		// October starts before the decision date and January ends after the season: November and December only.
		expect(m.reserve).toEqual({ months: 2, met: 1 });
		expect(m.ewrDays).toEqual({ days: 98, below: 1 });
		expect(m.seasonEndStorageM3).toBeNull();
		expect(m.demandMet).toBeNull();
		expect(() => outlookMember({ ...out, days: days + 1 }, { nodes: [], crops: [], cropAreas: [], transfers: [] }, season, a)).toThrow(/does not end on the season end/);
	});
});
