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
	declaredRuleRequest,
	licenceImpactSection,
	runEnsemble,
	runPairedEnsemble,
	type DeclaredUncertaintyRule,
	type EvidenceReport,
	type ModelInput
} from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

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
	const created = await owner.call('POST', `/projects/${projectId}/scenarios`, { name: 'Upper dam', description: 'A 500 000 m³ dam on Upper.', baseRunId: baseRun, ops: [dam], ownedNodeIds: [farmId] });
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
		expect(r.version).toBe('evidence-7');
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
		// An application's base must be published; the contributor applies for the farm they are linked to.
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId: baseRun })).status).toBe(201);
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${contributor.id}`, { nodeIds: [farmId] })).status).toBe(200);
		applicant = await scenarioRunOf(contributor, 'Applicant dam', 200_000, false);
		await submit(contributor, applicant.sid);
		teamSubmitted = await scenarioRunOf(owner, 'Second dam', 250_000, true);
		await submit(owner, teamSubmitted.sid);
		teamDraft = await scenarioRunOf(owner, 'Draft idea', 300_000, true);
		// Decided: an approval is still proposed use on this baseline (listed), a refusal isn't (never listed).
		approved = await scenarioRunOf(owner, 'Approved weir', 120_000, true);
		await submit(owner, approved.sid);
		expect((await assessor.call('POST', `/projects/${projectId}/scenarios/${approved.sid}/decide`, { outcome: 'approved_with_conditions' })).status).toBe(200);
		refused = await scenarioRunOf(owner, 'Refused weir', 130_000, true);
		await submit(owner, refused.sid);
		expect((await assessor.call('POST', `/projects/${projectId}/scenarios/${refused.sid}/decide`, { outcome: 'refused' })).status).toBe(200);
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
			['decided', 'approved_with_conditions'],
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
		const r = (await report(owner, appRun)).body.report as EvidenceReport;
		expect(r.rows.at(-1)).toMatchObject({ id: 'otherApplications', notAssessed: null, change: { run: c.total.ewrDays, band: null } });
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
