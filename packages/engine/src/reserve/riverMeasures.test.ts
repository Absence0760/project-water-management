// No-flow days and "served in full while the site fails" (issue #71, engine ≥
// 1.33.0, docs/model.md §2.9e): the definitions on hand-made series, each with
// its positive control, and a real run's summary against its own daily series.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import { NO_FLOW_M3_DAY, noFlowDays, servedWhileEwrFails } from './riverMeasures';
import { blankEwrRuleTable } from './rules';

describe('noFlowDays', () => {
	it('counts days below 1 L/s and the longest spell; a day at the threshold flows', () => {
		const q = [100, NO_FLOW_M3_DAY, NO_FLOW_M3_DAY - 0.01, 0, 0, 500, 0, 86_400];
		expect(noFlowDays(q)).toEqual({ thresholdM3Day: 86.4, days: 4, longestRun: 3 });
		// Positive control: a river that never falls below the threshold has none.
		expect(noFlowDays([NO_FLOW_M3_DAY, 1e5])).toEqual({ thresholdM3Day: 86.4, days: 0, longestRun: 0 });
		// Only the first `days` days are read.
		expect(noFlowDays([0, 0, 0], 2).days).toBe(2);
	});
});

describe('servedWhileEwrFails', () => {
	const nodes = [
		{ id: 'O', name: 'Outlet', kind: 'gauge' },
		{ id: 'A', name: 'Farm A', kind: 'farm' },
		{ id: 'B', name: 'User B', kind: 'user' },
		{ id: 'C', name: 'Farm C', kind: 'farm' }
	];
	// Days 0–3 fail at the site; A is served in full on days 0 and 2, short on day 1, has no demand on day 3.
	const demand = [[0, 0, 0, 0, 0], [10, 10, 10, 0, 10], [5, 5, 5, 5, 5], [0, 0, 0, 0, 0]];
	const supplied = [[0, 0, 0, 0, 0], [10, 9, 10 - 1e-12, 0, 10], [0, 0, 0, 0, 5], [0, 0, 0, 0, 0]];
	const shortfall = [-1, -2, -0.5, -3, 0];

	it('counts a unit’s days with its whole demand met on the site’s failing days, not partial supply nor a day without demand', () => {
		const [site] = servedWhileEwrFails({ days: 5, sites: [{ nodeId: null, name: 'Outlet', ruleTable: false, shortfall, units: [1, 2, 3] }], nodes, demand, supplied });
		expect(site).toEqual({
			nodeId: null,
			name: 'Outlet',
			basis: 'pragmatic',
			daysNotMet: 4,
			// A: days 0 and 2 (a residue in the last bit is met); B: never in full while the site fails (day 4 passes); C: no demand, left out.
			units: [
				{ nodeId: 'A', name: 'Farm A', kind: 'farm', days: 2 },
				{ nodeId: 'B', name: 'User B', kind: 'user', days: 0 }
			]
		});
	});

	it('is 0 when the site never fails (positive control above), and names the rule-table basis', () => {
		const [site] = servedWhileEwrFails({ days: 5, sites: [{ nodeId: 'G', name: 'Gauge', ruleTable: true, shortfall: [0, 0, 0, 0, 0], units: [1] }], nodes, demand, supplied });
		expect(site).toMatchObject({ nodeId: 'G', basis: 'ruleTable', daysNotMet: 0, units: [{ nodeId: 'A', days: 0 }] });
	});
});

describe('a run’s summary (RunSummary.catchment.noFlow, servedWhileEwrFails)', () => {
	const node = (over: Partial<NetworkNode>): NetworkNode => ({
		id: 'x',
		name: 'x',
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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	});
	const start = '1990-10-01';
	const days = Math.round(3 * 365.25);
	const rng = new Rng(3);
	const d0 = toEpochDay(start);
	const rain = Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		return rng.bool([5, 6, 7, 8, 9].includes(m) ? 0.3 : 0.05) ? Math.round(rng.logFloat(0.5, 40) * 10) / 10 : 0;
	});
	// A small, dry catchment with a thirsty farm and a gauge above the outlet marked as an EWR site.
	const input: ModelInput = {
		settings: {
			runoffModel: 'gr4j',
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			gr4j: { x1: 420, x2: 0, x3: 85, x4: 2.1, warmupDays: 0 },
			ewrPragmaticM3PerDay: new Array(12).fill(3000) as never
		},
		model: {
			nodes: [
				node({ id: 'O', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'G', name: 'Mid gauge', kind: 'gauge', downstreamNodeId: 'O', ewrSite: true }),
				node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', areaKm2: 8, pctRunoffToDam: 1, damCapacityM3: 2e5, damAreaFullM2: 5e4 }),
				node({ id: 'U', name: 'Lower farm', downstreamNodeId: 'O', areaKm2: 2 })
			],
			crops: [{ id: 'c', name: 'Maize', cropFactor: new Array(12).fill(0.9) }],
			cropAreas: [
				{ nodeId: 'F', cropId: 'c', areaM2: 300_000 },
				{ nodeId: 'U', cropId: 'c', areaM2: 50_000 }
			],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: start, values: rain } }
	};
	const out = runModel(input);
	const col = (nodeId: string | null, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;

	it('counts the outlet’s no-flow days from its simulated outflow', () => {
		const q = col(null, 'simulated_outflow');
		const nf = out.summary.catchment.noFlow!;
		expect(nf.days).toBe(q.filter((v) => v < NO_FLOW_M3_DAY).length);
		expect(nf.days).toBeGreaterThan(0);
		expect(nf.days).toBeLessThan(q.length);
	});

	it('lists every EWR site, outlet first, with only the units upstream of each; the outlet’s days are the catchment’s', () => {
		const sites = out.summary.servedWhileEwrFails!;
		expect(sites.map((s) => [s.nodeId, s.basis])).toEqual([
			[null, 'pragmatic'],
			['G', 'pragmatic']
		]);
		expect(sites[0]!.daysNotMet).toBe(out.summary.catchment.ewrDaysNotMet);
		expect(sites[0]!.units.map((u) => u.nodeId).sort()).toEqual(['F', 'U']);
		expect(sites[1]!.units.map((u) => u.nodeId)).toEqual(['F']);
		// Recount the outlet's from the daily series.
		const short = col(null, 'ewr_shortfall');
		for (const u of sites[0]!.units) {
			const d = col(u.nodeId, 'demand');
			const g = col(u.nodeId, 'supplied');
			const n = short.filter((s, t) => s < 0 && d[t]! > 0 && d[t]! - g[t]! <= 1e-9 * d[t]!).length;
			expect(u.days, u.nodeId).toBe(n);
		}
		expect(sites[0]!.units.some((u) => u.days > 0)).toBe(true);
	});

	it('invariants, the charge on the pragmatic EWR or on a gauge’s rule table: counts within the site’s failing days, gauge units a subset of the outlet’s', () => {
		const table = { ...blankEwrRuleTable('G'), source: 'Invented test table', ewr: Array.from({ length: 12 }, () => [0.5, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.1, 0.05, 0.01]) };
		const variants: ModelInput[] = [
			input,
			{ ...input, settings: { ...input.settings, ewrRules: [table], ewrChargeSource: 'ruleTable' } },
			{ ...input, settings: { ...input.settings, ewrPragmaticM3PerDay: new Array(12).fill(10) as never } }
		];
		for (const [k, v] of variants.entries()) {
			const o = runModel(v);
			const sites = o.summary.servedWhileEwrFails!;
			expect(sites[0]!.nodeId, `variant ${k}`).toBeNull();
			if (k !== 1) expect(sites[0]!.daysNotMet).toBe(o.summary.catchment.ewrDaysNotMet);
			expect(sites[1]!.basis).toBe(k === 1 ? 'ruleTable' : 'pragmatic');
			if (k === 1) {
				// The gauge's failing days are the rule-table charge's own (ewr_charge_shortfall).
				const sh = o.series.find((x) => x.nodeId === 'G' && x.key === 'ewr_charge_shortfall')!.values;
				expect(sites[1]!.daysNotMet).toBe(sh.filter((x) => x < 0).length);
			}
			const outletUnits = new Set(sites[0]!.units.map((u) => u.nodeId));
			for (const site of sites) {
				for (const u of site.units) {
					expect(u.days).toBeGreaterThanOrEqual(0);
					expect(u.days).toBeLessThanOrEqual(site.daysNotMet);
					expect(outletUnits.has(u.nodeId)).toBe(true);
				}
			}
			const q = o.series.find((x) => x.nodeId === null && x.key === 'simulated_outflow')!.values;
			const nf = o.summary.catchment.noFlow!;
			expect(nf.longestRun).toBeLessThanOrEqual(nf.days);
			expect(nf.days).toBeLessThanOrEqual(q.length);
			if (Math.min(...q) >= NO_FLOW_M3_DAY) expect(nf.days).toBe(0);
		}
	});
});
