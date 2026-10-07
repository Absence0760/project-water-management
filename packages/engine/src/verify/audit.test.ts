// The Excel audit workbook's formulas (./audit.ts), evaluated as a
// spreadsheet would, reproduce runModel's stored numbers: on a hand-built
// farm that takes every formula branch, and on every supported farm of a
// set of random networks (./testing/fuzz.ts). Their Excel text keeps the
// tree's order of operations.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { FARM_COLUMNS } from './columns';
import { AUDIT_REQUIRED_SERIES, AUDIT_UNSUPPORTED_SERIES, auditFormula, evaluateAudit, farmAuditPlan, isFormula, type AuditExpr, type AuditRun } from './audit';

function auditRun(input: ModelInput, out: ModelOutput, nodeId: string): AuditRun {
	const of = (id: string | null) => new Map(out.series.filter((s) => s.nodeId === id).map((s) => [s.key, s.values]));
	return {
		settings: input.settings,
		model: input.model,
		startDate: out.startDate,
		days: out.days,
		apanDailyDays: out.summary.apanDaily?.dailyDays ?? 0,
		farm: of(nodeId),
		catchment: of(null)
	};
}

const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);

/** The largest |formula − model| over the run, and where; null when every day agrees to float noise. */
function disagreement(input: ModelInput, out: ModelOutput, nodeId: string): string | null {
	const r = farmAuditPlan(auditRun(input, out, nodeId), nodeId);
	if (!('plan' in r)) throw new Error(`unsupported: ${r.unsupported.join(', ')}`);
	const { values } = evaluateAudit(r.plan);
	const scale = Math.max(1, ...r.plan.params.map((p) => Math.abs(p.value)).filter(Number.isFinite));
	for (const c of r.plan.columns) {
		if (!isFormula(c)) continue;
		const v = values.get(c.key)!;
		for (let t = 0; t < out.days; t++) {
			const m = Number(c.model![t]);
			const s = Math.max(scale, Math.abs(m), Math.abs(v[t]!));
			if (Math.abs(v[t]! - m) > tol(s)) return `${nodeId} ${c.key} day ${t}: formula ${v[t]} ≠ model ${m}`;
		}
	}
	return null;
}

const node = (over: Partial<NetworkNode> & Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'>): NetworkNode =>
	({
		sortOrder: 0,
		areaKm2: 10,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	}) as NetworkNode;

const days = 3 * 365;
const rain = Array.from({ length: days }, (_, i) => (i % 17 === 0 ? 45 : i % 5 === 0 ? 6 : i % 97 === 3 ? null : 0));

/** Two farms in a chain, dams on both: b > 1 with part of the seepage lost upstream, a diversion and a demand factor below. */
function handBuilt(): ModelInput {
	return {
		settings: {
			runoffModel: 'gr4j',
			gr4j: { x1: 300, x2: 0, x3: 60, x4: 1.8, warmupDays: 365 },
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			lakeEvapFactorMonthly: [0.8, 0.8, 0.85, 0.85, 0.85, 0.8, 0.75, 0.7, 0.7, 0.7, 0.75, 0.8] as never
		},
		model: {
			nodes: [
				node({ id: 'out', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }),
				node({
					id: 'low',
					name: 'Lower farm',
					kind: 'farm',
					downstreamNodeId: 'out',
					pctUpstreamToDam: 0.4,
					pctRunoffToDam: 0.7,
					divertCapacityM3Day: 900,
					damCapacityM3: 60_000,
					damInitialPct: 0.3,
					damMinPct: 0.05,
					damAreaFullM2: 30_000,
					damAreaExponent: 0.8,
					damSeepagePerDay: 0.002,
					irrigationEfficiency: 0.8,
					returnFlowFraction: 0.1,
					demandFactor: [1, 1, 1.2, 1.2, 1.2, 1, 1, 0.8, 0.8, 0.8, 1, 1]
				}),
				node({
					id: 'up',
					name: 'Upper farm',
					kind: 'farm',
					downstreamNodeId: 'low',
					pctRunoffToDam: 1,
					damCapacityM3: 25_000,
					damInitialPct: 1,
					damAreaFullM2: 12_000,
					damAreaExponent: 1.6,
					damSeepagePerDay: 0.01,
					damSeepageReturnPct: 0.4,
					irrigationEfficiency: 0.75,
					returnFlowFraction: 0.075
				})
			],
			crops: [{ id: 'c', name: 'Citrus', cropFactor: [0.7, 0.7, 0.75, 0.75, 0.75, 0.7, 0.65, 0.6, 0.6, 0.6, 0.65, 0.7] as never }],
			cropAreas: [
				{ nodeId: 'low', cropId: 'c', areaM2: 400_000 },
				{ nodeId: 'up', cropId: 'c', areaM2: 600_000 }
			],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2019-10-01', values: rain } }
	};
}

describe('farmAuditPlan + evaluateAudit', () => {
	it('reproduce a hand-built farm pair, dam storage carried from row to row', () => {
		const input = handBuilt();
		const out = runModel(input);
		for (const id of ['up', 'low']) expect(disagreement(input, out, id)).toBeNull();
		// The branches it is there for: b > 1's evaporation limit, a lost seepage share, a demand factor, a diversion cap.
		const up = farmAuditPlan(auditRun(input, out, 'up'), 'up');
		const low = farmAuditPlan(auditRun(input, out, 'low'), 'low');
		if (!('plan' in up) || !('plan' in low)) throw new Error('unsupported');
		expect(up.plan.columns.map((c) => c.key)).toContain('dam_seepage_lost');
		expect(low.plan.columns.map((c) => c.key)).not.toContain('dam_seepage_lost');
		expect(new Set(low.plan.columns.find((c) => c.key === 'demand_factor')!.values)).toEqual(new Set([1, 1.2, 0.8]));
		const upStore = out.series.find((s) => s.nodeId === 'up' && s.key === 'dam_storage')!.values;
		expect(Math.min(...upStore)).toBeLessThan(25_000 * 0.9);
	});

	it('refuses a farm with a hands-off flow or River to dam by month (engine 1.32.0), naming each', () => {
		const input = handBuilt();
		Object.assign(input.model.nodes.find((n) => n.id === 'low')!, { handsOffEwr: true, divertMonthlyM3Day: new Array(12).fill(500) });
		const out = runModel(input);
		const r = farmAuditPlan(auditRun(input, out, 'low'), 'low');
		expect('unsupported' in r && r.unsupported).toEqual(['a hands-off flow', 'River to dam by month']);
		// A hands-off flow of 0 in every month is none: the farm stays supported.
		Object.assign(input.model.nodes.find((n) => n.id === 'low')!, { handsOffEwr: false, handsOffM3Day: new Array(12).fill(0), divertMonthlyM3Day: null });
		expect(disagreement(input, runModel(input), 'low')).toBeNull();
	});

	it("labels each column with FARM_COLUMNS' FarmTemplate letter", () => {
		const input = handBuilt();
		const out = runModel(input);
		const r = farmAuditPlan(auditRun(input, out, 'up'), 'up');
		if (!('plan' in r)) throw new Error('unsupported');
		const letters = new Map(FARM_COLUMNS.map((c) => [c.key, c.letter]));
		for (const c of r.plan.columns) expect(c.letter, c.key).toBe(letters.get(c.key) ?? null);
		expect(r.plan.columns.filter((c) => c.letter).length).toBe(20);
	});

	it('the largest difference per day is float noise on a supported farm', () => {
		const input = handBuilt();
		const out = runModel(input);
		const r = farmAuditPlan(auditRun(input, out, 'low'), 'low');
		if (!('plan' in r)) throw new Error('unsupported');
		const { largestDifference } = evaluateAudit(r.plan);
		expect(largestDifference).toHaveLength(out.days);
		expect(Math.max(...largestDifference)).toBeLessThan(1e-6);
	});

	it('reproduce every supported farm of 60 random networks', () => {
		let audited = 0;
		let refused = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const input = randomInput(seed, { maxDays: 800 });
			const out = runModel(input);
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm') continue;
				const r = farmAuditPlan(auditRun(input, out, n.id), n.id);
				if (!('plan' in r)) {
					expect(r.unsupported.length).toBeGreaterThan(0);
					refused++;
					continue;
				}
				expect(disagreement(input, out, n.id), `seed ${seed}`).toBeNull();
				audited++;
			}
		}
		// Enough of both for the property to mean something.
		expect(audited).toBeGreaterThan(40);
		expect(refused).toBeGreaterThan(0);
	});

	// A farm series runModel writes is one the formulas read or compare against, one whose presence
	// refuses the farm, or one listed here with why it can't change the recomputed columns. A new
	// series fails this test until someone decides which, so a feature that changes supply or
	// storage can't slip into a workbook that disagrees with the model.
	const HANDLED: Record<string, string> = {
		dam_seepage_lost: 'a formula column when part of the seepage is lost',
		allocation_demand_factor: 'read into the demand factor input'
	};
	// Diagnostics beside the balance, or already inside an input column (runoff I, transfer J).
	const BESIDE: Record<string, string> = {
		soil_water: 'the store behind effective rain, an input',
		landcover_reduction: 'already taken off runoff I, an input',
		ewr: 'the EWR rule at this site; Z is the input',
		ewr_binding_site: 'which EWR site binds',
		ewr_charge: 'attribution of a shortfall downstream',
		ewr_charge_irrigation: 'attribution of a shortfall downstream',
		ewr_shortfall_incremental: 'attribution of a shortfall downstream',
		'transfer_rule@': "one transfer rule's part of J, an input",
		reach_loss: 'lost in the reach below the farm, after its outflow U; the next unit’s H has it off already'
	};
	// Written only beside a series or model feature that already refuses the farm.
	const WITH_REFUSED: Record<string, string> = {
		groundwater_to_dam: 'groundwater_used',
		baseflow_depletion: 'groundwater_used',
		depletion_deficit: 'groundwater_used',
		depletion_store: 'groundwater_used',
		offtake_used: 'offtake_in',
		offtake_to_dam: 'offtake_in',
		passed_for_senior: 'senior_requirement',
		senior_reach_loss: 'senior_requirement',
		'object_demand@': 'demand objects',
		'object_supplied@': 'demand objects',
		// The basic-needs floor (engine 1.44.0) is written only on a unit with a demand object.
		basic_needs: 'demand objects',
		// River abstractions (engine 1.65.0) refuse the farm by the model itself.
		'river_take@': 'river abstractions beside the dam',
		'river_pool@': 'river abstractions beside the dam',
		'river_pool_evaporation@': 'river abstractions beside the dam',
		'river_pump_limited@': 'river abstractions beside the dam'
	};
	const base = (key: string) => (key.includes('@') ? key.slice(0, key.indexOf('@') + 1) : key);

	it('classifies every farm series runModel writes over 200 random networks', () => {
		const unsupported = new Map(AUDIT_UNSUPPORTED_SERIES);
		const unclassified = new Set<string>();
		const seen = new Set<string>();
		for (let seed = 1; seed <= 200; seed++) {
			const input = randomInput(seed, { maxDays: 120 });
			const out = runModel(input);
			for (const n of input.model.nodes) {
				if (n.kind !== 'farm') continue;
				const keys = out.series.filter((x) => x.nodeId === n.id).map((x) => x.key);
				const r = farmAuditPlan(auditRun(input, out, n.id), n.id);
				for (const key of keys) {
					const k = base(key);
					seen.add(k);
					if (AUDIT_REQUIRED_SERIES.includes(k) || k in HANDLED || k in BESIDE) continue;
					if (unsupported.has(k) || k in WITH_REFUSED) {
						const why = unsupported.get(k) ?? unsupported.get(WITH_REFUSED[k]!) ?? WITH_REFUSED[k]!;
						expect('unsupported' in r && r.unsupported, `seed ${seed} ${n.id} ${key}`).toContain(why);
						continue;
					}
					unclassified.add(key);
				}
			}
		}
		expect([...unclassified]).toEqual([]);
		// The random networks reach the refusing features, so the lists above are exercised.
		for (const k of ['groundwater_used', 'offtake_in', 'senior_requirement', 'object_demand@', 'dam_seepage_lost']) expect(seen, k).toContain(k);
	});

	it('plans the same days under a skewed TZ (a demand factor from the 1st of a month)', () => {
		const input = handBuilt();
		input.settings.demandFactorFrom = '2020-03-01';
		const out = runModel(input);
		const plan = () => farmAuditPlan(auditRun(input, out, 'low'), 'low');
		const utc = plan();
		if (!('plan' in utc)) throw new Error('unsupported');
		const factor = utc.plan.columns.find((c) => c.key === 'demand_factor')!.values!;
		// Nothing before 1 March 2020 (day 152), not even December to February's 1.2; the monthly factor after it (0.8 from 1 May, day 213).
		expect(new Set(factor.slice(0, 152))).toEqual(new Set([1]));
		expect([factor[212], factor[213], factor[152 + 365 - 60]]).toEqual([1, 0.8, 1.2]);
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(plan()).toEqual(utc);
			}
		} finally {
			process.env.TZ = tz;
		}
		expect(disagreement(input, out, 'low')).toBeNull();
	});

	it('carries an abstraction date as a demand factor of 0 before it, and refuses a dam whose capacity changes', () => {
		const input = handBuilt();
		input.model.nodes[1]!.abstractionFrom = '2020-06-01';
		const out = runModel(input);
		const r = farmAuditPlan(auditRun(input, out, 'low'), 'low');
		if (!('plan' in r)) throw new Error('unsupported');
		const factor = r.plan.columns.find((c) => c.key === 'demand_factor')!.values!;
		// 1 June 2020 is day 244 of a run from 1 October 2019.
		expect(new Set(factor.slice(0, 244))).toEqual(new Set([0]));
		expect(factor[244]).toBe(0.8);
		expect(disagreement(input, out, 'low')).toBeNull();
		input.model.nodes[2]!.damSedimentPctPerYear = 0.02;
		input.model.nodes[2]!.damSurveyDate = '2020-10-01';
		const silted = runModel(input);
		expect(farmAuditPlan(auditRun(input, silted, 'up'), 'up')).toEqual({ unsupported: ['a dam capacity that changes over the run (sediment or an in-service date)'] });
	});

	it('names what it cannot recompute instead of building a workbook that disagrees', () => {
		const input = handBuilt();
		input.model.nodes[2]!.damCurve = [
			{ levelM: 1, volumeM3: 5_000, areaM2: 4_000 },
			{ levelM: 3, volumeM3: 25_000, areaM2: 12_000 }
		];
		input.model.nodes[1]!.damReleaseRule = 'fixed';
		input.model.nodes[1]!.damReleaseM3Day = Array(12).fill(50);
		const out = runModel(input);
		expect(farmAuditPlan(auditRun(input, out, 'up'), 'up')).toEqual({ unsupported: ['a dam survey curve'] });
		expect(farmAuditPlan(auditRun(input, out, 'low'), 'low')).toEqual({ unsupported: ['a dam release rule'] });
		expect(farmAuditPlan(auditRun(input, out, 'out'), 'out')).toEqual({ unsupported: ['it is a gauge, not a farm'] });
		const legacy = auditRun(input, out, 'low');
		legacy.farm = new Map([...legacy.farm].filter(([k]) => k !== 'dam_area' && k !== 'dam_release'));
		expect(farmAuditPlan(legacy, 'low')).toEqual({ unsupported: ['no dam_area column (a run saved by an older engine)'] });
		const lost = auditRun(handBuilt(), runModel(handBuilt()), 'up');
		lost.farm = new Map([...lost.farm].filter(([k]) => k !== 'dam_seepage_lost'));
		expect(farmAuditPlan(lost, 'up')).toEqual({ unsupported: ['no dam_seepage_lost column (a run saved by an older engine)'] });
	});
});

describe('auditFormula', () => {
	const ref = (col: string, prev: boolean) => `${col}${prev ? '_1' : '_0'}`;
	const param = (id: string) => `Parameters!$B$${id}`;
	const text = (e: AuditExpr) => auditFormula(e, ref, param);

	it('keeps the tree order: equal precedence on the right and lower precedence below are parenthesised', () => {
		expect(text({ op: '-', a: { op: '-', a: { col: 'a' }, b: { col: 'b' } }, b: { col: 'c' } })).toBe('a_0-b_0-c_0');
		expect(text({ op: '-', a: { col: 'a' }, b: { op: '-', a: { col: 'b' }, b: { col: 'c' } } })).toBe('a_0-(b_0-c_0)');
		expect(text({ op: '+', a: { col: 'a' }, b: { op: '+', a: { col: 'b' }, b: { col: 'c' } } })).toBe('a_0+(b_0+c_0)');
		expect(text({ op: '*', a: { op: '+', a: { col: 'a' }, b: 1 }, b: { param: '3' } })).toBe('(a_0+1)*Parameters!$B$3');
		expect(text({ op: '/', a: { op: '*', a: { col: 'a' }, b: { col: 'b', prev: true } }, b: 1000 })).toBe('a_0*b_1/1000');
		expect(text({ op: '^', a: { op: '^', a: 2, b: 3 }, b: 2 })).toBe('(2^3)^2');
		expect(text({ fn: 'MIN', args: [{ fn: 'MAX', args: [{ col: 'a' }, 0] }, -2.5] })).toBe('MIN(MAX(a_0,0),(-2.5))');
	});

	it('writes numbers Excel reads back exactly and refuses non-finite ones', () => {
		expect(text(0.1 + 0.2)).toBe('0.30000000000000004');
		expect(text(1e-7)).toBe('1e-7');
		expect(() => text(Infinity)).toThrow();
	});

	it('renders every column of a real plan without a non-finite number', () => {
		const input = handBuilt();
		const out = runModel(input);
		const r = farmAuditPlan(auditRun(input, out, 'up'), 'up');
		if (!('plan' in r)) throw new Error('unsupported');
		for (const c of r.plan.columns) if (isFormula(c)) expect(text(c.expr)).not.toMatch(/NaN|Infinity/);
	});
});
