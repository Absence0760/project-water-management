// The licensing evidence report's endpoint (issue #71, docs/api.md § Evidence
// report): GET /projects/:id/runs/:runId/evidence-report. End to end on a
// synthetic catchment: a nominated baseline with a declared uncertainty rule
// and a stored ensemble on it, an application scenario with a paired band.
// Who may read it (a viewer, positive control; a stranger 404; a contributor
// and a farmer 403; the role ladder, projects/role-ladder.db.test.ts, sweeps
// the route too), that it reads the application's base run as the baseline, cites the
// ensemble and recomputes the paired Reserve share, lists every start, and
// refuses what isn't evidence.
import {
	COMBINED_CONFLICT,
	declaredRuleRequest,
	licenceImpactSection,
	localityMapSvg,
	runEnsemble,
	runPairedEnsemble,
	type DeclaredUncertaintyRule,
	type EvidenceReport,
	type ModelInput
} from '@water-management/engine';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let contributor: User;
let farmer: User;
let projectId: string;
let farmId: string;
let baseRun: string;
let appRun: string;
let cited: string;

const DAYS = 3 * 365;
/** Loose, so the small synthetic catchment keeps every member and the bands show. */
const RULE: DeclaredUncertaintyRule = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };

const runPath = (runId: string) => `/projects/${projectId}/runs/${runId}`;
const report = (u: User, runId: string) => u.call('GET', `${runPath(runId)}/evidence-report`);

async function newRun(label: string) {
	const res = await owner.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}
const inputOf = async (runId: string): Promise<ModelInput> => (await owner.call('GET', `${runPath(runId)}/model-input`)).body.input;

/** Start an ensemble (or a paired one), run it here as the browser would, and store it. */
async function ensemble(runId: string, body: unknown, pairedOn?: Parameters<typeof runPairedEnsemble>[1]) {
	const started = await owner.call('POST', `${runPath(runId)}/uncertainty`, body);
	expect(started.status, JSON.stringify(started.body)).toBe(201);
	const row = started.body.ensemble;
	const input = await inputOf(runId);
	const result = pairedOn ? { members: runPairedEnsemble(input, pairedOn).members } : (({ members, coverage }) => ({ members, coverage }))(runEnsemble(input, row.options));
	const done = await owner.call('POST', `${runPath(runId)}/uncertainty/${row.id}/result`, result);
	expect(done.status, JSON.stringify(done.body)).toBe(200);
	return row.id as string;
}

beforeAll(async () => {
	[owner, viewer, stranger, contributor, farmer] = await Promise.all([signUp('EvOwner'), signUp('EvViewer'), signUp('EvStranger'), signUp('EvContributor'), signUp('EvFarmer')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Evidence' })).body.project.id as string;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: contributor.email, role: 'contributor' })).status).toBe(201);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0 });
	farmId = farm.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmId] })).status).toBe(201);
	expect(
		(
			await owner.call('PATCH', `/projects/${projectId}`, {
				settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(5000), runoffModel: 'gr4j', evidenceUncertaintyRule: RULE }
			})
		).status
	).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 6) : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	const first = await newRun('seed');
	const flow = (await owner.call('GET', `${runPath(first)}/series?key=simulated_outflow`)).body.values as number[];
	expect(
		(await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2018-10-01', values: flow.map((q, i) => (q / 86_400) * (1 + 0.1 * Math.sin(i / 17))) })).status
	).toBe(200);
	baseRun = await newRun('Baseline');
	expect((await owner.call('POST', `/projects/${projectId}/evidence`, { runId: baseRun, reason: 'Calibrated baseline' })).status).toBe(201);

	// An ensemble off the declared rule first (listed, never cited), then one on it.
	await ensemble(baseRun, { request: { ...declaredRuleRequest(RULE), thresholds: { ...RULE.thresholds, minSkill: -9 } } });
	cited = await ensemble(baseRun, { request: declaredRuleRequest(RULE) });

	// The application: a dam on Upper, the applicant's own node (a proposal).
	const dam = { op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 500_000 };
	const created = await owner.call('POST', `/projects/${projectId}/scenarios`, {
		name: 'Upper dam',
		description: 'A 500 000 m³ dam on Upper.',
		purposeAndNeed: '  Winter storage for Upper’s orchards.  ',
		monitoring: 'A weir below the dam, read weekly.',
		baseRunId: baseRun,
		ops: [dam],
		ownedNodeIds: [farmId]
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `/projects/${projectId}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
	const base = (await owner.call('GET', `${runPath(baseRun)}/uncertainty/${cited}`)).body.ensemble;
	await ensemble(appRun, { baselineId: cited }, { options: base.options, header: base.result.header, members: base.result.members });
}, 600_000);

describe('GET …/runs/:runId/evidence-report', () => {
	it('gives a viewer the application report on its base run (positive control), and hides it from a stranger', async () => {
		const res = await report(viewer, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const r = res.body.report as EvidenceReport;
		expect(r.mode).toBe('application');
		expect(r.identity.baseline.runId).toBe(baseRun);
		expect(r.identity.application).toMatchObject({ runId: appRun, scenarioName: 'Upper dam', proposals: 1, assumptions: 0 });
		expect(r.identity.baseline.nomination?.reason).toBe('Calibrated baseline');
		expect((await report(stranger, appRun)).status).toBe(404);
		expect((await report(owner, crypto.randomUUID())).status).toBe(404);
		expect((await report(owner, 'not-a-uuid')).status).toBe(404);
	});

	it('refuses a contributor and a farmer (403: members below viewer), for the application and the baseline', async () => {
		for (const u of [contributor, farmer])
			for (const runId of [appRun, baseRun]) {
				const res = await report(u, runId);
				expect(res.status, JSON.stringify(res.body)).toBe(403);
				expect(res.body.report).toBeUndefined();
			}
		// Positive control: the same runs answer the viewer.
		expect((await report(viewer, baseRun)).status).toBe(200);
	});

	it('cites the ensemble on the declared rule, lists the other start, and pairs the change', async () => {
		const r = (await report(owner, appRun)).body.report as EvidenceReport;
		expect(r.refused).toBe(false);
		expect(r.uncertainty.cited?.id).toBe(cited);
		expect(r.uncertainty.ledger).toHaveLength(2);
		const off = r.uncertainty.ledger.find((e) => !e.cited)!;
		expect(off.departsFromDeclared).toEqual([{ label: 'Lowest skill kept', a: '-10', b: '-9' }]);
		const days = r.rows.find((x) => x.id === 'ewrDays')!;
		expect(days.change?.band?.p50).not.toBeNull();
		expect(days.change?.worse?.n).toBe(r.uncertainty.paired?.members);
		// The engine-1.33.0 measures, recomputed with the scenario's own units (the backend passes them: Upper has no
		// crop, so no demand and no pairs for its own-supply band, which exists all the same).
		expect(r.uncertainty.paired?.carriesMeasures).toBe(true);
		expect(r.uncertainty.paired?.ownSupply?.band.n).toBe(0);
		expect(r.rows.find((x) => x.id === 'noFlowDays')!.change?.worse?.n).toBe(r.uncertainty.paired?.members);
		expect(r.servedWhileFailing.notAssessed).toBeNull();
		expect(r.checks.filter((c) => !c.passed && c.blocksIssue).map((c) => c.id)).toEqual([]);
		expect(r.issuable).toBe(true);
		// The input diff and the ledger of application runs on this baseline.
		expect(r.appendix.changes.some((c) => c.subject === 'Upper')).toBe(true);
		expect(r.appendix.applicationRuns.map((x) => x.runId)).toEqual([appRun]);
		expect(r.applicantStatement?.description).toBe('A 500 000 m³ dam on Upper.');
		// Appendix C's fixed prompts (evidence-8), as the scenario holds them (trimmed); the unanswered one empty, for "Not given".
		expect(r.applicantStatement?.prompts).toEqual({ purposeAndNeed: 'Winter storage for Upper’s orchards.', mitigation: '', monitoring: 'A weir below the dam, read weekly.' });
		// Every input series with the run's recorded SHA-256.
		expect(r.appendix.series.filter((s) => s.run === 'baseline').every((s) => /^[0-9a-f]{64}$/.test(s.sha256 ?? ''))).toBe(true);
	});

	it('gives the baseline report for the nominated run itself', async () => {
		const r = (await report(viewer, baseRun)).body.report as EvidenceReport;
		expect(r.mode).toBe('baseline');
		expect(r.identity.application).toBeNull();
		expect(r.refused).toBe(false);
	});

	it('refuses as evidence a run that isn’t the nomination (it still answers, with the failed check)', async () => {
		const other = await newRun('Not nominated');
		const r = (await report(owner, other)).body.report as EvidenceReport;
		expect(r.refused).toBe(true);
		expect(r.checks.find((c) => c.id === 'nominated')?.passed).toBe(false);
		// Positive control: the nominated run passes the same check.
		expect(((await report(owner, baseRun)).body.report as EvidenceReport).checks.find((c) => c.id === 'nominated')?.passed).toBe(true);
	});

	it('without a declared rule, cites nothing and can’t be issued', async () => {
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: null } })).status).toBe(200);
		const bare = await newRun('No rule');
		const r = (await report(owner, bare)).body.report as EvidenceReport;
		expect(r.uncertainty.declared).toBeNull();
		expect(r.uncertainty.cited).toBeNull();
		expect(r.issuable).toBe(false);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: RULE } })).status).toBe(200);
	});
});

describe('settings.evidenceUncertaintyRule', () => {
	it('refuses a malformed rule (400) and stores a good one whole', async () => {
		const bad = await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: { ...RULE, members: 5 } } });
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toMatch(/members must be a whole number from 30/);
		const other = { ...RULE, thresholds: { ...RULE.thresholds, maxLowFlowBiasPct: 40 } };
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: other } })).status).toBe(200);
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.settings.evidenceUncertaintyRule).toEqual(other);
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: RULE } })).status).toBe(403);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: RULE } })).status).toBe(200);
	});

	it('withdraws the rule with null, which round-trips as null, and declares it again', async () => {
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: null } })).status).toBe(200);
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.settings.evidenceUncertaintyRule).toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { evidenceUncertaintyRule: RULE } })).status).toBe(200);
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.settings.evidenceUncertaintyRule).toEqual(RULE);
	});
});

describe('§ 5 registered water use (WP-3.10)', () => {
	it('reads each run’s own allocations: a run from before them is "Not assessed", a run after compares by unit, never with the holder or registration', async () => {
		// The nominated baseline ran without allocations.
		expect(((await report(viewer, baseRun)).body.report as EvidenceReport).allocations.notAssessed).toMatch(/^Not assessed: the runs carry no registered volumes/);
		const created = await owner.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: farmId,
			registrationNo: 'REG-EVIDENCE-7',
			authorisation: 'registration',
			holder: 'Evidence Holder Person',
			waterSource: 'surface',
			volumeM3PerYear: 100_000
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		// A stored run reads as it ran: adding a volume now doesn't reach it.
		expect(((await report(viewer, baseRun)).body.report as EvidenceReport).allocations.notAssessed).not.toBeNull();

		const withVolume = await newRun('With a registered volume');
		const res = await report(viewer, withVolume);
		expect(res.status).toBe(200);
		const r = res.body.report as EvidenceReport;
		expect(r.version).toBe('evidence-12');
		expect(r.allocations.notAssessed).toBeNull();
		expect(r.allocations.units.map((u) => u.name)).toEqual(['Upper']);
		const s = r.allocations.units[0]!.sources[0]!;
		expect(s.waterSource).toBe('surface');
		// Three years from 1 October 2018: two whole water years, and part of a third.
		expect(s.countsA?.wholeYears).toBe(2);
		expect(s.years.filter((y) => !y.partialA).every((y) => Math.abs(y.registeredA! - 100_000) < 1e-6)).toBe(true);
		expect(r.rows.find((x) => x.id === 'registeredUse')?.notAssessed).toBeNull();
		// Volumes, never the holder's name or registration number (D3), even though the viewer's project has them.
		const text = JSON.stringify(res.body);
		expect(text).not.toContain('Evidence Holder Person');
		expect(text).not.toContain('REG-EVIDENCE-7');
		// Positive control for that: the owner's allocation list carries the holder.
		expect(JSON.stringify((await owner.call('GET', `/projects/${projectId}/allocations`)).body)).toContain('Evidence Holder Person');
		// The same numbers as the Allocations tab for the run (G14).
		const tab = (await viewer.call('GET', `${runPath(withVolume)}/allocations`)).body.comparison;
		const tabYears = tab.nodes.find((n: { nodeId: string }) => n.nodeId === farmId).surface.years as { modelledM3: number; registeredM3: number }[];
		expect(s.years.map((y) => [y.modelledA, y.registeredA])).toEqual(tabYears.map((y) => [y.modelledM3, y.registeredM3]));
		expect((await owner.call('DELETE', `/projects/${projectId}/allocations/${created.body.allocation.id}`)).status).toBe(204);
	});
});

describe('§ 4 other applications on the baseline (the cumulative table, evidence-3)', () => {
	const scenarioRunOf = async (u: User, name: string, value: number, own: boolean) => {
		const created = await u.call('POST', `/projects/${projectId}/scenarios`, {
			name,
			baseRunId: baseRun,
			ops: [{ op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value }],
			...(own ? { ownedNodeIds: [farmId] } : {})
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const sid = created.body.scenario.id as string;
		const ran = await u.call('POST', `/projects/${projectId}/scenarios/${sid}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		return { sid, runId: ran.body.run.id as string };
	};
	const submit = async (u: User, sid: string) => expect((await u.call('POST', `/projects/${projectId}/scenarios/${sid}/submit`, {})).status).toBe(200);
	let teamSubmitted: { sid: string; runId: string };
	let teamDraft: { sid: string; runId: string };
	let applicant: { sid: string; runId: string };
	let approved: { sid: string; runId: string };
	let refused: { sid: string; runId: string };
	let teamSubmittedNewest: string;
	let assessor: User;

	beforeAll(async () => {
		assessor = await signUp('EvAssessor');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: assessor.email, role: 'editor' })).status).toBe(201);
		await actForAuthority(owner, projectId, assessor.id);
		// An application's base must be published; the contributor applies for the farm they are linked to.
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId: baseRun })).status).toBe(201);
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${contributor.id}`, { nodeIds: [farmId] })).status).toBe(200);
		applicant = await scenarioRunOf(contributor, 'Applicant dam', 200_000, false);
		await submit(contributor, applicant.sid);
		teamSubmitted = await scenarioRunOf(owner, 'Second dam', 250_000, true);
		await submit(owner, teamSubmitted.sid);
		teamDraft = await scenarioRunOf(owner, 'Draft idea', 300_000, true);
		// Decided: an issued licence is still proposed use on this baseline (listed), a refusal isn't (never listed).
		approved = await scenarioRunOf(owner, 'Approved weir', 120_000, true);
		await submit(owner, approved.sid);
		expect((await assessor.call('POST', `/projects/${projectId}/scenarios/${approved.sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(200);
		refused = await scenarioRunOf(owner, 'Refused weir', 130_000, true);
		await submit(owner, refused.sid);
		expect((await assessor.call('POST', `/projects/${projectId}/scenarios/${refused.sid}/decide`, { ...DECISION, outcome: 'licence_refused' })).status).toBe(200);
		// A second run of the submitted team scenario: its newest is the one read.
		const again = await owner.call('POST', `/projects/${projectId}/scenarios/${teamSubmitted.sid}/runs`, {});
		expect(again.status, JSON.stringify(again.body)).toBe(201);
		teamSubmittedNewest = again.body.run.id as string;
	}, 300_000);

	const others = async (u: User) => {
		const res = await report(u, appRun);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return (res.body.report as EvidenceReport).cumulative;
	};

	it('lists each other submitted application with its own change, and sums them; never the report’s own scenario', async () => {
		const c = await others(owner);
		// Oldest run first: the applicant's, the approved weir's, then Second dam's newest run.
		expect(c.applications.map((x) => x.scenarioName)).toEqual(['Applicant dam', 'Approved weir', 'Second dam']);
		expect(c.applications.map((x) => [x.status, x.outcome])).toEqual([
			['submitted', null],
			['decided', 'licence_issued'],
			['submitted', null]
		]);
		expect(c.applications.every((x) => x.comparable)).toBe(true);
		expect(c.truncated).toBe(false);
		// A refused application is no longer proposed: never listed.
		expect(JSON.stringify(c)).not.toContain('Refused weir');
		const days = async (runId: string) => (await owner.call('GET', runPath(runId))).body.run.summary.catchment.ewrDaysNotMet as number;
		const base = await days(baseRun);
		// Of a scenario's runs, the newest of its ops is read.
		const second = c.applications.find((x) => x.scenarioName === 'Second dam')!;
		expect(second.runId).toBe(teamSubmittedNewest);
		expect(c.applications.some((x) => x.runId === teamSubmitted.runId)).toBe(false);
		expect(second.ewrDays).toBe((await days(teamSubmittedNewest)) - base);
		expect(c.total.ewrDays).toBe(c.applications.reduce((t, x) => t + x.ewrDays!, 0));
		expect(c.withThis?.ewrDays).toBe(c.total.ewrDays! + (await days(appRun)) - base);
		// Page 1's row reads one combined run, not this sum (evidence-11): these all set Upper's dam, so they conflict and it isn't assessed, naming each conflict.
		const r = (await report(owner, appRun)).body.report as EvidenceReport;
		expect(r.cumulative.combined!.applications.map((x) => x.scenarioName)).toEqual(['Upper dam', 'Applicant dam', 'Approved weir', 'Second dam']);
		expect(r.cumulative.combined!.conflicts.length).toBeGreaterThan(0);
		expect(r.cumulative.combined!.conflicts[0]).toMatch(/both change node "Upper": damCapacityM3$/);
		expect(r.rows.at(-1)).toMatchObject({ id: 'otherApplications', notAssessed: COMBINED_CONFLICT(r.cumulative.combined!.conflicts), change: null });
	});

	it('hides from a viewer the submitted application only editors may read, and lists no draft (RLS)', async () => {
		const c = await others(viewer);
		// Positive control: the team's submitted and decided scenarios, which a viewer reads.
		expect(c.applications.map((x) => x.scenarioName)).toEqual(['Approved weir', 'Second dam']);
		// The applicant's submitted application is the editors' to read, not a viewer's.
		expect((await viewer.call('GET', runPath(applicant.runId))).status).toBe(404);
		// A draft is visible to the viewer, but isn't an application yet: never listed.
		expect((await viewer.call('GET', runPath(teamDraft.runId))).status).toBe(200);
		expect(JSON.stringify(c)).not.toContain('Draft idea');
		expect(JSON.stringify(await others(owner))).not.toContain('Draft idea');
	});
});

describe('page 1’s licence impact by year class (evidence-5, issue #53 R7)', () => {
	it('is built on the server from the runs’ stored series and the project’s outcome settings', async () => {
		const r = (await report(viewer, appRun)).body.report as EvidenceReport;
		expect(r.licenceImpact).toMatchObject({ yearClassMethod: 'auto', requestedSite: null, site: null, siteFellBack: false });
		// The same board the browser built before evidence-5, from the series the viewer can fetch.
		const series = async (runId: string, key: string) => (await viewer.call('GET', `${runPath(runId)}/series?key=${key}`)).body.values as (number | null)[];
		const baseline = (await viewer.call('GET', `/projects/${projectId}/runs/${r.identity.baseline.runId}`)).body.run;
		const application = (await viewer.call('GET', runPath(appRun))).body.run;
		const expected = licenceImpactSection(
			{ ...baseline, inputs: r.appendix.baselineInputs },
			application,
			{
				yearClassMethod: 'auto',
				siteNodeId: null,
				series: {
					backgroundNatural: await series(r.identity.baseline.runId, 'natural_flow'),
					backgroundEwrShortfall: await series(r.identity.baseline.runId, 'ewr_shortfall'),
					applicationEwrShortfall: await series(appRun, 'ewr_shortfall')
				}
			}
		);
		expect(r.licenceImpact).toEqual(expected);
		expect(r.licenceImpact?.result.status).toBe('ok');
	});

	it('follows the project’s year-class method, and has no board for baseline evidence', async () => {
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { outcomes: { yearClassMethod: 'terciles' } } })).status).toBe(200);
		try {
			const r = (await report(viewer, appRun)).body.report as EvidenceReport;
			expect(r.licenceImpact?.yearClassMethod).toBe('terciles');
			expect(r.licenceImpact?.result.status === 'ok' && r.licenceImpact.result.impact.method).toBe('terciles');
		} finally {
			expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { outcomes: { yearClassMethod: 'auto' } } })).status).toBe(200);
		}
		expect(((await report(viewer, baseRun)).body.report as EvidenceReport).licenceImpact).toBeNull();
	});
});

describe('§ 6 the applicant’s demand objects and their sources (evidence-9)', () => {
	it('lists what the application adds on the applicant’s unit, with its source and note as the run stored them, and flags the unmetered share', async () => {
		// The dam application has no demand object: § 6 is there, and says so.
		const dam = (await report(viewer, appRun)).body.report as EvidenceReport;
		expect(dam.demandObjects?.notAssessed).toMatch(/^Not assessed: no demand object is on the applicant’s units/);
		expect(dam.flags.some((f) => f.id === 'demandSource')).toBe(false);
		// Baseline evidence has no applicant, so no § 6.
		expect(((await report(viewer, baseRun)).body.report as EvidenceReport).demandObjects).toBeNull();

		const object = (name: string, over: Record<string, unknown>) => ({
			id: crypto.randomUUID(),
			nodeId: farmId,
			name,
			category: 'domestic',
			sizing: 'monthly',
			monthlyM3Day: monthly(30),
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0,
			priority: 'first',
			destination: 'internal',
			enabled: true,
			...over
		});
		const metered = object('Staff housing', { source: 'meter', note: 'Meter M-12, 2024–25 readings' });
		const village = object('Labour village', { sizing: 'perUnit', monthlyM3Day: null, count: 300, litresPerUnitDay: 230 });
		const created = await owner.call('POST', `/projects/${projectId}/scenarios`, {
			name: 'Upper housing',
			baseRunId: baseRun,
			ops: [
				{ op: 'demandObject.add', demandObject: metered },
				{ op: 'demandObject.add', demandObject: village }
			],
			ownedNodeIds: [farmId]
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const ran = await owner.call('POST', `/projects/${projectId}/scenarios/${created.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		const runId = ran.body.run.id as string;

		const r = (await report(viewer, runId)).body.report as EvidenceReport;
		expect(r.version).toBe('evidence-12');
		const d = r.demandObjects!;
		expect(d.notAssessed).toBeNull();
		expect(d.objects.map((o) => [o.name, o.unit, o.change, o.source, o.note])).toEqual([
			['Staff housing', 'Upper', 'added', 'meter', 'Meter M-12, 2024–25 readings'],
			['Labour village', 'Upper', 'added', null, '']
		]);
		expect(d.objects[1]).toMatchObject({ sizing: 'perUnit', count: 300, litresPerUnitDay: 230, demandA: null });
		// The same demand as the run's own demand-objects table (G14).
		const run = (await viewer.call('GET', runPath(runId))).body.run;
		const table = run.summary.farms.flatMap((f: { demandObjects?: { id: string; avgDemandM3Day: number }[] }) => f.demandObjects ?? []);
		for (const o of d.objects) expect(o.demandB).toBe(table.find((x: { id: string }) => x.id === o.id).avgDemandM3Day);
		// 30 m³/day metered against 69 m³/day not recorded: most of it isn't metered, and the missing source is a question.
		expect(d.bySource.map((s) => s.source)).toEqual(['meter', null]);
		expect(d.bySource[0]!.share).toBeCloseTo(30 / 99, 6);
		expect(r.flags.find((f) => f.id === 'demandSource')?.text).toBe('Most of the applicant’s demand objects’ demand isn’t from meter records: 30 % is, and 70 % has no source recorded (§ 6).');
		expect(r.questions.some((q) => q.startsWith('1 of the applicant’s demand objects has no source recorded (§ 6)'))).toBe(true);
	});
});

describe('§ 1’s locality map (evidence-12, issue #326 A5)', () => {
	const sq = (lon: number, lat: number, d: number) => [
		[lon, lat],
		[lon + d, lat],
		[lon + d, lat + d],
		[lon, lat + d],
		[lon, lat]
	];
	const add = async (body: Record<string, unknown>) => {
		const res = await owner.call('POST', `/projects/${projectId}/map/features`, body);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.feature.id as string;
	};

	it('is null with no map features; with them, it draws the applicant’s unit by name, another parcel unnamed, and names the SVG’s SHA-256', async () => {
		// No map features: the report says there is no locality map (null), and still builds.
		expect(((await report(viewer, appRun)).body.report as EvidenceReport).localityMap).toBeNull();

		const ids = [
			await add({ kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] } }),
			await add({ kind: 'farm_parcel', name: 'Upper block', nodeId: farmId, geometry: { type: 'Polygon', coordinates: [sq(21.31, -33.69, 0.03)] } }),
			await add({ kind: 'farm_parcel', name: 'Neighbour block', geometry: { type: 'Polygon', coordinates: [sq(21.36, -33.66, 0.02)] } }),
			await add({ kind: 'river', name: 'Sand River', geometry: { type: 'LineString', coordinates: [[21.3, -33.6], [21.4, -33.7]] } }),
			await add({ kind: 'gauge', name: 'Weir G1', geometry: { type: 'Point', coordinates: [21.39, -33.69] } }),
			await add({ kind: 'other', name: 'Pump house', geometry: { type: 'Point', coordinates: [21.35, -33.65] } })
		];
		try {
			const r = (await report(viewer, appRun)).body.report as EvidenceReport;
			const loc = r.localityMap!;
			expect(loc.applicant).toBe(true);
			expect(loc.features.map((f) => [f.layer, f.label])).toEqual([
				['boundary', null],
				['parcel', null],
				['applicantParcel', 'Upper'],
				['river', null],
				['gauge', 'Weir G1']
			]);
			// Another unit's parcel and an "other" feature leave nothing that names them.
			for (const hidden of ['Neighbour block', 'Pump house', 'Upper block', 'Sand River']) expect(JSON.stringify(loc)).not.toContain(hidden);
			// Drawn in the app counts what may be named: the boundary, the applicant's parcel, the river and the gauge, not the neighbour's parcel.
			expect(loc.drawnInApp).toBe(4);
			expect(loc.sources).toEqual([]);
			expect(loc.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			// The SHA-256 is the figure's, drawn from the report as served.
			expect(loc.svgSha256).toBe(createHash('sha256').update(localityMapSvg(loc).svg, 'utf8').digest('hex'));
			// Baseline evidence: no applicant, every parcel drawn alike.
			const b = ((await report(viewer, baseRun)).body.report as EvidenceReport).localityMap!;
			expect(b.applicant).toBe(false);
			expect(b.features.filter((f) => f.layer === 'parcel')).toHaveLength(2);
			expect(b.features.some((f) => f.label === 'Upper')).toBe(false);
		} finally {
			for (const id of ids) expect((await owner.call('DELETE', `/projects/${projectId}/map/features/${id}`)).status).toBe(204);
		}
	});
});
