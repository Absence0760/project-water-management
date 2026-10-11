// A cap or full-allocation run as a viewer kept from each registered volume
// reads it: river outcomes only, an allowlist (issue #523 finding I, its round
// 4, riverOutcomes.ts). Synthetic figures and the engine's fuzz networks only.
import { runModelChecked, type ModelInput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import {
	ALLOCATION_SERIES_KEYS,
	ensembleRiverOutcomes,
	reportRiverOutcomesOnly,
	riverOutcomesOnly,
	riverOutcomesReport,
	riverOutcomesSummary,
	riverSeries
} from './riverOutcomes.js';
import { redactRunAllocations } from './viewerUnits.js';
import { sweepForViewer } from '../sweeps/routes.js';
import type { SweepRow } from '../sweeps/store.js';
import { withholdingFor } from '../runs/withheldSeries.js';

const VOLUME = 123_457;
const summary = (mode: string) => ({
	historyDays: 365,
	farms: [{ nodeId: 'a', name: 'Farm A', avgDemandM3Day: VOLUME / 365 }],
	users: [{ nodeId: 'u', name: 'Town', avgDemandM3Day: 3 }],
	groundwaterAnnualUse: [{ nodeId: 'a', waterYear: 2021, boreholes: [] }],
	curtailment: { farms: [{ nodeId: 'a' }], totals: { demandM3Day: VOLUME / 365 + 12 } },
	waterBalance: { years: [{ waterYear: 2021, demandM3: VOLUME + 4380, suppliedM3: VOLUME }], total: { demandM3: VOLUME + 4380 } },
	supplyAssurance: { waterAccount: { total: { useM3: VOLUME } }, reliability: [{ nodeId: 'a' }] },
	plausibility: { abstractionM3: VOLUME },
	verification: { maxResidual: { nodeId: 'a', name: 'Farm A', value: 1e-9 } },
	ewrCompliance: { waterYears: [2021], days: [[1]], outlet: { daysNotMet: 4 }, farms: [{ nodeId: 'a' }] },
	ewrAssurance: [{ nodeId: 'gauge', name: 'Weir', overall: { rate: 0.8 } }],
	servedWhileEwrFails: [{ nodeId: 'gauge', name: 'Weir', basis: 'pragmatic', daysNotMet: 4, units: [{ nodeId: 'a', days: 3 }] }],
	catchment: { meanNaturalFlowM3Day: 900, meanSimulatedOutflowM3Day: 500, ewrDaysNotMet: 4, ewrFractionDaysNotMet: 0.01 },
	calibration: null,
	forecast: { from: '2022-01-01', to: '2022-01-10', days: 10, lastObserved: '2021-12-31', rainMm: 3, perFarm: [{ nodeId: 'a' }], outletEwrDaysAtRisk: 1 },
	dataQuality: { observedAgreement: null, areaMismatches: [{ nodeId: 'a' }] },
	allocations: { mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [{ nodeId: 'a', name: 'Farm A', sources: [] }] },
	warnings: [`allocation cap: at its maximum rate allocation x can take at most 31536 m³ in a year, less than its ${VOLUME} m³`]
});

/** Every number in a JSON value. */
const numbers = (v: unknown): number[] => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbers) : []);

describe('which runs give a viewer kept from the volumes their river outcomes only', () => {
	it('a cap or full-allocation run; not a compare-only run or one without allocations', () => {
		expect(riverOutcomesOnly({ mode: 'cap' })).toBe(true);
		expect(riverOutcomesOnly({ mode: 'fullAllocation' })).toBe(true);
		expect(riverOutcomesOnly({ mode: 'none' })).toBe(false);
		expect(riverOutcomesOnly(null)).toBe(false);
	});

	it('the series: listed catchment and gauge series only; the allocation series on no run', () => {
		const gauges = new Set(['g']);
		expect(riverSeries(gauges, null, 'simulated_outflow')).toBe(true);
		expect(riverSeries(gauges, null, 'natural_flow')).toBe(true);
		expect(riverSeries(gauges, null, 'restriction_level')).toBe(false);
		expect(riverSeries(gauges, 'g', 'outflow')).toBe(true);
		expect(riverSeries(gauges, 'g', 'supplied')).toBe(false);
		expect(riverSeries(gauges, 'a', 'outflow')).toBe(false);
		const capped = withholdingFor({ mode: 'cap' }, gauges);
		expect([capped.withheld('a', 'outflow'), capped.withheld('g', 'outflow'), capped.withheld(null, 'ewr_shortfall')]).toEqual([true, false, false]);
		const plain = withholdingFor({ mode: 'none' }, gauges);
		expect([plain.withheld('a', 'supplied'), plain.withheld('a', 'allocation_room_surface')]).toEqual([false, true]);
		expect(ALLOCATION_SERIES_KEYS.size).toBe(5);
	});
});

describe('a run summary as that viewer reads it', () => {
	for (const mode of ['cap', 'fullAllocation'])
		it(`${mode}: the river's only, no unit's (bound or not) and no use total; the rest named withheld`, () => {
			const out = riverOutcomesSummary(summary(mode)) as Record<string, unknown> & ReturnType<typeof summary>;
			expect(Object.keys(out).sort()).toEqual(
				['allocations', 'calibration', 'catchment', 'dataQuality', 'ewrAssurance', 'ewrCompliance', 'farms', 'forecast', 'historyDays', 'servedWhileEwrFails', 'users', 'warnings', 'withheld'].sort()
			);
			expect(out.farms).toEqual([]);
			expect(out.users).toEqual([]);
			expect(out.warnings).toEqual([]);
			expect(out.ewrCompliance.farms).toEqual([]);
			expect(out.servedWhileEwrFails[0]!.units).toEqual([]);
			expect(out.forecast.perFarm).toEqual([]);
			expect(out.dataQuality).toEqual({ observedAgreement: null });
			expect(out.allocations).toEqual({ mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [], riverOutcomesOnly: true });
			expect(out.withheld).toEqual(['curtailment', 'groundwaterAnnualUse', 'plausibility', 'supplyAssurance', 'verification', 'waterBalance']);
			// The round-4 probe: no figure, nor any difference of two, gives the volume.
			const n = numbers(out);
			expect(n.some((a) => n.some((b) => Math.abs(a - b - VOLUME) < 1 || Math.abs(a - b - VOLUME / 365) < 1e-3))).toBe(false);
			expect(JSON.stringify(out)).not.toMatch(/"a"/);
			expect(riverOutcomesSummary(out)).toBe(out);
		});

	it('a compare-only run comes back as it is (positive control), and the probe finds the volume in the full summary', () => {
		const s = summary('none');
		expect(riverOutcomesSummary(s)).toBe(s);
		const n = numbers(summary('fullAllocation'));
		expect(n.some((a) => n.some((b) => Math.abs(a - b - VOLUME) < 1))).toBe(true);
	});

	it('redactRunAllocations and a sweep member go through it', () => {
		expect((redactRunAllocations({ summary: summary('cap') }).summary as { farms: unknown[] }).farms).toEqual([]);
		const sweep = { id: 's', members: [{ name: 'm', ops: [], summary: summary('fullAllocation') }] } as unknown as SweepRow;
		expect(JSON.stringify(sweepForViewer(sweep))).not.toContain(String(VOLUME));
	});

	// Round 4 (I), probes 2 and 3: the engine's own summaries of random networks, in each mode.
	it('fuzz: no unit of any engine summary is left anywhere, at any depth', () => {
		let runs = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const input = randomInput(seed, { maxNodes: 8, maxDays: 500 }) as ModelInput;
			if (!input.model.allocations?.length) continue;
			const units = new Set(input.model.nodes.filter((n) => n.kind !== 'gauge').map((n) => n.id));
			for (const mode of ['cap', 'fullAllocation'] as const) {
				const out = riverOutcomesSummary(runModelChecked({ ...input, settings: { ...input.settings, allocationMode: mode } }).summary);
				const left: string[] = [];
				const walk = (v: unknown, at: string): void => {
					if (typeof v === 'string' && units.has(v)) left.push(at);
					else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (units.has(k) ? left.push(`${at}.${k}`) : walk(x, `${at}.${k}`));
				};
				walk(out, `seed ${seed} ${mode}`);
				expect(left).toEqual([]);
				runs++;
			}
		}
		expect(runs).toBeGreaterThan(10);
	}, 120_000);
});

describe('an ensemble of such a run', () => {
	it('each member the river’s metrics only, every unit list empty', () => {
		const metrics = { ewrDaysNotMet: 3, shortfallMm3: 1, curtailmentM3Day: { a: -2 }, unitDemandM3Day: { a: VOLUME / 365 }, unitSuppliedM3Day: { a: 1 }, reserveRate: { outlet: 0.9 } };
		const row = { result: { header: { farms: [{ nodeId: 'a' }], units: [{ nodeId: 'a' }], reserveSites: [{ key: 'outlet' }] }, members: [{ index: 0, metrics }] }, summary: { reference: metrics, bands: { curtailment: [{ nodeId: 'a' }], supply: [{ nodeId: 'a' }], ewrDaysNotMet: { p50: 3 } } } };
		const out = ensembleRiverOutcomes(row);
		expect(out.result.members[0]!.metrics).toEqual({ ewrDaysNotMet: 3, shortfallMm3: 1, reserveRate: { outlet: 0.9 }, curtailmentM3Day: {} });
		expect(out.result.header).toEqual({ farms: [], units: [], reserveSites: [{ key: 'outlet' }] });
		expect(out.summary.bands).toEqual({ curtailment: [], supply: [], ewrDaysNotMet: { p50: 3 } });
		expect(JSON.stringify(out)).not.toContain('"a"');
	});
});

describe('an evidence report on such a run', () => {
	const report = (mode: string) => ({
		rows: [{ id: 'reserve' }, { id: 'userSupply' }, { id: 'applicantSupply' }, { id: 'registeredUse' }, { id: 'ewrDays' }],
		flags: [{ id: 'noRule' }, { id: 'allocationsOver' }, { id: 'plausibility' }],
		questions: ['What is Farm A’s supply?'],
		users: [{ nodeId: 'a', suppliedB: 0.5 }],
		servedWhileFailing: { notAssessed: null, sites: [{ key: 'outlet', name: 'Weir', isOutlet: true, basis: 'x', daysNotMetA: 1, daysNotMetB: 2, units: [{ nodeId: 'a' }] }] },
		allocations: { notAssessed: null, modeA: 'none', modeB: mode, toleranceA: 0.1, toleranceB: 0.1, units: [{ nodeId: 'a' }], notMatchedA: 0, notMatchedB: 0, unitYears: { overA: 1 } },
		demandObjects: { objects: [] },
		uncertainty: { paired: { curtailment: [{ nodeId: 'a' }] } },
		river: [{ key: 'outlet' }],
		appendix: { warnings: { baseline: ['w'], application: ['allocation cap: 123457 m³'] } },
		summaries: { baseline: summary('none'), application: summary(mode) }
	});

	it('page 1’s river rows and flags, the EWR sites; no unit, no supply, no § 5 unit, no warning; the sections named', () => {
		const out = riverOutcomesReport(report('cap')) as ReturnType<typeof report> & { withheld: string[] };
		expect(reportRiverOutcomesOnly(out)).toBe(true);
		expect(out.rows.map((r) => r.id)).toEqual(['reserve', 'ewrDays']);
		expect(out.flags.map((f) => f.id)).toEqual(['noRule']);
		expect([out.users, out.questions, out.allocations.units, out.servedWhileFailing.sites[0]!.units]).toEqual([[], [], [], []]);
		expect(out.demandObjects).toBeNull();
		expect(out.uncertainty.paired.curtailment).toEqual([]);
		expect(out.appendix.warnings).toEqual({ baseline: [], application: [] });
		expect(out.summaries.application.farms).toEqual([]);
		expect(out.river).toEqual([{ key: 'outlet' }]);
		expect(out.withheld).toContain('users');
		expect(JSON.stringify(out.summaries.application)).not.toContain(String(VOLUME));
	});

	it('a report on two compare-only runs comes back as it is (positive control)', () => {
		const r = report('none');
		expect(riverOutcomesReport(r)).toBe(r);
	});
});
