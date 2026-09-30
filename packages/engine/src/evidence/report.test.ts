// The licensing evidence report (issue #71, docs/design/evidence-report.md §11):
// fixed sections and rows with absence printed, the refusal and issue checks
// each with a positive control, the cited ensemble (G4), determinism, and
// parity with the compare page's numbers (G14). Real engine runs of a
// synthetic catchment: two farms and a gauge, an invented Reserve table.
import { describe, expect, it } from 'vitest';
import { compareAllocations, type AllocationEntry } from '../allocations/compare';
import { toEpochDay } from '../calendar';
import { compareRuns } from '../compare';
import { ENGINE_ERRATA } from '../liability/errata.generated';
import { KNOWN_LIMITATIONS } from '../liability/limitations.generated';
import { METHODOLOGY } from '../liability/methodology.generated';
import { canonicalJson } from '../manifest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { ENGINE_VERSION } from '../version';
import { blankEwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import { resolveEnsembleOptions, runEnsemble, summariseEnsemble } from '../uncertainty/ensemble';
import type { DeclaredUncertaintyRule } from '../uncertainty/options';
import { runPairedEnsemble, summarisePaired } from '../uncertainty/paired';
import { band as bandOf } from '../uncertainty/bands';
import { licenceImpactByYearClass } from '../views/licenceImpact';
import {
	ALLOCATIONS_NOT_ASSESSED,
	BASIS_NO_FLOW,
	BASIS_PRAGMATIC,
	citedEnsemble,
	CUMULATIVE_BASIS,
	CUMULATIVE_NO_BAND,
	CUMULATIVE_NONE,
	CUMULATIVE_TRUNCATED,
	driestMonth,
	evidenceChecks,
	evidenceReport,
	firstSiteBelow,
	NO_BAND,
	NOT_ASSESSED_NO_SITE_BELOW,
	worksNodeIds
} from './report';
import type { EnsembleHeader, MemberMetrics, MemberResult } from '../uncertainty/ensemble';
import { ENSEMBLE_MEASURES_SINCE } from '../version';
import type { ScenarioOp } from '../scenario/ops';
import type { EvidenceEnsembleInput, EvidenceInput, EvidenceOtherApplicationInput, EvidenceRunInput } from './types';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
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
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const TRUTH = { x1: 420, x2: 0, x3: 85, x4: 2.1 };
const START = '1990-10-01';
const RULE: DeclaredUncertaintyRule = { members: 40, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: 0.3, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 200 } };

/** The invented Reserve table at the outlet: a requirement the catchment meets in some months and not others. */
function reserveTable() {
	const t = blankEwrRuleTable(null);
	return { ...t, source: 'Invented test table', ewr: Array.from({ length: 12 }, (_, m) => t.points.map((_, i) => (0.25 + 0.1 * (m % 3)) * (1 - i / t.points.length))) };
}

/** The baseline: two farms (Farm two is the applicant's) with crops, draining to a gauge; the gauge record is the model's own flow with noise. */
function baseInput(opts: { rule?: DeclaredUncertaintyRule | null; reserve?: boolean; midGauge?: boolean } = {}): ModelInput {
	const days = Math.round(5 * 365.25);
	const r = rain(days, START, 7);
	const noise = new Rng(11);
	const input: ModelInput = {
		settings: {
			runoffModel: 'gr4j',
			apanMm: apan as never,
			gr4j: { ...TRUTH, warmupDays: 365 },
			ewrPragmaticM3PerDay: [9000, 9000, 6000, 4000, 4000, 5000, 8000, 12000, 15000, 15000, 12000, 10000] as never,
			...(opts.reserve === false ? {} : { ewrRules: [reserveTable()] }),
			...(opts.rule === null ? {} : { evidenceUncertaintyRule: opts.rule ?? RULE })
		},
		model: {
			nodes: [
				node({ id: 'G', name: 'Gauge', kind: 'gauge' }),
				node({ id: 'F1', name: 'Farm one', downstreamNodeId: 'G', areaKm2: 25 }),
				// With midGauge, an EWR site between Farm two and Farm one.
				...(opts.midGauge ? [node({ id: 'S', name: 'Weir', kind: 'gauge', downstreamNodeId: 'F1', ewrSite: true })] : []),
				node({ id: 'F2', name: 'Farm two', downstreamNodeId: opts.midGauge ? 'S' : 'F1', areaKm2: 15 })
			],
			crops: [{ id: 'c', name: 'Maize', cropFactor: new Array(12).fill(0.8) }],
			cropAreas: [
				{ nodeId: 'F1', cropId: 'c', areaM2: 400_000 },
				{ nodeId: 'F2', cropId: 'c', areaM2: 300_000 }
			],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: r },
			rain_chirps_mm: { startDate: START, values: r.map((v) => Math.round(v * 0.9 * noise.float(0.7, 1.3) * 10) / 10) }
		}
	};
	const flow = runModel(input).series.find((s) => s.key === 'simulated_outflow')!.values;
	input.series.flow_observed_m3s = { startDate: START, values: flow.map((q) => (q / 86_400) * noise.float(0.85, 1.15)) };
	return input;
}

/** The application: Farm two builds a dam and doubles its maize. */
function applicationInput(base: ModelInput): ModelInput {
	return {
		...base,
		model: {
			...base.model,
			nodes: base.model.nodes.map((n) => (n.id === 'F2' ? { ...n, pctRunoffToDam: 1, pctUpstreamToDam: 1, damCapacityM3: 1.5e6, damAreaFullM2: 3e5 } : n)),
			cropAreas: base.model.cropAreas.map((a) => (a.nodeId === 'F2' ? { ...a, areaM2: 600_000 } : a))
		}
	};
}

function stored(id: string, input: ModelInput, out: ModelOutput, over: Partial<EvidenceRunInput> = {}): EvidenceRunInput {
	return {
		id,
		label: id,
		engineVersion: '1.30.0',
		runoffModel: 'gr4j',
		startDate: START,
		endDate: out.summary.curtailment!.reportEnd,
		createdAt: '2026-09-01T00:00:00.000Z',
		createdBy: 'Hydrologist',
		trigger: 'manual',
		summary: out.summary,
		inputs: {
			settings: input.settings as never,
			model: input.model,
			series: Object.fromEntries(Object.entries(input.series).map(([k, s]) => [k, { startDate: s!.startDate, length: s!.values.length, valuesSha256: `${k}-sha` }]))
		},
		notes: '',
		notesUpdatedAt: null,
		notesUpdatedBy: null,
		...over
	};
}

// One fixture for the file: the runs, a 40-member ensemble on the declared rule and its paired band.
const base = baseInput();
const app = applicationInput(base);
const baseOut = runModel(base);
const appOut = runModel(app);
const { options } = resolveEnsembleOptions(base, { members: RULE.members, bounds: RULE.bounds, panOffset: RULE.panOffset, thresholds: RULE.thresholds });
const ensemble = runEnsemble(base, { ...options, seed: 4242 });
const pairedRun = runPairedEnsemble(app, ensemble);

const ens = (over: Partial<EvidenceEnsembleInput>): EvidenceEnsembleInput => ({
	id: 'e1',
	runId: 'base',
	baselineId: null,
	status: 'complete',
	seed: 4242,
	members: RULE.members,
	options: { ...options, seed: 4242 },
	createdAt: '2026-09-02T00:00:00.000Z',
	createdBy: 'Hydrologist',
	completedAt: '2026-09-02T00:10:00.000Z',
	accepted: ensemble.members.filter((m) => m.accepted).length,
	summary: summariseEnsemble(ensemble),
	paired: null,
	...over
});
// As the backend recomputes it: with the application's own units (the applicant's supply band).
const PAIRED = ens({ id: 'p1', runId: 'app', baselineId: 'e1', summary: null, paired: summarisePaired(ensemble, pairedRun, { own: ['F2'] }) });

function input(over: Partial<EvidenceInput> = {}): EvidenceInput {
	const b = stored('base', base, baseOut);
	return {
		project: { id: 'proj', name: 'Sandspruit' },
		baseline: b,
		application: {
			...stored('app', app, appOut),
			scenario: {
				id: 'scn',
				name: 'Farm two dam',
				description: 'A 1.5 million m³ dam on Farm two.',
				status: 'submitted',
				ownerName: 'Applicant',
				baseRunId: 'base',
				ops: [
					{ op: 'node.set', nodeId: 'F2', field: 'damCapacityM3', value: 1.5e6 },
					{ op: 'cropArea.set', nodeId: 'F2', cropId: 'c', areaM2: 600_000 }
				] as never,
				opsSha256: 'ops-sha',
				ownedNodeIds: ['F2'],
				classified: ['proposal', 'proposal']
			}
		},
		nominations: [{ withdrawn: false, runId: 'base', runLabel: 'base', runoffModel: 'gr4j', engineVersion: '1.30.0', reason: 'Calibrated baseline', nominatedAt: '2026-09-01T12:00:00.000Z', nominatedBy: 'Hydrologist' }],
		publication: { current: { runId: 'base', publishedAt: '2026-09-01T13:00:00.000Z', publishedBy: 'Hydrologist' }, previous: null },
		ensembles: { baseline: [ens({})], paired: [PAIRED] },
		changes: [{ area: 'network', kind: 'changed', subject: 'Farm two', text: 'Farm two: dam capacity 0 → 1 500 000 m³' }],
		history: null,
		applicationRuns: [{ runId: 'app', label: 'app', scenarioName: 'Farm two dam', createdAt: '2026-09-03T00:00:00.000Z', createdBy: 'Applicant' }],
		otherApplications: [],
		otherApplicationsTruncated: false,
		liability: { methodology: METHODOLOGY, limitations: KNOWN_LIMITATIONS, errata: ENGINE_ERRATA, disclaimerVersion: 'd-1' },
		...over
	};
}

const ids = (r: ReturnType<typeof evidenceReport>) => r.rows.map((x) => x.id);

describe('evidenceReport: an application on the nominated run', () => {
	const r = evidenceReport(input());

	it('passes every refusing and issue-blocking check, and cites the ensemble on the declared rule', () => {
		expect(r.mode).toBe('application');
		expect(r.refused).toBe(false);
		expect(r.checks.filter((c) => !c.passed && c.blocksIssue)).toEqual([]);
		expect(r.issuable).toBe(true);
		expect(r.uncertainty.cited?.id).toBe('e1');
		expect(r.uncertainty.paired?.members).toBeGreaterThan(0);
		expect(r.rules.r1).toBe(summariseEnsemble(ensemble).decisionRule);
		expect(r.rules.r2).toMatch(/percentiles of the difference/);
		expect(r.identity.baseline.nomination?.reason).toBe('Calibrated baseline');
		expect(r.identity.baseline.published).toBe('this');
		expect(r.identity.application?.proposals).toBe(2);
	});

	it('has the fixed page-1 rows, in order, each measure labelled with its basis', () => {
		expect(ids(r).slice(0, 8)).toEqual(['reserve', 'ewrDays', 'shortfall', 'noFlowDays', 'ewrBelowWorks', 'outflowMar', 'applicantSupply', 'registeredUse']);
		expect(r.rows.find((x) => x.id === 'ewrDays')!.basis).toBe(BASIS_PRAGMATIC);
		expect(r.rows[0]!.basis).toMatch(/^Reserve rule table \(Invented test table\)/);
		for (const row of r.rows) expect(row.notAssessed === null || row.notAssessed.length > 10, row.id).toBe(true);
	});

	it('pairs every banded change and counts "worse in k of n" (D-U1, D-U3), never an unpaired difference', () => {
		const days = r.rows.find((x) => x.id === 'ewrDays')!;
		const p = r.uncertainty.paired!;
		expect(days.change!.band).toEqual(p.ewrDaysNotMet);
		expect(days.change!.worse).toEqual({ k: Math.round(p.ewrDaysNotMetWorse! * p.members), n: p.members });
		const reserve = r.rows.find((x) => x.id === 'reserve')!;
		expect(reserve.change!.worse?.n).toBe(p.members);
		expect(reserve.change!.band!.p50).toBeCloseTo(p.reserve[0]!.band.p50! * 100, 9);
		// The applicant's own supply (ER4): the paired band on Σ supplied ÷ Σ demand over its units, in percentage points.
		const own = r.rows.find((x) => x.id === 'applicantSupply')!;
		expect(own.change!.band!.p50).toBeCloseTo(p.ownSupply!.band.p50! * 100, 9);
		expect(own.change!.worse).toEqual({ k: Math.round(p.ownSupply!.worse! * p.members), n: p.members });
	});

	it('gives page 1 the compare page’s numbers for the same pair (G14 parity)', () => {
		const cmp = compareRuns({ engineVersion: '1.30.0', startDate: 'a', endDate: 'b', summary: baseOut.summary }, { engineVersion: '1.30.0', startDate: 'a', endDate: 'b', summary: appOut.summary });
		const days = r.rows.find((x) => x.id === 'ewrDays')!;
		expect(days.baseline).toBe(cmp.catchment.ewrDaysNotMet.a);
		expect(days.application).toBe(cmp.catchment.ewrDaysNotMet.b);
		expect(days.change!.run).toBe(cmp.catchment.ewrDaysNotMet.delta);
		const out = r.rows.find((x) => x.id === 'outflowMar')!;
		expect(out.change!.run! * 1e6).toBeCloseTo(cmp.catchment.meanSimulatedOutflowM3Day.delta! * 365.25, 3);
		const reserve = r.rows.find((x) => x.id === 'reserve')!;
		expect(reserve.change!.run! / 100).toBeCloseTo(cmp.ewrAssurance![0]!.rate.delta!, 12);
		for (const u of r.rows.filter((x) => x.id === 'userSupply' && x.subject)) {
			const f = cmp.farms.find((x) => x.name === u.subject)!;
			expect(u.change!.run! / 100).toBeCloseTo(f.fractionSupplied.delta!, 12);
		}
	});

	it('has the ensemble’s own numbers for the run: the shortfall and outflow match member 0 (the run itself)', () => {
		const ref = summariseEnsemble(ensemble).reference;
		if (!ref) return; // the run failed its own rule on this seed; the flag test covers that case
		expect(r.rows.find((x) => x.id === 'shortfall')!.baseline!).toBeCloseTo(ref.shortfallMm3, 4);
		expect(r.rows.find((x) => x.id === 'outflowMar')!.baseline!).toBeCloseTo(ref.marOutflowMm3, 4);
	});

	it('draws the river per site: months of both runs, lost and gained, the worst month-year', () => {
		expect(r.river).toHaveLength(1);
		const s = r.river[0]!;
		expect(s.key).toBe('outlet');
		expect(s.months.length).toBe(baseOut.summary.ewrAssurance![0]!.months.length);
		expect(s.lost).toBe(s.months.filter((m) => m.metA && m.metB === false).length);
		expect(s.worst).not.toBeNull();
		expect(s.category).toBeNull();
		expect(s.byMonth.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('ranks the months where the river loses most by the paired median', () => {
		const med = r.worstMonths.map((m) => m.median);
		expect([...med].sort((x, y) => y - x)).toEqual(med);
		expect(r.worstMonths.length).toBeLessThanOrEqual(3);
		for (const m of r.worstMonths) expect(m.median).toBeGreaterThan(0);
		for (const m of r.improvingMonths) expect(m.median).toBeLessThan(0);
	});

	it('keeps the applicant’s words in Appendix C only (G13)', () => {
		expect(r.applicantStatement?.description).toBe('A 1.5 million m³ dam on Farm two.');
		const page1 = JSON.stringify({ identity: r.identity, flags: r.flags, rows: r.rows, questions: r.questions });
		expect(page1).not.toContain('A 1.5 million m³ dam on Farm two.');
	});

	it('lists every input series with its hash, and every warning verbatim', () => {
		expect(r.appendix.series.filter((s) => s.run === 'baseline').map((s) => s.kind)).toEqual(Object.keys(base.series).sort());
		expect(r.appendix.warnings.baseline).toEqual(baseOut.summary.warnings);
		expect(r.appendix.warnings.application).toEqual(appOut.summary.warnings);
		expect(r.verification.methodology.sha256).toBe(METHODOLOGY.sha256);
	});

	it('is deterministic: the same input twice, or with its keys in another order, gives the same document', () => {
		const again = evidenceReport(input());
		expect(canonicalJson(again)).toBe(canonicalJson(r));
		const shuffled = JSON.parse(JSON.stringify(input(), (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
		expect(canonicalJson(evidenceReport(shuffled))).toBe(canonicalJson(r));
		// Positive control: a changed input changes it.
		expect(canonicalJson(evidenceReport(input({ changes: [] })))).not.toBe(canonicalJson(r));
	});
});

describe('evidenceChecks: every refusal, each with its positive control', () => {
	const failing = (i: EvidenceInput) => evidenceChecks(i).filter((c) => !c.passed).map((c) => c.id);
	const withApp = (over: Partial<NonNullable<EvidenceInput['application']>>) => {
		const i = input();
		return { ...i, application: { ...i.application!, ...over } };
	};

	it('passes on the good input (the control for every case below)', () => {
		expect(failing(input()).filter((id) => id !== 'coverage')).toEqual([]);
	});

	it('refuses a baseline that isn’t the current nomination, or after a withdrawal', () => {
		const other = input({ nominations: [{ ...input().nominations[0]!, runId: 'other', runLabel: 'Another run' }] });
		expect(failing(other)).toContain('nominated');
		expect(evidenceReport(other).refused).toBe(true);
		const withdrawn = input({ nominations: [...input().nominations, { ...input().nominations[0]!, withdrawn: true, runId: null, nominatedAt: '2026-09-05T00:00:00.000Z' }] });
		expect(evidenceChecks(withdrawn).find((c) => c.id === 'nominated')!.detail).toMatch(/withdrawn/);
		expect(failing(input({ nominations: [] }))).toContain('nominated');
	});

	it('refuses another base, engine, period or runoff model, and a forecast or legacy run', () => {
		const i = input();
		expect(failing(withApp({ scenario: { ...i.application!.scenario, baseRunId: 'older' } }))).toEqual(expect.arrayContaining(['base']));
		expect(failing(withApp({ engineVersion: '1.29.0' }))).toContain('engine');
		expect(failing(withApp({ endDate: '1994-09-30' }))).toContain('period');
		expect(failing(withApp({ runoffModel: 'legacy' }))).toContain('runoffModel');
		expect(failing(withApp({ trigger: 'forecast' }))).toContain('notForecast');
		expect(failing(input({ baseline: { ...i.baseline, runoffModel: 'legacy' } }))).toContain('notLegacy');
		for (const bad of [withApp({ engineVersion: '1.29.0' }), withApp({ trigger: 'forecast' })]) expect(evidenceReport(bad).refused).toBe(true);
	});

	it('previews a baseline-assumption change with the red banner, but never issues it (G3)', () => {
		const i = input();
		const r = evidenceReport(withApp({ scenario: { ...i.application!.scenario, classified: ['proposal', 'baseline'] } }));
		expect(r.refused).toBe(false);
		expect(r.assumptionsChanged).toBe(true);
		expect(r.issuable).toBe(false);
		expect(r.flags[0]).toMatchObject({ id: 'assumptions', level: 'red' });
		expect(r.ops.map((o) => o.class)).toEqual(['proposal', 'baseline']);
	});
});

describe('the cited ensemble (G4) and the declared rule (ER3)', () => {
	it('cites the first complete ensemble on the declared rule, and lists every start', () => {
		const later = ens({ id: 'e2', seed: 99, createdAt: '2026-09-04T00:00:00.000Z' });
		const offRule = ens({ id: 'e3', options: { ...options, seed: 7, thresholds: { ...options.thresholds, minSkill: 0.1 } }, createdAt: '2026-09-01T06:00:00.000Z' });
		const started = ens({ id: 'e0', status: 'started', summary: null, accepted: null, completedAt: null, createdAt: '2026-08-30T00:00:00.000Z' });
		const rows = [later, offRule, ens({}), started];
		expect(citedEnsemble(rows, RULE)?.id).toBe('e1');
		const r = evidenceReport(input({ ensembles: { baseline: rows, paired: [PAIRED] } }));
		// Newest first; the off-rule one says how it departs.
		expect(r.uncertainty.ledger.map((e) => e.id)).toEqual(['e2', 'e1', 'e3', 'e0']);
		expect(r.uncertainty.ledger.find((e) => e.id === 'e3')!.departsFromDeclared).toEqual([{ label: 'Lowest skill kept', a: '0.3', b: '0.1' }]);
		expect(r.uncertainty.ledger.filter((e) => e.cited).map((e) => e.id)).toEqual(['e1']);
		// Control: without e1, the next one on the rule is cited, never the off-rule one.
		expect(citedEnsemble([later, offRule, started], RULE)?.id).toBe('e2');
		expect(citedEnsemble([offRule, started], RULE)).toBeNull();
	});

	it('without a declared rule: nothing is cited, no change carries a band, and the report can’t be issued', () => {
		const i = input();
		const r = evidenceReport(input({ baseline: { ...i.baseline, inputs: { ...i.baseline.inputs, settings: { ...i.baseline.inputs.settings, evidenceUncertaintyRule: null } } } }));
		expect(r.uncertainty.cited).toBeNull();
		expect(r.rows.find((x) => x.id === 'ewrDays')!.change!.bandNote).toBe(NO_BAND.notDeclared);
		expect(r.flags.map((f) => f.id)).toContain('noRule');
		expect(r.issuable).toBe(false);
		expect(r.refused).toBe(false);
	});

	it('without a paired band: the change is the run’s own difference, labelled "no band"', () => {
		const r = evidenceReport(input({ ensembles: { baseline: [ens({})], paired: [] } }));
		const days = r.rows.find((x) => x.id === 'ewrDays')!;
		expect(days.change!.band).toBeNull();
		expect(days.change!.bandNote).toBe(NO_BAND.noPaired);
		expect(days.change!.run).toBe(appOut.summary.catchment.ewrDaysNotMet - baseOut.summary.catchment.ewrDaysNotMet);
		expect(r.checks.find((c) => c.id === 'pairedBand')!.passed).toBe(false);
		expect(r.byMonth).toBeNull();
	});
});

describe('absence is printed, never omitted (rule 3, G6, G16)', () => {
	it('a project with no Reserve rule table keeps the Reserve row as "Not assessed", and flags it', () => {
		const b0 = baseInput({ reserve: false });
		const r = evidenceReport(input({ baseline: stored('base', b0, runModel(b0)), ensembles: { baseline: [], paired: [] } }));
		const reserve = r.rows.find((x) => x.id === 'reserve')!;
		expect(reserve.notAssessed).toMatch(/^Not assessed: no EWR site has a Reserve rule table/);
		expect(r.flags.map((f) => f.id)).toContain('noReserve');
		expect(r.river).toEqual([]);
	});

	it('an EWR set to 0 is a red flag', () => {
		const i = input();
		const settings = { ...i.baseline.inputs.settings, ewrPragmaticM3PerDay: new Array(12).fill(0) as never };
		const r = evidenceReport(input({ baseline: { ...i.baseline, inputs: { ...i.baseline.inputs, settings } } }));
		expect(r.flags.find((f) => f.id === 'ewrZero')?.level).toBe('red');
		// Control: the good input has no such flag.
		expect(evidenceReport(i).flags.map((f) => f.id)).not.toContain('ewrZero');
	});

	it('orders the flags red, then caution, then counts', () => {
		const order = { red: 0, caution: 1, count: 2 };
		const levels = evidenceReport(input()).flags.map((f) => order[f.level]);
		expect([...levels].sort((x, y) => x - y)).toEqual(levels);
	});
});

describe('the Reserve site strip: the REC (ER9) and months below the table (G16)', () => {
	const withTable = (i: EvidenceInput, over: Record<string, unknown>): EvidenceInput => {
		const settings = { ...i.baseline.inputs.settings, ewrRules: [{ ...reserveTable(), ...over }] as never };
		return { ...i, baseline: { ...i.baseline, inputs: { ...i.baseline.inputs, settings } } };
	};
	const recQuestion = (r: ReturnType<typeof evidenceReport>) => r.questions.filter((q) => q.includes('(REC)'));

	it('prints the REC from the baseline’s rule table, and asks for it only when absent', () => {
		const r = evidenceReport(withTable(input(), { category: 'B/C' }));
		expect(r.river[0]!.category).toBe('B/C');
		expect(recQuestion(r)).toEqual([]);
		// Control: no REC on the table is "not given", and the assessor's question names the site.
		const none = evidenceReport(input());
		expect(none.river[0]!.category).toBeNull();
		expect(recQuestion(none)).toEqual([expect.stringMatching(/^The recommended ecological category \(REC\) is not given at Gauge: /)]);
	});

	it('matches the outlet’s table whether it names no site or the outflow node', () => {
		expect(evidenceReport(withTable(input(), { siteNodeId: 'G', category: 'C' })).river[0]!.category).toBe('C');
		// A table at another site is not the outlet's, and a malformed REC is not printed.
		expect(evidenceReport(withTable(input(), { siteNodeId: 'F1', category: 'C' })).river[0]!.category).toBeNull();
		expect(evidenceReport(withTable(input(), { category: 'Z' })).river[0]!.category).toBeNull();
	});

	it('does not change a result: the rest of the report is the same with or without a REC', () => {
		const strip = (r: ReturnType<typeof evidenceReport>) => ({ ...r, river: r.river.map((x) => ({ ...x, category: null })), questions: [], identity: null, verification: null, appendix: null });
		expect(canonicalJson(strip(evidenceReport(withTable(input(), { category: 'A' }))))).toBe(canonicalJson(strip(evidenceReport(withTable(input(), {})))));
	});

	/** The input with the first `n` baseline months (and `m` application months) drier than the table's driest point. */
	const drier = (n: number, m: number | null = null): EvidenceInput => {
		const i = input();
		const mark = (run: EvidenceRunInput, k: number): EvidenceRunInput => {
			const summary = structuredClone(run.summary);
			summary.ewrAssurance![0]!.months.forEach((x, j) => (x.beyond = j < k ? 'drier' : x.beyond === 'drier' ? null : x.beyond));
			return { ...run, summary };
		};
		return { ...i, baseline: mark(i.baseline, n), application: { ...i.application!, ...mark(i.application!, m ?? n) } };
	};

	it('counts the months below the table per site, and flags them as a caution with their effect', () => {
		const r = evidenceReport(drier(3));
		const s = r.river[0]!;
		expect([s.belowTableA, s.belowTableB]).toEqual([3, 3]);
		const f = r.flags.find((x) => x.id === 'belowTable-outlet')!;
		expect(f.level).toBe('caution');
		expect(s.belowTableExpectedPct).toBe(1);
		expect(f.text).toBe(
			`At Gauge the natural flow is drier than the rule table’s driest point in 3 of ${s.monthsA} months: the requirement there is scaled with the flow, a rule pending the hydrologist. With the percentile from the run, about 1 % of months fall there by construction.`
		);
		expect(f.effect).toMatch(/^The requirement shrinks with the flow in those months, below the table’s driest requirement/);
	});

	it('names both runs’ counts when they differ', () => {
		const r = evidenceReport(drier(2, 5));
		expect([r.river[0]!.belowTableA, r.river[0]!.belowTableB]).toEqual([2, 5]);
		expect(r.flags.find((x) => x.id === 'belowTable-outlet')!.text).toMatch(/in 2 of \d+ months in the baseline and 5 in the application:/);
	});

	it('has no such flag when no month is below the table (control)', () => {
		const r = evidenceReport(drier(0));
		expect([r.river[0]!.belowTableA, r.river[0]!.belowTableB]).toEqual([0, 0]);
		expect(r.flags.map((x) => x.id)).not.toContain('belowTable-outlet');
	});
});

describe('baseline evidence (the nominated run alone)', () => {
	const r = evidenceReport(input({ application: null, changes: [] }));

	it('has the river, credibility and appendices without change columns', () => {
		expect(r.mode).toBe('baseline');
		expect(ids(r)).toEqual(['reserve', 'ewrDays', 'shortfall', 'noFlowDays', 'outflowMar', 'registeredUse']);
		for (const row of r.rows) {
			expect(row.application).toBeNull();
			expect(row.change).toBeNull();
		}
		expect(r.checks.map((c) => c.id)).toEqual(['nominated', 'notLegacy', 'notForecast', 'declaredRule', 'citedEnsemble', 'coverage']);
		expect(r.applicantStatement).toBeNull();
		expect(r.users.every((u) => u.suppliedB === null)).toBe(true);
	});
});

describe('errata', () => {
	it('lists the errata of either run’s engine, once each', () => {
		const i = input();
		const r = evidenceReport(input({ baseline: { ...i.baseline, engineVersion: '0.16.0' }, application: { ...i.application!, engineVersion: '0.17.0' } }));
		const ids16 = r.verification.errata.map((e) => e.id);
		expect(ids16).toContain('ER-3');
		expect(new Set(ids16).size).toBe(ids16.length);
		// The fixture's runs are engine 1.30.0: inside ER-10 (engine-audit.md V1, 1.34.0) and ER-11 (N6, 0.16.0 until
		// 1.36.0), and no other run erratum.
		expect(evidenceReport(i).verification.errata.filter((e) => e.keyedOn === 'run').map((e) => e.id)).toEqual(['ER-10', 'ER-11']);
		// Runs by the current engine carry none.
		const now = evidenceReport(input({ baseline: { ...i.baseline, engineVersion: ENGINE_VERSION }, application: { ...i.application!, engineVersion: ENGINE_VERSION } }));
		expect(now.verification.errata.filter((e) => e.keyedOn === 'run')).toEqual([]);
	});
});

describe('§ 5 registered water use (WP-3.10)', () => {
	/** What the backend hands the report: compareAllocations over a run's own series, allocations and tolerance. */
	const comparisonOf = (inp: ModelInput, out: ModelOutput, allocations: AllocationEntry[], tolerance = 0.1) => {
		const get = (id: string, key: string) => out.series.find((s) => s.nodeId === id && s.key === key)?.values ?? null;
		return compareAllocations({
			startDate: START,
			tolerance,
			allocations,
			nodes: inp.model.nodes
				.filter((n) => n.kind === 'farm' || n.kind === 'user')
				.map((n) => ({ nodeId: n.id, name: n.name, kind: n.kind as 'farm' | 'user', supplied: get(n.id, 'supplied')!, groundwater: get(n.id, 'groundwater_used'), riverAbstraction: get(n.id, 'river_abstraction') }))
		});
	};
	const meanUse = (out: ModelOutput, id: string) => {
		const c = comparisonOf(base, out, [{ id: 'probe', nodeId: id, waterSource: 'surface', volumeM3PerYear: 1 }]);
		return c.nodes.find((n) => n.nodeId === id)!.surface.meanModelledM3PerYear!;
	};
	// The baseline's farms have no dam and take nothing; the application's dam on Farm two (the applicant's) supplies it.
	// Farm one is registered for a volume it never uses; Farm two for half what the application takes.
	const allocations: AllocationEntry[] = [
		{ id: 'a1', nodeId: 'F1', waterSource: 'surface', volumeM3PerYear: 100_000 },
		{ id: 'a2', nodeId: 'F2', waterSource: 'surface', volumeM3PerYear: meanUse(appOut, 'F2') / 2 }
	];
	const withAllocations = (list = allocations, over: { a?: Partial<EvidenceRunInput>; b?: Partial<EvidenceRunInput> } = {}) => {
		const i = input();
		return input({
			baseline: { ...i.baseline, allocations: comparisonOf(base, baseOut, list), ...over.a },
			application: { ...i.application!, allocations: comparisonOf(app, appOut, list), ...over.b }
		});
	};
	const r = evidenceReport(withAllocations());

	it('without registered volumes: § 5 and its page-1 row say "Not assessed", and an assessor’s question names it', () => {
		const none = evidenceReport(input());
		expect(none.allocations.notAssessed).toBe(ALLOCATIONS_NOT_ASSESSED.none);
		expect(none.allocations.units).toEqual([]);
		const row = none.rows.find((x) => x.id === 'registeredUse')!;
		expect(row.notAssessed).toBe(ALLOCATIONS_NOT_ASSESSED.none);
		expect(row.baseline).toBeNull();
		expect(none.questions.some((q) => q.startsWith('Registered vs modelled use: Not assessed'))).toBe(true);
		expect(none.flags.map((f) => f.id)).not.toContain('allocationsOver');
		// Positive control: with volumes the section is assessed.
		expect(r.allocations.notAssessed).toBeNull();
	});

	it('lists each unit with a volume, per water year, with the numbers compareAllocations gives the Allocations tab (G14)', () => {
		expect(r.allocations.units.map((u) => [u.name, u.own, u.onlyIn])).toEqual([
			['Farm one', false, null],
			['Farm two', true, null]
		]);
		const cb = comparisonOf(app, appOut, allocations);
		const ca = comparisonOf(base, baseOut, allocations);
		for (const u of r.allocations.units) {
			expect(u.sources.map((s) => s.waterSource)).toEqual(['surface']);
			const s = u.sources[0]!;
			const ya = ca.nodes.find((n) => n.nodeId === u.nodeId)!.surface.years;
			const yb = cb.nodes.find((n) => n.nodeId === u.nodeId)!.surface.years;
			expect(s.years.map((y) => y.waterYear)).toEqual(ya.map((y) => y.waterYear));
			expect(s.years.map((y) => [y.registeredA, y.modelledA, y.statusA])).toEqual(ya.map((y) => [y.registeredM3, y.modelledM3, y.status]));
			expect(s.years.map((y) => [y.registeredB, y.modelledB, y.statusB])).toEqual(yb.map((y) => [y.registeredM3, y.modelledM3, y.status]));
			for (const c of [s.countsA!, s.countsB!]) expect(c.over + c.within + c.under + c.noVolume).toBe(c.wholeYears);
			expect(s.countsA!.wholeYears).toBe(5);
		}
		expect(meanUse(appOut, 'F2')).toBeGreaterThan(0);
		// Farm one takes nothing: below its volume every year. Farm two: below it in the baseline, above it in the application.
		const [f1, f2] = r.allocations.units.map((u) => u.sources[0]!);
		expect([f1!.countsA!.under, f1!.countsB!.under]).toEqual([5, 5]);
		expect([f2!.countsA!.under, f2!.countsA!.over, f2!.countsB!.over]).toEqual([5, 0, 5]);
		expect(r.allocations.toleranceA).toBe(0.1);
		expect(r.allocations.notMatchedA).toBe(0);
	});

	it('the page-1 row sums the unit-years above the volume, both runs, with no band', () => {
		const row = r.rows.find((x) => x.id === 'registeredUse')!;
		const sum = (k: 'countsA' | 'countsB') => r.allocations.units.reduce((t, u) => t + u.sources.reduce((v, s) => v + (s[k]?.over ?? 0), 0), 0);
		expect(row.notAssessed).toBeNull();
		expect(row.baseline).toBe(sum('countsA'));
		expect(row.application).toBe(sum('countsB'));
		expect(row.change).toEqual({ run: sum('countsB') - sum('countsA'), band: null, bandNote: NO_BAND.notCarried, worse: null });
		expect(row.basis).toMatch(/more than ±10 % above its registered volume/);
		expect(row.note).toMatch(/allocation mode: not recorded/);
	});

	it('flags the application’s use above a registered volume, naming the unit, never a holder; none when every year is within', () => {
		const flag = r.flags.find((f) => f.id === 'allocationsOver')!;
		expect(flag.level).toBe('caution');
		expect(flag.text).toBe(
			'The application’s modelled use is more than ±10 % above the registered volume: Farm two (the applicant’s), surface water, 5 of 5 whole water years (baseline 0 of 5) (§ 5).'
		);
		// Control: volumes far above any use raise no flag.
		const roomy = allocations.map((x) => ({ ...x, volumeM3PerYear: x.volumeM3PerYear * 1000 }));
		expect(evidenceReport(withAllocations(roomy)).flags.map((f) => f.id)).not.toContain('allocationsOver');
	});

	it('reads the allocation mode each run ran with from its summary', () => {
		const withMode = (inp: ModelInput): ModelInput => ({ ...inp, settings: { ...inp.settings, allocationMode: 'none' }, model: { ...inp.model, allocations } });
		const outA = runModel(withMode(base));
		const outB = runModel(withMode(app));
		const got = evidenceReport(withAllocations(allocations, { a: { summary: outA.summary }, b: { summary: outB.summary } }));
		expect([got.allocations.modeA, got.allocations.modeB]).toEqual(['none', 'none']);
		expect(got.rows.find((x) => x.id === 'registeredUse')!.note).toMatch(/allocation mode: Compare only/);
	});

	it('cites a capped run’s cap on each unit and source: the years it used its volume up and the days the limit held use back (evidence-6)', () => {
		const withCap = (inp: ModelInput): ModelInput => ({ ...inp, settings: { ...inp.settings, allocationMode: 'cap' }, model: { ...inp.model, allocations } });
		const outB = runModel(withCap(app));
		// The baseline compares only; the application caps Farm two at half its use.
		const got = evidenceReport(withAllocations(allocations, { b: { summary: outB.summary } }));
		const f2 = got.allocations.units.find((u) => u.nodeId === 'F2')!.sources[0]!;
		const want = outB.summary.allocations!.nodes.find((n) => n.nodeId === 'F2')!.sources[0]!;
		expect(f2.capA).toBeNull();
		expect(f2.capB).toEqual({ capReached: want.capReached, limitBound: want.limitBound });
		// Positive control: the cap bound, on volume only (the licence states no conditions).
		expect(f2.capB!.capReached.length).toBeGreaterThan(0);
		expect(f2.capB!.limitBound!.reduce((t, y) => t + y.volumeDays, 0)).toBeGreaterThan(0);
		expect(f2.capB!.limitBound!.every((y) => y.rateDays === 0 && y.monthsDays === 0)).toBe(true);
		// A run before engine 1.40.0: the years, no day counts.
		const old = structuredClone(outB.summary);
		for (const n of old.allocations!.nodes) for (const x of n.sources) delete x.limitBound;
		const older = evidenceReport(withAllocations(allocations, { b: { summary: old } }));
		expect(older.allocations.units.find((u) => u.nodeId === 'F2')!.sources[0]!.capB).toEqual({ capReached: want.capReached, limitBound: null });
		// Not a cap run: nothing cited.
		expect(r.allocations.units.every((u) => u.sources.every((x) => x.capA === null && x.capB === null))).toBe(true);
		expect(got.version).toBe('evidence-6');
	});

	it('keeps a unit only one run has, marked; registered volumes on no unit are "Not assessed"', () => {
		const i = withAllocations();
		const cb = i.application!.allocations!;
		const onlyBase = evidenceReport({ ...i, application: { ...i.application!, allocations: { ...cb, nodes: cb.nodes.filter((n) => n.nodeId !== 'F1') } } });
		const f1 = onlyBase.allocations.units.find((u) => u.nodeId === 'F1')!;
		expect(f1.onlyIn).toBe('baseline');
		expect(f1.sources[0]!.countsB).toBeNull();
		expect(f1.sources[0]!.years.every((y) => y.modelledB === null && y.modelledA !== null)).toBe(true);
		// Control: in both runs, it isn't marked.
		expect(r.allocations.units.find((u) => u.nodeId === 'F1')!.onlyIn).toBeNull();

		const loose = evidenceReport(withAllocations([{ id: 'a9', nodeId: null, waterSource: 'surface', volumeM3PerYear: 1e5 }]));
		expect(loose.allocations.notAssessed).toBe(ALLOCATIONS_NOT_ASSESSED.notMatched(1));
		expect(loose.allocations.notMatchedA).toBe(1);
		expect(loose.rows.find((x) => x.id === 'registeredUse')!.notAssessed).toBe(ALLOCATIONS_NOT_ASSESSED.notMatched(1));
	});

	it('baseline evidence: one run’s counts, and the flag names the baseline', () => {
		const i = withAllocations();
		const b = evidenceReport({ ...i, application: null, changes: [] });
		expect(b.allocations.units.every((u) => u.sources.every((s) => s.countsB === null && s.years.every((y) => y.statusB === null)))).toBe(true);
		expect(b.allocations.modeB).toBeNull();
		expect(b.rows.at(-1)!.id).toBe('registeredUse');
		expect(b.rows.at(-1)!.application).toBeNull();
		// The baseline never takes more than a volume: no flag. Control: the application's run read as a baseline flags as the baseline.
		expect(b.flags.map((f) => f.id)).not.toContain('allocationsOver');
		const appAsBase = evidenceReport({ ...i, baseline: { ...i.application!, id: 'base' }, application: null, changes: [] });
		expect(appAsBase.flags.find((f) => f.id === 'allocationsOver')!.text).toMatch(/^The baseline’s modelled use is more than ±10 % above the registered volume: Farm two, surface water, 5 of 5/);
	});

	it('names both bands when the runs used different ones', () => {
		const i = withAllocations();
		const got = evidenceReport({ ...i, application: { ...i.application!, allocations: comparisonOf(app, appOut, allocations, 0.15) } });
		expect([got.allocations.toleranceA, got.allocations.toleranceB]).toEqual([0.1, 0.15]);
		expect(got.rows.find((x) => x.id === 'registeredUse')!.basis).toMatch(/more than ±10 % \(baseline\), ±15 % \(application\) above/);
		expect(got.flags.find((f) => f.id === 'allocationsOver')!.text).toMatch(/^The application’s modelled use is more than ±15 % \(the application’s band; the baseline’s is ±10 %\) above/);
		// Control: one band, said once.
		expect(r.rows.find((x) => x.id === 'registeredUse')!.basis).toMatch(/more than ±10 % above/);
	});

	it('marks a part year per run when the runs differ in length, and counts it only where it is whole', () => {
		const i = withAllocations();
		const short = comparisonOf(app, { ...appOut, series: appOut.series.map((x) => ({ ...x, values: x.values.slice(0, 1600) })) }, allocations);
		const got = evidenceReport({ ...i, application: { ...i.application!, allocations: short } });
		const last = got.allocations.units[1]!.sources[0]!.years.at(-1)!;
		expect([last.partialA, last.partialB]).toEqual([false, true]);
		const s = got.allocations.units[1]!.sources[0]!;
		expect([s.countsA!.wholeYears, s.countsB!.wholeYears]).toEqual([5, 4]);
		// Control: the full-length runs have it whole in both.
		const full = r.allocations.units[1]!.sources[0]!.years.at(-1)!;
		expect([full.partialA, full.partialB]).toEqual([false, false]);
	});

	it('is deterministic, and a changed volume changes the document', () => {
		expect(canonicalJson(evidenceReport(withAllocations()))).toBe(canonicalJson(r));
		const other = allocations.map((x, k) => (k === 1 ? { ...x, volumeM3PerYear: x.volumeM3PerYear * 3 } : x));
		expect(canonicalJson(evidenceReport(withAllocations(other)))).not.toBe(canonicalJson(r));
	});
});

describe('the evidence measures (engine 1.33.0): no-flow days, EWR below the works, supply bands, served while failing, banded FDC', () => {
	const r = evidenceReport(input());
	const p = r.uncertainty.paired!;

	it('prints no-flow days at the outlet, both runs, with the paired band and "worse in"', () => {
		const row = r.rows.find((x) => x.id === 'noFlowDays')!;
		const q = (out: ModelOutput) => out.series.find((x) => x.key === 'simulated_outflow')!.values.filter((v) => v < 86.4).length;
		expect(row.basis).toBe(BASIS_NO_FLOW);
		expect([row.baseline, row.application]).toEqual([q(baseOut), q(appOut)]);
		expect(row.change!.run).toBe(q(appOut) - q(baseOut));
		expect(row.change!.band).toEqual(p.noFlowDays);
		expect(row.change!.worse).toEqual({ k: Math.round(p.noFlowDaysWorse! * p.members), n: p.members });
		expect(row.note).toMatch(/^Longest spell \d+ days? → \d+$/);
	});

	it('bands supply on real numbers (positive control): each unit’s share and the applicant’s group, member by member', () => {
		// Farm two doubles its maize in the application, so its supply moves in every pair.
		const kept = ensemble.members.filter((m) => m.accepted);
		const frac = (x: MemberMetrics, id: string) => (x.unitDemandM3Day![id]! > 0 ? x.unitSuppliedM3Day![id]! / x.unitDemandM3Day![id]! : 1);
		const diffs = pairedRun.members.map((q, i) => frac(q.metrics, 'F2') - frac(kept[i]!.metrics!, 'F2'));
		expect(diffs.some((d) => d !== 0)).toBe(true);
		const f2 = p.supply!.find((x) => x.nodeId === 'F2')!;
		expect(f2.band).toEqual(bandOf(diffs));
		expect(f2.worse).toBe(diffs.filter((d) => d < 0).length / diffs.length);
		// The group is F2 alone here: the same band.
		expect(p.ownSupply!.band).toEqual(f2.band);
		expect(p.ownSupply!.band.n).toBe(pairedRun.members.length);
	});

	it('says why the applicant’s supply has no band when all its units are new', () => {
		const i = input();
		const got = evidenceReport(input({ application: { ...i.application!, scenario: { ...i.application!.scenario, ownedNodeIds: ['NEW'] } } }));
		expect(got.rows.find((x) => x.id === 'applicantSupply')!.notAssessed).not.toBeNull();
		const onlyNew = { ...i.application!.summary, farms: [...i.application!.summary.farms, { ...i.application!.summary.farms[1]!, nodeId: 'NEW', name: 'New farm' }] };
		const got2 = evidenceReport(input({ application: { ...i.application!, summary: onlyNew, scenario: { ...i.application!.scenario, ownedNodeIds: ['NEW'] } } }));
		expect(got2.rows.find((x) => x.id === 'applicantSupply')!.change).toMatchObject({ band: null, bandNote: NO_BAND.noOwnInBaseline });
	});

	it('bands each other user’s supply and § 4’s change column with the paired band on its share supplied (ER4)', () => {
		const f1 = r.users.find((u) => u.nodeId === 'F1')!;
		const band = p.supply!.find((x) => x.nodeId === 'F1')!;
		expect(f1.change!.run).toBeCloseTo((f1.suppliedB! - f1.suppliedA!) * 100, 12);
		expect(f1.change!.band!.p50).toBeCloseTo(band.band.p50! * 100, 9);
		expect(f1.change!.worse).toEqual(band.worse === null ? null : { k: Math.round(band.worse * p.members), n: p.members });
		for (const row of r.rows.filter((x) => x.id === 'userSupply' && x.subject)) expect(row.change!.bandNote).toBeNull();
		// Baseline evidence has no change column.
		expect(evidenceReport(input({ application: null, changes: [] })).users.every((u) => u.change === null)).toBe(true);
	});

	it('says "Not assessed" with a question when no EWR site lies between the works and the outlet', () => {
		const rows = r.rows.filter((x) => x.id === 'ewrBelowWorks');
		expect(rows).toHaveLength(1);
		expect(rows[0]!).toMatchObject({ subject: 'below Farm two', notAssessed: NOT_ASSESSED_NO_SITE_BELOW, baseline: null, change: null });
		expect(r.questions).toContain(`Days below the EWR, first site below the works at below Farm two: ${NOT_ASSESSED_NO_SITE_BELOW}`);
	});

	it('reports the first EWR site below the works: its days below the EWR, both runs, and the Reserve when it has a table', () => {
		const b1 = baseInput({ midGauge: true });
		const a1 = applicationInput(b1);
		const o1 = runModel(b1);
		const o2 = runModel(a1);
		const i = input();
		const got = evidenceReport(
			input({ baseline: stored('base', b1, o1), application: { ...stored('app', a1, o2), scenario: i.application!.scenario }, ensembles: { baseline: [], paired: [] } })
		);
		const rows = got.rows.filter((x) => x.id === 'ewrBelowWorks');
		const site = (o: ModelOutput) => o.summary.servedWhileEwrFails!.find((x) => x.nodeId === 'S')!.daysNotMet;
		expect(rows).toHaveLength(1);
		expect(rows[0]!).toMatchObject({ subject: 'Weir, below Farm two', notAssessed: null, baseline: site(o1), application: site(o2) });
		expect(rows[0]!.change).toMatchObject({ run: site(o2) - site(o1), band: null });
		expect(rows[0]!.note).toBe('No Reserve rule table at this site: the Reserve itself is not assessed here');
		// A baseline-assumption op is not the applicant's works: no row. Control: the proposal above has one.
		const asBaseline = evidenceReport(input({ application: { ...i.application!, scenario: { ...i.application!.scenario, classified: ['baseline', 'baseline'] } } }));
		expect(asBaseline.rows.filter((x) => x.id === 'ewrBelowWorks')).toEqual([]);
	});

	it('finds the works of each op and the first site below them', () => {
		const model = {
			transfers: [{ id: 't', fromNodeId: 'F1', toNodeId: 'F2' }],
			nodes: [
				{ id: 'G', kind: 'gauge' },
				{ id: 'F1', kind: 'farm' },
				{ id: 'F2', kind: 'farm' },
				{ id: 'U', kind: 'user' }
			]
		} as never;
		const ops = [
			{ op: 'node.set', nodeId: 'F2', field: 'damCapacityM3', value: 1 },
			{ op: 'node.set', nodeId: 'F2', field: 'name', value: 'x' },
			{ op: 'node.set', nodeId: 'G', field: 'ewrSite', value: false },
			{ op: 'transfer.set', transferId: 't', field: 'maxRateM3s', value: 1 },
			{ op: 'demand.scale', factor: 1.2, nodeIds: ['F1'] },
			{ op: 'demand.scale', factor: 1.5 },
			{ op: 'demand.scale', factor: 1.5, category: 'user' },
			{ op: 'demand.scale', factor: 0.8, nodeIds: ['F1'] },
			{ op: 'settings.set', path: 'ewrPragmaticM3PerDay', value: [] }
		] as unknown as ScenarioOp[];
		// Demand raised without names is every node of its category; a gauge's field and lowered demand are no works.
		expect(ops.map((o) => worksNodeIds(o, model))).toEqual([['F2'], [], [], ['F1'], ['F1'], ['F1', 'F2'], ['U'], [], []]);
		const nodes = [
			{ id: 'O', kind: 'gauge', downstreamNodeId: null },
			{ id: 'M', kind: 'gauge', downstreamNodeId: 'O', ewrSite: false },
			{ id: 'S', kind: 'gauge', downstreamNodeId: 'M' },
			{ id: 'F', kind: 'farm', downstreamNodeId: 'S' },
			{ id: 'L', kind: 'farm', downstreamNodeId: 'M' }
		] as never;
		expect(firstSiteBelow(nodes, 'F')).toBe('S');
		// A gauge that only measures isn't a site, and the outlet isn't "between".
		expect(firstSiteBelow(nodes, 'L')).toBeNull();
	});

	it('lists per EWR site the users served in full while it failed, and flags them as a count', () => {
		const sv = r.servedWhileFailing;
		expect(sv.notAssessed).toBeNull();
		expect(sv.sites.map((x) => x.key)).toEqual(['outlet']);
		const outlet = sv.sites[0]!;
		const want = (o: ModelOutput) => Object.fromEntries(o.summary.servedWhileEwrFails![0]!.units.map((u) => [u.nodeId, u.days]));
		for (const u of outlet.units) expect([u.daysA, u.daysB]).toEqual([want(baseOut)[u.nodeId] ?? null, want(appOut)[u.nodeId] ?? null]);
		expect(outlet.daysNotMetA).toBe(baseOut.summary.catchment.ewrDaysNotMet);
		const any = outlet.units.some((u) => (u.daysB ?? 0) > 0);
		expect(r.flags.some((f) => f.id === 'servedWhileFailing')).toBe(any);
		// Positive control: a unit served in full on failing days is flagged, named with its days.
		const i = input();
		const summary = { ...appOut.summary, servedWhileEwrFails: [{ ...appOut.summary.servedWhileEwrFails![0]!, units: [{ nodeId: 'F1', name: 'Farm one', kind: 'farm' as const, days: 12 }] }] };
		const flagged = evidenceReport(input({ application: { ...i.application!, summary } }));
		expect(flagged.flags.find((f) => f.id === 'servedWhileFailing')).toMatchObject({ level: 'count' });
		expect(flagged.flags.find((f) => f.id === 'servedWhileFailing')!.text).toMatch(/^1 unit got its whole demand on days an EWR site below it was not met in the application: Farm one 12 days at the outlet \(baseline \d+\) \(§ 4\)\.$/);
	});

	it('bands the FDC check per month and table point: the baseline’s (R1) and the application’s own curve (R2)', () => {
		const site = r.river[0]!;
		const b = r.uncertainty.baseline!.bands.reserveFdc!.find((x) => x.key === 'outlet')!;
		expect(site.fdcBandNote).toBeNull();
		expect(site.fdcBands!.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(site.fdcBands![0]!.a.length).toBe(baseOut.summary.ewrAssurance![0]!.points.length);
		expect(site.fdcBands![0]!.a[0]).toEqual(b.months[0]![0]);
		expect(site.fdcBands![0]!.b![0]).toEqual(p.reserveFdc![0]!.months[0]![0]);
		// The run's own curve sits inside the baseline's band at most points (member 0 is kept).
		if (r.uncertainty.baseline!.referenceAccepted) {
			const run = baseOut.summary.ewrAssurance![0]!.byMonth[0]!.fdc[0]!.impacted!;
			expect(site.fdcBands![0]!.a[0]!.min!).toBeLessThanOrEqual(run + 1e-9);
			expect(site.fdcBands![0]!.a[0]!.max!).toBeGreaterThanOrEqual(run - 1e-9);
		}
	});

	it('an ensemble stored before engine 1.33.0: every new measure says "no band" with the reason, never a zero', () => {
		const strip = (m: MemberMetrics): MemberMetrics => {
			const { noFlowDays: _a, ewrSiteDaysNotMet: _b, unitDemandM3Day: _c, unitSuppliedM3Day: _d, reserveFdc: _e, ...old } = m;
			return old;
		};
		const { units: _u, ewrSites: _w, ...oldHeader } = ensemble.header;
		const oldMembers = ensemble.members.map((m) => (m.metrics ? { ...m, metrics: strip(m.metrics) } : m)) as MemberResult[];
		const oldEnsemble = { ...ensemble, header: oldHeader as EnsembleHeader, members: oldMembers };
		const { noFlowDays: _n, ewrSites: _s, supply: _p, reserveFdc: _f, ...oldBands } = summariseEnsemble(oldEnsemble).bands;
		// The baseline's summary as stored then; the paired one recomputed by the backend from its members (a paired run on today's engine).
		const got = evidenceReport(
			input({
				ensembles: {
					baseline: [ens({ summary: { ...summariseEnsemble(oldEnsemble), bands: oldBands } })],
					paired: [{ ...PAIRED, paired: summarisePaired(oldEnsemble, pairedRun, { own: ['F2'] }) }]
				}
			})
		);
		const note = NO_BAND.olderEnsemble(ENSEMBLE_MEASURES_SINCE);
		for (const id of ['noFlowDays', 'applicantSupply'] as const) expect(got.rows.find((x) => x.id === id)!.change, id).toMatchObject({ band: null, bandNote: note, worse: null });
		expect(got.users.find((u) => u.nodeId === 'F1')!.change).toMatchObject({ band: null, bandNote: note });
		expect(got.river[0]!).toMatchObject({ fdcBands: null, fdcBandNote: note });
		// The measures the old ensemble has keep their bands.
		expect(got.rows.find((x) => x.id === 'ewrDays')!.change!.band).not.toBeNull();
	});

	it('runs made before engine 1.33.0: the no-flow row and § 4’s table say "Not assessed" and why', () => {
		const old = (o: ModelOutput) => {
			const { noFlow: _n, ...catchment } = o.summary.catchment;
			const { servedWhileEwrFails: _s, ...rest } = o.summary;
			return { ...rest, catchment };
		};
		const i = input();
		const got = evidenceReport(input({ baseline: { ...i.baseline, summary: old(baseOut) }, application: { ...i.application!, summary: old(appOut) } }));
		expect(got.rows.find((x) => x.id === 'noFlowDays')!.notAssessed).toBe(`Not assessed: the baseline was made before engine ${ENSEMBLE_MEASURES_SINCE}, which added this measure; run the model again.`);
		expect(got.servedWhileFailing).toEqual({ notAssessed: `Not assessed: the baseline was made before engine ${ENSEMBLE_MEASURES_SINCE}, which added this measure; run the model again.`, sites: [] });
		expect(got.flags.map((f) => f.id)).not.toContain('servedWhileFailing');
	});
});

describe('§ 1 the driest month’s FDC beside the largest-change month (evidence-3)', () => {
	const r = evidenceReport(input());
	const month = (m: number, natural: number) => ({ month: m, natural }) as never;
	const byMonth = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => ({ month: m }) as never);

	it('is the calendar month with the lowest mean natural flow over its complete months', () => {
		// August's mean is 1.5, September's 2: August, though September has the single lowest month.
		const months = [month(8, 1), month(8, 2), month(9, 0.5), month(9, 3.5), month(1, 9)];
		expect(driestMonth({ months, byMonth })).toBe(8);
	});

	it('breaks a tie by water-year order (October first), and is null without a complete month', () => {
		expect(driestMonth({ months: [month(3, 1), month(11, 1)], byMonth })).toBe(11);
		expect(driestMonth({ months: [], byMonth })).toBeNull();
	});

	it('reads the baseline’s natural flow at each site, whatever the application did', () => {
		const site = baseOut.summary.ewrAssurance![0]!;
		const means = new Map<number, number[]>();
		for (const m of site.months) means.set(m.month, [...(means.get(m.month) ?? []), m.natural]);
		const lowest = [...means].map(([m, v]) => ({ m, mean: v.reduce((a, x) => a + x, 0) / v.length })).sort((x, y) => x.mean - y.mean)[0]!.m;
		expect(r.river[0]!.fdcDriestMonth).toBe(lowest);
		// The application can't move it: baseline evidence gives the same month.
		expect(evidenceReport(input({ application: null, changes: [] })).river[0]!.fdcDriestMonth).toBe(lowest);
	});
});

describe('§ 4 other applications on the baseline, summed (evidence-3)', () => {
	/** A second application: Farm one builds a dam, run on the same baseline. */
	const otherInput: ModelInput = {
		...base,
		model: { ...base.model, nodes: base.model.nodes.map((n) => (n.id === 'F1' ? { ...n, pctRunoffToDam: 1, pctUpstreamToDam: 0, damCapacityM3: 8e5, damAreaFullM2: 2e5 } : n)) }
	};
	const otherOut = runModel(otherInput);
	const outletOf = (o: ModelOutput) => o.summary.ewrAssurance!.find((s) => s.isOutlet)!.overall;
	const other = (over: Partial<EvidenceOtherApplicationInput> = {}): EvidenceOtherApplicationInput => ({
		scenarioId: 'scn-2',
		scenarioName: 'Farm one dam',
		status: 'submitted',
		outcome: null,
		runId: 'run-2',
		runCreatedAt: '2026-09-04T00:00:00.000Z',
		engineVersion: '1.30.0',
		runoffModel: 'gr4j',
		startDate: START,
		endDate: baseOut.summary.curtailment!.reportEnd,
		ewrDaysNotMet: otherOut.summary.catchment.ewrDaysNotMet,
		reserveOutlet: outletOf(otherOut),
		...over
	});
	const days = (o: ModelOutput) => o.summary.catchment.ewrDaysNotMet;

	it('lists each other application’s own change against the baseline, and sums them (not a combined run)', () => {
		const second = other({ scenarioId: 'scn-3', scenarioName: 'Approved weir', status: 'decided', outcome: 'approved', runId: 'run-3', runCreatedAt: '2026-09-05T00:00:00.000Z' });
		const r = evidenceReport(input({ otherApplications: [second, other()] }));
		const c = r.cumulative;
		// Oldest run first.
		expect(c.applications.map((x) => x.scenarioName)).toEqual(['Farm one dam', 'Approved weir']);
		expect(c.applications[0]!.ewrDays).toBe(days(otherOut) - days(baseOut));
		expect(c.applications[0]!.reservePp).toBeCloseTo((outletOf(otherOut).rate! - outletOf(baseOut).rate!) * 100, 9);
		expect(c.counted).toBe(2);
		expect(c.total.ewrDays).toBe(2 * (days(otherOut) - days(baseOut)));
		expect(c.withThis!.ewrDays).toBe(c.total.ewrDays! + (days(appOut) - days(baseOut)));
		// Page 1: the last row, no band, its basis saying it is a sum and naming WP-3.11.
		const row = r.rows.at(-1)!;
		expect(row.id).toBe('otherApplications');
		expect(row.basis).toBe(CUMULATIVE_BASIS);
		expect(row.basis).toMatch(/not one combined run \(WP-3\.11\)$/);
		expect(row.change).toEqual({ run: c.total.ewrDays, band: null, bandNote: CUMULATIVE_NO_BAND, worse: null });
		expect(row.note).toMatch(/^2 applications: “Farm one dam”, “Approved weir”\./);
	});

	it('names at most three on page 1, so the row stays one row high; § 4 lists every one', () => {
		const many = Array.from({ length: 5 }, (_, k) => other({ scenarioId: `s${k}`, scenarioName: `App ${k}`, runId: `r${k}`, runCreatedAt: `2026-09-0${k + 1}T00:00:00.000Z` }));
		const r = evidenceReport(input({ otherApplications: many }));
		expect(r.rows.at(-1)!.note).toMatch(/^5 applications: “App 0”, “App 1”, “App 2”, 2 more in § 4\./);
		expect(r.cumulative.applications).toHaveLength(5);
	});

	it('leaves out of the sum an application run on another engine, period or runoff model, saying why', () => {
		const r = evidenceReport(input({ otherApplications: [other(), other({ scenarioId: 'scn-4', runId: 'run-4', engineVersion: '1.29.0' }), other({ scenarioId: 'scn-5', runId: 'run-5', endDate: '1994-09-30' })] }));
		const c = r.cumulative;
		expect(c.applications.map((x) => x.comparable)).toEqual([true, false, false]);
		expect(c.applications[1]!.reason).toMatch(/engine 1\.29\.0/);
		expect(c.applications[2]!.reason).toMatch(/another period/);
		// Positive control: the comparable one alone is summed.
		expect(c.counted).toBe(1);
		expect(c.total.ewrDays).toBe(days(otherOut) - days(baseOut));
		expect(r.rows.at(-1)!.note).toMatch(/2 more not counted/);
	});

	it('says "None" when there is no other application, and baseline evidence has no row', () => {
		const none = evidenceReport(input());
		expect(none.rows.at(-1)).toMatchObject({ id: 'otherApplications', notAssessed: CUMULATIVE_NONE, change: null });
		const baseline = evidenceReport(input({ application: null, changes: [], otherApplications: [other()] }));
		expect(baseline.rows.some((x) => x.id === 'otherApplications')).toBe(false);
		expect(baseline.cumulative.withThis).toBeNull();
		expect(baseline.cumulative.counted).toBe(1);
	});

	it('does not sum a list the backend cut at its cap: the row says so, § 4 still lists each', () => {
		const r = evidenceReport(input({ otherApplications: [other()], otherApplicationsTruncated: true }));
		expect(r.cumulative.truncated).toBe(true);
		expect(r.cumulative.applications).toHaveLength(1);
		expect(r.cumulative.total).toEqual({ ewrDays: null, reservePp: null });
		expect(r.rows.at(-1)).toMatchObject({ id: 'otherApplications', notAssessed: CUMULATIVE_TRUNCATED(1), change: null, note: null });
		// Control: the same list, not cut, is summed.
		expect(evidenceReport(input({ otherApplications: [other()] })).cumulative.total.ewrDays).not.toBeNull();
	});

	it('has no Reserve change without a rule table at the outlet', () => {
		const b = stored('base', base, { ...baseOut, summary: { ...baseOut.summary, ewrAssurance: [] } });
		const c = evidenceReport(input({ baseline: b, otherApplications: [other()] })).cumulative;
		expect(c.applications[0]!.reservePp).toBeNull();
		expect(c.total.reservePp).toBeNull();
		expect(c.total.ewrDays).not.toBeNull();
	});
});

describe('page 1’s licence impact by year class (evidence-5, issue #53 R7)', () => {
	const catchment = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)!.values.map((v) => (Number.isNaN(v) ? null : v));
	const impact = {
		yearClassMethod: 'auto' as const,
		siteNodeId: null,
		series: { backgroundNatural: catchment(baseOut, 'natural_flow'), backgroundEwrShortfall: catchment(baseOut, 'ewr_shortfall'), applicationEwrShortfall: catchment(appOut, 'ewr_shortfall') }
	};

	it('carries the engine’s board for the two runs, built from their stored series', () => {
		const r = evidenceReport(input({ impact }));
		expect(r.version).toBe('evidence-6');
		expect(r.licenceImpact?.result.status).toBe('ok');
		expect(r.licenceImpact?.result).toEqual({ status: 'ok', impact: licenceImpactByYearClass({ background: baseOut, application: appOut, yearClassMethod: 'auto' }) });
	});

	it('says the board wasn’t built without its inputs, and has none for baseline evidence', () => {
		expect(evidenceReport(input()).licenceImpact?.result).toEqual({ status: 'unavailable', reason: 'notBuilt', detail: null });
		expect(evidenceReport(input({ application: null, changes: [], impact })).licenceImpact).toBeNull();
	});
});
