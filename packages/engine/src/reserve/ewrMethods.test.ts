// The Reserve method choices pending the hydrologist (engine ≥ 1.3.0, issue
// #64, docs/model.md §2.9c–§2.9d, §2.11b): the EWR charge from the rule table
// (settings.ewrChargeSource) and low flows judged on base flow
// (settings.lowFlowMeasure). Both default to what every earlier run did.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { captureModelState, runModelCapturing, runModelFrom, runModelWith, runModelWithoutChecks } from '../run';
import { applyScenario } from '../scenario/overrides';
import { settingsValueError } from '../scenario/ops';
import { checkInvariants } from '../verify/checks';
import { assessSite } from './assurance';
import { lyneHollickBaseflow } from './baseflow';
import { DEFAULT_ASSURANCE_POINTS, type EwrRuleTable } from './rules';

const rows = (row: number[]) => Array.from({ length: 12 }, () => [...row]);
const daysBetween = (a: string, b: string) => toEpochDay(b) - toEpochDay(a) + 1;

// ---------------------------------------------------------------------------
// Low flows on base flow (settings.lowFlowMeasure)
// ---------------------------------------------------------------------------

describe('low flows judged on base flow', () => {
	const start = '2000-10-01';
	const days = daysBetween(start, '2003-09-30');
	// A river with 0.01 Mm³/day of base flow and a 3-day flood of 5 Mm³/day early every November.
	const flow = Array.from({ length: days }, (_, t) => {
		const d = new Date((toEpochDay(start) + t) * 86_400_000);
		return (d.getUTCMonth() === 10 && d.getUTCDate() >= 5 && d.getUTCDate() < 8 ? 5 : 0.01) * 1e6;
	});
	// Natural curve 30 / 20 / 10 Mm³ at the 10 / 50 / 90 % points: November (≈ 15 Mm³) sits between 50 and 90 %.
	const lowTable = (over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
		siteNodeId: null,
		source: 'Synthetic',
		component: 'lowFlow',
		unit: 'mcm',
		points: [10, 50, 90],
		ewr: rows([3, 2, 1]),
		naturalSource: 'table',
		natural: rows([30, 20, 10]),
		scale: 1,
		...over
	});
	const assess = (t: EwrRuleTable, measure?: 'total' | 'baseflow') =>
		assessSite(start, days, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: flow, impacted: flow }, undefined, null, measure);
	const novembers = (r: ReturnType<typeof assess>) => r.report.months.filter((m) => m.month === 11);

	it('a flood month passes a low-flow table on its total flow and fails it on its base flow', () => {
		const total = assess(lowTable(), 'total').report;
		const base = assess(lowTable(), 'baseflow').report;
		expect(total.overall.rate).toBe(1);
		for (const m of novembers(assess(lowTable(), 'baseflow'))) {
			expect(m.met).toBe(false);
			expect(m.baseflow!).toBeLessThan(m.required);
			expect(m.actual).toBeGreaterThan(m.required);
			// The deficit is the base flow's.
			expect(m.deficitM3).toBeCloseTo((m.required - m.baseflow!) * 1e6, 3);
		}
		// Every other month is base flow already, and meets its (scaled-down) requirement either way.
		expect(base.months.filter((m) => m.month !== 11).every((m) => m.met)).toBe(true);
		expect(base.lowFlowMeasure).toBe('baseflow');
		expect(total.lowFlowMeasure).toBeUndefined();
	});

	it('on a total table, only the low-flow part moves: the total requirement is judged on the volume either way', () => {
		const t = lowTable({ component: 'total', ewr: rows([6, 4, 2]), lowFlow: rows([3, 2, 1]) });
		const total = assess(t, 'total').report;
		const base = assess(t, 'baseflow').report;
		expect(base.months.map((m) => m.met)).toEqual(total.months.map((m) => m.met));
		expect(base.overall).toEqual(total.overall);
		expect(total.lowFlow!.rate).toBe(1);
		for (const m of base.months) expect(m.lowFlowMet).toBe(m.month !== 11);
		expect(base.lowFlow!.met).toBe(base.lowFlow!.months - 3);
		expect(base.lowFlow!.deficitM3).toBeGreaterThan(0);
	});

	it("'total' is the default, and 'baseflow' changes nothing on a table without a low-flow requirement", () => {
		expect(assess(lowTable(), 'total')).toEqual(assess(lowTable()));
		const plain = lowTable({ component: 'total' });
		expect(assess(plain, 'baseflow')).toEqual(assess(plain, 'total'));
		expect(JSON.stringify(assess(plain, 'total').report)).toBe(JSON.stringify(assess(plain).report));
	});

	it('on random series: base flow ≤ the month’s volume, so a month met on base flow is met on its total', () => {
		const rng = new Rng(6402);
		for (let k = 0; k < 40; k++) {
			const n = rng.int(40, 900);
			const q = Array.from({ length: n }, () => (rng.bool(0.1) ? rng.logFloat(1e4, 1e7) : rng.logFloat(10, 1e5)));
			const points = [...DEFAULT_ASSURANCE_POINTS];
			const t = lowTable({
				unit: rng.pick(['mcm', 'm3s'] as const),
				points,
				naturalSource: 'run',
				natural: null,
				ewr: rows(points.map((p) => rng.logFloat(1e-4, 1) * (1 - p / 200)))
			});
			const s0 = new Date(Date.UTC(1990 + rng.int(0, 20), rng.int(0, 11), rng.int(1, 28))).toISOString().slice(0, 10);
			const run = (m: 'total' | 'baseflow') => assessSite(s0, n, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: q, impacted: q }, undefined, null, m).report;
			const total = run('total');
			const base = run('baseflow');
			base.months.forEach((m, i) => {
				expect(m.baseflow!).toBeLessThanOrEqual(m.actual * (1 + 1e-12));
				expect(m.required).toBe(total.months[i]!.required);
				if (m.met) expect(total.months[i]!.met).toBe(true);
			});
		}
	});
});

// ---------------------------------------------------------------------------
// The EWR charge from the rule table (settings.ewrChargeSource)
// ---------------------------------------------------------------------------

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
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
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

// Starts mid-October, so the first and last months are part months the rule table can't judge.
const START = '2000-10-15';
const DAYS = daysBetween(START, '2003-09-20');
const PRAGMATIC = 5_000;

/** out (gauge) ← g (gauge) ← farm a (a dam catching its runoff, irrigating); out ← farm b. */
function network(settings: Partial<ModelInput['settings']>, ewrRules: EwrRuleTable[]): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(PRAGMATIC) as never, apanMm: new Array(12).fill(200) as never, ewrRules, ...settings },
		model: {
			nodes: [
				node('out', { kind: 'gauge' }),
				node('g', { kind: 'gauge', downstreamNodeId: 'out' }),
				node('a', { downstreamNodeId: 'g', areaKm2: 3, damCapacityM3: 200_000, pctRunoffToDam: 0.8, damInitialPct: 0.5 }),
				node('b', { downstreamNodeId: 'out' })
			],
			crops: [{ id: 'c', name: 'crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 80_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(0) } }
	};
}
const natural = Array.from({ length: DAYS }, (_, t) => 20_000 + 15_000 * Math.sin(t / 29));
const run = (input: ModelInput): ModelOutput => {
	const out = runModelWith(input, () => ({ naturalFlowM3Day: natural }));
	expect(checkInvariants(input, out)).toBeNull();
	return out;
};
// A Reserve that asks for most of the natural flow (m³/s over the month, read off the run's own curve).
const rule = (siteNodeId: string | null): EwrRuleTable => ({
	siteNodeId,
	source: 'Synthetic',
	component: 'total',
	unit: 'm3s',
	points: [...DEFAULT_ASSURANCE_POINTS],
	ewr: rows(DEFAULT_ASSURANCE_POINTS.map((p) => (siteNodeId === null ? 0.3 : 0.2) * (1 - p / 150))),
	naturalSource: 'run',
	natural: null,
	scale: 1
});
const col = (out: ModelOutput, nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;

describe('the EWR charge from the Reserve rule table', () => {
	const tables = [rule(null), rule('g')];
	const pragmatic = run(network({}, tables));
	const byRule = run(network({ ewrChargeSource: 'ruleTable' }, tables));

	it("'pragmatic' is the default: the same run, byte for byte, as leaving the setting out", () => {
		expect(JSON.stringify(run(network({ ewrChargeSource: 'pragmatic' }, tables)))).toBe(JSON.stringify(pragmatic));
		expect(pragmatic.series.some((s) => s.key === 'ewr_charge_shortfall')).toBe(false);
		expect(pragmatic.summary.curtailment!.ewrSites!.some((s) => s.ewrSource)).toBe(false);
	});

	it('charges each site against its month’s requirement inside complete months, and the pragmatic EWR outside them', () => {
		for (const id of [null, 'g']) {
			const own = col(byRule, id, 'ewr_charge_shortfall')!;
			const req = col(byRule, id, 'ewr_rule')!;
			const flow = id === null ? col(byRule, null, 'simulated_outflow')! : col(byRule, id, 'outflow')!;
			const prag = col(byRule, id, 'ewr_shortfall')!;
			let inMonths = 0;
			for (let t = 0; t < DAYS; t++) {
				if (Number.isFinite(req[t]!)) {
					inMonths++;
					expect(own[t]).toBeCloseTo(Math.min(flow[t]! - req[t]!, 0), 6);
				} else expect(own[t]).toBe(prag[t]);
			}
			// The part months at either end: 17 days of October 2000 and 20 of September 2003.
			expect(DAYS - inMonths).toBe(17 + 20);
			// charged + natural = the shortfall the charge follows.
			const ch = col(byRule, id, 'ewr_charged')!;
			const nat = col(byRule, id, 'ewr_natural')!;
			for (let t = 0; t < DAYS; t++) expect(ch[t]! + nat[t]!).toBeCloseTo(own[t]!, 6);
		}
		expect(byRule.summary.warnings).toEqual(
			expect.arrayContaining([expect.stringMatching(/^EWR charge at the outlet \(out\): 37 days outside a complete calendar month follow the pragmatic EWR/)])
		);
	});

	it('changes who is charged, and never charges a farm more than its net impact that day', () => {
		const a = (o: ModelOutput) => col(o, 'a', 'ewr_charge')!;
		expect(a(byRule)).not.toEqual(a(pragmatic));
		const H = col(byRule, 'a', 'inflow_upstream')!;
		const I = col(byRule, 'a', 'runoff')!;
		const U = col(byRule, 'a', 'outflow')!;
		let charged = 0;
		a(byRule).forEach((c, t) => {
			if (c < 0) charged++;
			expect(-c).toBeLessThanOrEqual(Math.max(H[t]! + I[t]! - U[t]!, 0) * (1 + 1e-9) + 1e-9);
		});
		expect(charged).toBeGreaterThan(0);
		const sites = byRule.summary.curtailment!.ewrSites!;
		expect(sites.map((s) => [s.isOutlet, s.ewrSource])).toEqual([
			[true, 'ruleTable'],
			[false, 'ruleTable']
		]);
	});

	it('the water account’s EWR required is the rule table’s where it has one', () => {
		const ewr = byRule.summary.supplyAssurance!.waterAccount.total.ewr;
		const expectRequired = (id: string | null) => {
			const req = col(byRule, id, 'ewr_rule')!;
			const prag = id === null ? col(byRule, null, 'ewr')! : col(byRule, id, 'ewr_cumulative')!;
			return req.reduce((s, v, t) => s + (Number.isFinite(v) ? v : prag[t]!), 0);
		};
		for (const row of ewr) {
			expect(row.ewrSource).toBe('ruleTable');
			expect(row.requiredM3).toBeCloseTo(expectRequired(row.nodeId), 3);
		}
		for (const row of pragmatic.summary.supplyAssurance!.waterAccount.total.ewr) expect(row.ewrSource).toBeUndefined();
	});

	it('a site without a table keeps the pragmatic EWR; with no table at all the run says so', () => {
		const one = run(network({ ewrChargeSource: 'ruleTable' }, [rule('g')]));
		expect(col(one, null, 'ewr_charge_shortfall')).toBeUndefined();
		expect(col(one, 'g', 'ewr_charge_shortfall')).toBeDefined();
		const none = run(network({ ewrChargeSource: 'ruleTable' }, []));
		expect(none.summary.warnings).toContain('the EWR charge is set to follow the Reserve rule tables, but no EWR site has one: it follows the pragmatic EWR');
		const plain = run(network({}, []));
		expect(none.series).toEqual(plain.series);
	});

	it('an unknown value runs the default, with a warning', () => {
		const out = run(network({ ewrChargeSource: 'monthly' as never, lowFlowMeasure: 'median' as never }, tables));
		expect(out.series).toEqual(pragmatic.series);
		expect(out.summary.warnings).toEqual(expect.arrayContaining(['unknown EWR charge source "monthly"; using pragmatic', 'unknown low-flow measure "median"; using total']));
	});

	it('a scenario can switch both through settings.set, as a baseline change', () => {
		expect(settingsValueError('ewrChargeSource', 'ruleTable')).toBeNull();
		expect(settingsValueError('lowFlowMeasure', 'baseflow')).toBeNull();
		expect(settingsValueError('ewrChargeSource', 'monthly')).toMatch(/must be one of/);
		const r = applyScenario(network({}, tables), [
			{ op: 'settings.set', path: 'ewrChargeSource', value: 'ruleTable' },
			{ op: 'settings.set', path: 'lowFlowMeasure', value: 'baseflow' }
		]);
		expect(r.problems).toEqual([]);
		expect([r.input.settings.ewrChargeSource, r.input.settings.lowFlowMeasure]).toEqual(['ruleTable', 'baseflow']);
		expect(col(run(r.input), null, 'ewr_charge_shortfall')).toEqual(col(byRule, null, 'ewr_charge_shortfall'));
	});

	it('months are judged the same whichever the charge follows (the Reserve report is the rule table’s either way)', () => {
		expect(byRule.summary.ewrAssurance).toEqual(pragmatic.summary.ewrAssurance);
	});
});

describe('low flows on base flow in a resumed run (../warmstart, engine ≥ 1.6.0)', () => {
	const t = { ...rule(null), component: 'lowFlow' as const };
	const input = network({ lowFlowMeasure: 'baseflow' }, [t]);
	// The model's own natural flow, as runModelFrom has.
	const full = runModelWithoutChecks(input);

	it('carries the impacted flow the base-flow windows reach back into, and no base-flow sum', () => {
		const { snapshot } = runModelCapturing(input, '2002-05-17');
		const s = snapshot.state.reserveMonths[0]!;
		expect(s.carry).toMatchObject({ days: 16 });
		expect(s.carry).not.toHaveProperty('baseflow');
		// 730 days before 1 May 2002 reach back past the run's first day: the whole record so far.
		expect(s.history).toHaveLength(daysBetween(START, '2002-05-16'));
		expect(s.history).toEqual(Array.from(col(full, 'out', 'outflow')!).slice(0, s.history!.length));
		// Without the setting the snapshot carries none.
		expect(runModelCapturing(network({}, [t]), '2002-05-17').snapshot.state.reserveMonths[0]).not.toHaveProperty('history');
		// A snapshot missing the days it needs is refused, not judged on a shorter window.
		const cut = JSON.parse(JSON.stringify(snapshot));
		delete cut.state.reserveMonths[0].history;
		expect(() => runModelFrom(cut, input)).toThrow(/needs the 16 days of its first month/);
	});

	for (const at of ['2000-10-15', '2001-05-17', '2002-01-01', '2002-11-30', '2003-09-20']) {
		it(`a run resumed on ${at} judges every month as the uninterrupted run does, base flow to the bit`, () => {
			const tail = runModelFrom(JSON.parse(JSON.stringify(captureModelState(input, at))), input);
			const months = tail.summary.ewrAssurance![0]!.months;
			for (const m of months) {
				expect(m.baseflow).toBeDefined();
				expect(m).toEqual(full.summary.ewrAssurance![0]!.months.find((w) => w.year === m.year && w.month === m.month));
				expect(Object.is(m.baseflow, full.summary.ewrAssurance![0]!.months.find((w) => w.year === m.year && w.month === m.month)!.baseflow)).toBe(true);
			}
			// The month the snapshot splits is judged whole (every later one too).
			const d = new Date(toEpochDay(at) * 86_400_000);
			if (d.getUTCDate() > 1 && at !== START && at < '2003-09-01') expect(months[0]).toMatchObject({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
		});
	}
});

describe('a month’s base flow is causal (engine ≥ 1.6.0)', () => {
	// A table on its own natural curve, so the requirement doesn't move with the record either (K1).
	const table = (unit: 'mcm' | 'm3s'): EwrRuleTable => ({
		siteNodeId: null,
		source: 'Synthetic',
		component: 'total',
		unit,
		points: [10, 50, 90],
		ewr: rows([3, 2, 1]),
		lowFlow: rows([1, 0.6, 0.3]),
		naturalSource: 'table',
		natural: rows([30, 20, 10]),
		scale: unit === 'mcm' ? 1 : 1 / 2.6
	});

	it('appending days never changes a completed month’s base flow or low-flow verdict', () => {
		const rng = new Rng(1606);
		let compared = 0;
		let moved = 0;
		for (let k = 0; k < 30; k++) {
			const n = rng.int(40, 1500);
			const extra = rng.int(1, 120);
			const q = Array.from({ length: n + extra }, () => (rng.bool(0.08) ? rng.logFloat(1e6, 3e7) : rng.logFloat(1e3, 5e5)));
			const s0 = new Date(Date.UTC(1990 + rng.int(0, 20), rng.int(0, 11), rng.int(1, 28))).toISOString().slice(0, 10);
			const t = table(rng.pick(['mcm', 'm3s'] as const));
			const assess = (days: number) => assessSite(s0, days, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: q, impacted: q }, undefined, null, 'baseflow').report;
			const short = assess(n);
			const long = assess(n + extra);
			for (const m of short.months) {
				const w = long.months.find((x) => x.year === m.year && x.month === m.month)!;
				expect(Object.is(w.baseflow, m.baseflow)).toBe(true);
				expect(w.lowFlowMet).toBe(m.lowFlowMet);
				compared++;
			}
			// Positive control: the whole-record filter (engine 1.3.0–1.5.x) did move a completed month.
			const whole = (days: number) => lyneHollickBaseflow(q.slice(0, days));
			const a = whole(n);
			const b = whole(n + extra);
			if (a.some((v, i) => v !== b[i])) moved++;
		}
		expect(compared).toBeGreaterThan(100);
		expect(moved).toBeGreaterThan(0);
	});
});
