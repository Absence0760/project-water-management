// Development over the run (engine 1.30.0, issue #67, docs/model.md §2.7g):
// a dam losing capacity to sediment, a dam in service from a date and
// abstraction from a date, on hand-worked cases, the defaults leaving a run
// unchanged, and the self-checks holding the engine to them.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';
import { modelRuleIssues } from '../modelRules';
import { checkWorkings } from '../verify/checks';
import { abstractionStartDay, capacityScaleOf, damCapacityFactor, damCapacityOn, developmentProblem, DAM_CAPACITY_SERIES } from './development';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const flat = (v: number) => new Array(12).fill(v) as number[];
const START = '2021-01-01';

/** Farm A (a 100 000 m³ dam taking all its runoff) above the outlet gauge G, over `days` dry days from START; A needs `need` m³/day. */
function input(a: Partial<NetworkNode>, opts: { days?: number; need?: number } = {}): ModelInput {
	const days = opts.days ?? 60;
	return {
		settings: { apanMm: flat(150) as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never, lakeEvapFactor: 0 },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 100_000, damInitialPct: 1, ...a })],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			// January's gross demand is `need` m³/day: 150 mm over the month's 31 days.
			cropAreas: opts.need ? [{ nodeId: 'A', cropId: 'c', areaM2: (opts.need * 31_000) / 150 }] : [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values;
const passed = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
const d0 = toEpochDay(START);

describe('the capacity factor', () => {
	const dam = { kind: 'farm' as const, damCapacityM3: 100_000, damSurveyDate: '2021-01-01', damSedimentPctPerYear: 0.01, damInServiceFrom: null, abstractionFrom: null };

	it('runs linearly both ways from the survey date, never below empty', () => {
		expect(damCapacityFactor(dam, d0)).toBe(1);
		// A year (365.25 days) after the survey: 1 % less; a year before: 1 % more.
		expect(damCapacityFactor(dam, d0 + 365.25)).toBeCloseTo(0.99, 12);
		expect(damCapacityOn(dam, d0 - 365.25)).toBeCloseTo(101_000, 6);
		expect(damCapacityFactor({ ...dam, damSedimentPctPerYear: 0.2 }, d0 + 6 * 365.25)).toBe(0);
	});

	it('is 0 before the in-service date, and 1 for a dam with neither field (positive control: the entered capacity, to the bit)', () => {
		const built = { ...dam, damSedimentPctPerYear: null, damInServiceFrom: '2021-02-01' };
		expect(damCapacityFactor(built, d0 + 30)).toBe(0);
		expect(damCapacityFactor(built, d0 + 31)).toBe(1);
		const plain = { ...dam, damSurveyDate: null, damSedimentPctPerYear: null };
		expect(damCapacityOn(plain, d0 + 1000)).toBe(100_000);
		expect(capacityScaleOf(node('A', 'farm', null, { ...plain, damCapacityM3: 100_000 }), d0, 60, [])).toBeUndefined();
	});

	it('says what is wrong with the fields, and the model rules report it', () => {
		expect(developmentProblem({ ...dam, damSurveyDate: null })).toMatch(/needs the date the capacity was surveyed/);
		expect(developmentProblem({ ...dam, damSedimentPctPerYear: 0.5 })).toMatch(/0 to 20 %/);
		expect(developmentProblem({ ...dam, damInServiceFrom: '2021-02-30' })).toMatch(/in-service date must be a date/);
		expect(developmentProblem({ ...dam, kind: 'user' })).toMatch(/only a farm has a dam/);
		expect(developmentProblem({ ...dam, kind: 'gauge', damSurveyDate: null, damSedimentPctPerYear: null, abstractionFrom: '2021-01-01' })).toMatch(/gauge takes no water/);
		expect(developmentProblem(dam)).toBeNull();
		const i = input({ damSedimentPctPerYear: 0.01 });
		expect([...modelRuleIssues(i.model).values()].join()).toMatch(/"A": a sediment rate needs the date/);
	});

	it('warns when the dam is run back to far more than its surveyed capacity (positive control: a small factor says nothing)', () => {
		const w: string[] = [];
		capacityScaleOf(node('A', 'farm', null, { damCapacityM3: 100_000, damSurveyDate: '2021-01-01', damSedimentPctPerYear: 0.02 }), toEpochDay('1990-01-01'), 60, w);
		expect(w.join()).toMatch(/holds up to 1\.62 × its surveyed capacity/);
		const quiet: string[] = [];
		capacityScaleOf(node('A', 'farm', null, { damCapacityM3: 100_000, damSurveyDate: '2021-01-01', damSedimentPctPerYear: 0.02 }), toEpochDay('2019-01-01'), 60, quiet);
		expect(quiet).toEqual([]);
	});

	it('reads the date boundaries by epoch day, whatever the time zone (rule 7)', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati';
		try {
			const built = { kind: 'farm' as const, damCapacityM3: 100_000, damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: '2021-02-01', abstractionFrom: null };
			expect(damCapacityFactor(built, toEpochDay('2021-01-31'))).toBe(0);
			expect(damCapacityFactor(built, toEpochDay('2021-02-01'))).toBe(1);
			expect(abstractionStartDay(node('A', 'farm', null, { abstractionFrom: '2021-02-01' }), toEpochDay('2021-01-01'), 60, [])).toBe(31);
			const o = run(input({ damInitialPct: 0, damInServiceFrom: '2021-01-21' }), new Array(60).fill(2_000));
			expect(col(o, 'A', 'dam_storage')![19]).toBe(0);
			expect(col(o, 'A', 'dam_storage')![20]).toBeCloseTo(2_000, 6);
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});

	it('an abstraction date counts from the run start, clamped to it', () => {
		const w: string[] = [];
		expect(abstractionStartDay(node('A', 'farm', null, { abstractionFrom: '2021-01-11' }), d0, 60, w)).toBe(10);
		expect(abstractionStartDay(node('A', 'farm', null, { abstractionFrom: '2020-01-01' }), d0, 60, w)).toBe(0);
		expect(abstractionStartDay(node('A', 'farm', null, { abstractionFrom: '2030-01-01' }), d0, 60, w)).toBe(60);
		expect(w).toEqual([]);
	});
});

describe('a run with the development fields', () => {
	it('a dam losing capacity spills what it can no longer hold, and reports its capacity each day', () => {
		// Surveyed full at 100 000 m³ on the run's first day, losing 20 % a year: about 55 m³ a day.
		const o = run(input({ damSurveyDate: START, damSedimentPctPerYear: 0.2 }), new Array(60).fill(0));
		passed(o);
		const cap = col(o, 'A', DAM_CAPACITY_SERIES.key)!;
		const q = col(o, 'A', 'dam_storage')!;
		const spill = col(o, 'A', 'spill')!;
		for (let t = 0; t < 60; t++) {
			expect(cap[t]).toBeCloseTo(100_000 * (1 - (0.2 * t) / 365.25), 6);
			// No inflow, no demand, no evaporation: the dam stays full at the day's capacity and spills the rest.
			expect(q[t]).toBeCloseTo(cap[t]!, 6);
			if (t > 0) expect(spill[t]).toBeCloseTo(cap[t - 1]! - cap[t]!, 6);
		}
	});

	it('a dam that sediment fills during the run ends empty and passes everything, seepage included (soak seeds 2332, 2426, 2492)', () => {
		// 20 % a year from a survey five years and a month before February: empty from about 2021-02-01.
		const o = run(input({ damSurveyDate: '2016-02-01', damSedimentPctPerYear: 0.2, damSeepagePerDay: 0.01 }), new Array(60).fill(1_000));
		passed(o);
		const cap = col(o, 'A', DAM_CAPACITY_SERIES.key)!;
		const q = col(o, 'A', 'dam_storage')!;
		const gone = cap.findIndex((c) => c === 0);
		expect(gone).toBeGreaterThan(0);
		expect(q[gone]).toBe(0);
		// With no capacity nothing seeps: the day's inflow and what the dam held all pass on.
		expect(col(o, 'A', 'dam_seepage')![gone]).toBe(0);
		expect(col(o, 'A', 'outflow')![gone]).toBeCloseTo(1_000 + q[gone - 1]!, 6);
	});

	it('before a survey the dam holds more than its entered capacity', () => {
		// Surveyed a year after the run: at the start it holds 1 % more, and it starts that full.
		const o = run(input({ damSurveyDate: '2022-01-01', damSedimentPctPerYear: 0.01 }), new Array(60).fill(5_000));
		passed(o);
		expect(col(o, 'A', 'dam_storage')![0]).toBeGreaterThan(100_000);
		expect(col(o, 'A', DAM_CAPACITY_SERIES.key)![0]).toBeCloseTo(100_000 * (1 + 0.01 * (365 / 365.25)), 6);
	});

	it('a dam in service from a date holds nothing before it and fills after it', () => {
		const o = run(input({ damInitialPct: 0, damInServiceFrom: '2021-01-21' }), new Array(60).fill(2_000));
		passed(o);
		const q = col(o, 'A', 'dam_storage')!;
		const u = col(o, 'A', 'outflow')!;
		for (let t = 0; t < 20; t++) {
			expect(q[t]).toBe(0);
			// The inflow passes straight on: A has no dam yet.
			expect(u[t]).toBeCloseTo(2_000, 6);
		}
		expect(q[20]).toBeCloseTo(2_000, 6);
		expect(q[59]).toBeCloseTo(80_000, 6);
	});

	it('abstraction from a date: no demand before it, the crops’ demand after it', () => {
		const o = run(input({ abstractionFrom: '2021-01-11' }, { need: 400 }), new Array(60).fill(0));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		expect(d.slice(0, 10).every((v) => v === 0)).toBe(true);
		expect(d[10]).toBeCloseTo(400, 6);
		// Positive control: without the date the farm abstracts from day 0.
		expect(col(run(input({}, { need: 400 }), new Array(60).fill(0)), 'A', 'demand')![0]).toBeCloseTo(400, 6);
	});

	it('a full allocation asks for the volume over the days the unit abstracts on, not the whole year (engine review)', () => {
		// 36 500 m³ a year registered; the unit abstracts from day 30 of the 60-day run: 30 days' volume, 100 m³/day.
		const i = input({ abstractionFrom: '2021-01-31' }, { need: 400 });
		i.model.allocations = [{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 36_500 }];
		i.settings = { ...i.settings, allocationMode: 'fullAllocation' };
		const o = run(i, new Array(60).fill(0));
		passed(o);
		const d = col(o, 'A', 'demand')!;
		expect(d.slice(0, 30).every((v) => v === 0)).toBe(true);
		expect(d.slice(30).reduce((a, b) => a + b, 0)).toBeCloseTo(3_000, 6);
		expect(o.summary.warnings.some((w) => w.includes('has no demand in water year'))).toBe(false);
	});

	it('the supply rule’s trigger level is a share of the day’s capacity', () => {
		// Half the entered capacity left on the run's first day (surveyed 2.5 years before, 20 % a year),
		// starting 60 % full of that: 30 000 m³, 30 % of the entered 100 000 but above the 40 % trigger.
		const farm = { pctRunoffToDam: 0, supplyRule: 'trigger' as const, pumpCapacityM3Day: 10_000, supplyTriggerPct: 0.4, supplyStopPct: 0.6 };
		const sedimented = run(input({ ...farm, damInitialPct: 0.6, damSurveyDate: '2018-07-02', damSedimentPctPerYear: 0.2 }, { need: 400 }), new Array(60).fill(2_000));
		passed(sedimented);
		expect(col(sedimented, 'A', DAM_CAPACITY_SERIES.key)![0]).toBeCloseTo(50_000, -2);
		expect(col(sedimented, 'A', 'dam_storage')![0]).toBeGreaterThan(0.4 * 50_000);
		expect(col(sedimented, 'A', 'river_abstraction')![0]).toBe(0);
		// Positive control: the same 30 % of a dam whose capacity doesn't change is below the trigger, so it pumps.
		const plain = run(input({ ...farm, damInitialPct: 0.3 }, { need: 400 }), new Array(60).fill(2_000));
		passed(plain);
		expect(col(plain, 'A', 'river_abstraction')![0]).toBeGreaterThan(0);
	});

	it('the self-checks hold the engine to the day’s capacity (a tampered dam_capacity column fails them)', () => {
		const i = input({ damSurveyDate: START, damSedimentPctPerYear: 0.2 });
		const o = runModelWith(i, () => ({ naturalFlowM3Day: new Array(60).fill(0) }));
		expect(checkWorkings(i, o)).toBeNull();
		const bad = structuredClone(o);
		bad.series.find((s) => s.nodeId === 'A' && s.key === DAM_CAPACITY_SERIES.key)!.values[5] = 100_000;
		expect(checkWorkings(i, bad)).toMatch(/dam_capacity .* ≠ the capacity/);
	});

	it('leaves a run without the fields as it was (no dam_capacity column)', () => {
		const o = run(input({}, { need: 400 }), new Array(60).fill(1_000));
		passed(o);
		expect(col(o, 'A', DAM_CAPACITY_SERIES.key)).toBeUndefined();
	});
});
