// The licensing evidence report (issue #71, docs/design/evidence-report.md §11):
// fixed sections and rows with absence printed, the refusal and issue checks
// each with a positive control, the cited ensemble (G4), determinism, and
// parity with the compare page's numbers (G14). Real engine runs of a
// synthetic catchment: two farms and a gauge, an invented Reserve table.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { compareRuns } from '../compare';
import { ENGINE_ERRATA } from '../liability/errata.generated';
import { KNOWN_LIMITATIONS } from '../liability/limitations.generated';
import { METHODOLOGY } from '../liability/methodology.generated';
import { canonicalJson } from '../manifest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { Rng } from '../random';
import { blankEwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import { resolveEnsembleOptions, runEnsemble, summariseEnsemble } from '../uncertainty/ensemble';
import type { DeclaredUncertaintyRule } from '../uncertainty/options';
import { runPairedEnsemble, summarisePaired } from '../uncertainty/paired';
import { BASIS_PRAGMATIC, citedEnsemble, evidenceChecks, evidenceReport, NO_BAND } from './report';
import type { EvidenceEnsembleInput, EvidenceInput, EvidenceRunInput } from './types';

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
function baseInput(opts: { rule?: DeclaredUncertaintyRule | null; reserve?: boolean } = {}): ModelInput {
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
				node({ id: 'F2', name: 'Farm two', downstreamNodeId: 'F1', areaKm2: 15 })
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
const PAIRED = ens({ id: 'p1', runId: 'app', baselineId: 'e1', summary: null, paired: summarisePaired(ensemble, pairedRun) });

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
		expect(ids(r).slice(0, 5)).toEqual(['reserve', 'ewrDays', 'shortfall', 'outflowMar', 'applicantSupply']);
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
		// The applicant's supply has no band in the ensemble: it says so rather than subtracting two bands.
		const own = r.rows.find((x) => x.id === 'applicantSupply')!;
		expect(own.change!.band).toBeNull();
		expect(own.change!.bandNote).toBe(NO_BAND.notCarried);
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

describe('baseline evidence (the nominated run alone)', () => {
	const r = evidenceReport(input({ application: null, changes: [] }));

	it('has the river, credibility and appendices without change columns', () => {
		expect(r.mode).toBe('baseline');
		expect(ids(r)).toEqual(['reserve', 'ewrDays', 'shortfall', 'outflowMar']);
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
		expect(evidenceReport(i).verification.errata.filter((e) => e.keyedOn === 'run')).toEqual([]);
	});
});
