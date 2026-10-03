// Regression tests for the EWR / Reserve bugs the engine end-to-end tests found
// (fixed in engine 1.69.0; errata ER-20, ER-21), each asserting the behaviour
// docs/model.md documents. Invented catchments only; natural flow fed directly (runModelWith).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import type { EwrRuleTable } from '../reserve/rules';
import { runModelWith } from '../run';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 0,
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
const rows = (r: number[]) => Array.from({ length: 12 }, () => [...r]);
const table = (siteNodeId: string | null, over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
	siteNodeId,
	source: 'Invented test table',
	component: 'total',
	unit: 'mcm',
	points: [10, 90],
	ewr: rows([1, 0.5]),
	naturalSource: 'table',
	natural: rows([2, 1]),
	scale: 1,
	...over
});

function input(start: string, days: number, nodes: NetworkNode[], rules: EwrRuleTable[], extraSeries: Record<string, unknown> = {}, rainDays = days): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(0) as never, apanMm: new Array(12).fill(0) as never, ewrRules: rules },
		model: { nodes, crops: [], cropAreas: [], transfers: [] },
		series: { rain_catchment_mm: { startDate: start, values: new Array(rainDays).fill(1) }, ...extraSeries } as never
	};
}

// A → G (gauge, EWR site) → Z (outlet gauge). Ids chosen so the gauge sorts before the outlet's id.
const network = () => [node('A', { downstreamNodeId: 'G', areaKm2: 1 }), node('G', { kind: 'gauge', downstreamNodeId: 'Z' }), node('Z', { kind: 'gauge' })];
const START = '2003-10-01';
const DAYS = toEpochDay('2004-09-30') - toEpochDay(START) + 1;
const run = (inp: ModelInput, days = DAYS) => runModelWith(inp, () => ({ naturalFlowM3Day: new Array(days).fill(40_000) }));

describe('fixed in 1.69.0: a rule table keyed by the outlet node’s own id (low)', () => {
	it('the Reserve report lists the outlet first, then gauges by id (§2.9c "Report"), however the outlet’s table is keyed', () => {
		// The settings API and the ewrRule.set op accept any node id as siteNodeId, the outlet's included
		// (ewrRuleListIssues only refuses two tables with the same key). assessEwrRules sorts the tables by
		// siteNodeId ('' for null), so a table keyed 'Z' sorts after the gauge 'G' and the outlet comes second.
		const out = run(input(START, DAYS, network(), [table('Z'), table('G')]));
		expect(out.summary.ewrAssurance!.map((a) => (a.isOutlet ? 'outlet' : a.nodeId))).toEqual(['outlet', 'G']);
	});

	it('two usable tables for the outlet (one null, one keyed by its id): neither is used (§2.9c "Warnings")', () => {
		// The doc: "When a site has two usable tables … neither is used, from engine 0.24.1". resolveEwrRules
		// counts tables by their key, so null and 'Z' don't collide there; assessEwrRules then keeps the null
		// one and warns "a second EWR rule table … is ignored".
		const out = run(input(START, DAYS, network(), [table(null), table('Z', { ewr: rows([2, 2]) })]));
		expect(out.summary.ewrAssurance ?? []).toEqual([]);
	});
});

describe('fixed in 1.69.0: per-month daily compliance leaves out a forecast tail’s months (low)', () => {
	it('the months of the year add up to the site’s daily figures (§2.9c "the months of the year add up to the whole")', () => {
		// Recorded rain to 30 June 2004, forecast rain for July–September: those three months are assessed
		// (they are wholly in the tail) and counted in byMonth[].years/met and in the site's `daily`, but each
		// month of the year's `daily` is computed over the history's months only (assurance.ts byMonth:
		// dailyCompliance(list …), `list` being the history's rows that rank the natural curve).
		const start = '2002-10-01';
		const days = toEpochDay('2004-09-30') - toEpochDay(start) + 1;
		const rec = toEpochDay('2004-06-30') - toEpochDay(start) + 1;
		const nodes = [
			node('A', { downstreamNodeId: 'U', areaKm2: 1 }),
			node('U', { kind: 'user', downstreamNodeId: 'Z', userDemandM3Day: new Array(12).fill(30_000), userPriority: 'junior', userReturnPct: 0 }),
			node('Z', { kind: 'gauge' })
		];
		const inp = input(start, days, nodes, [table(null)], { rain_forecast_mm: { startDate: '2004-07-01', values: new Array(days - rec).fill(1) } }, rec);
		const out = runModelWith(inp, () => ({ naturalFlowM3Day: Array.from({ length: days }, (_, t) => 50_000 + 20_000 * Math.sin(t / 17)) }));
		const s = out.summary.ewrAssurance![0]!;
		// Positive control: the tail's months are assessed and counted per month of the year.
		expect(s.months.length).toBe(24);
		expect(s.byMonth.find((m) => m.month === 7)!.years).toBe(2);
		// Each month of the year's daily figures cover the same months as its verdicts…
		for (const m of s.byMonth) expect(m.daily!.days, `month ${m.month}`).toBe(s.months.filter((x) => x.month === m.month).reduce((a, x) => a + x.days, 0));
		// …and so add up to the site's.
		expect(s.byMonth.reduce((a, m) => a + m.daily!.days, 0)).toBe(s.daily!.days);
		expect(s.byMonth.reduce((a, m) => a + m.daily!.daysNotMet, 0)).toBe(s.daily!.daysNotMet);
	});
});
