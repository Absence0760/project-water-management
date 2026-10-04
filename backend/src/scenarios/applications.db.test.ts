// Applicants and applications (roadmap WP-3.3; 044_contributor_role,
// 045_contributor_scope; docs/scenarios.md § Applications). A contributor (a
// licence applicant or their consultant) works on the published baseline
// without seeing other applicants' drafts, other farms' inputs or anything
// unpublished; the assessors (editors) see what has been submitted. Every
// "cannot see" has its positive control.
import { blankEwrRuleTable } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, asOwner, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

const ZERO = '00000000-0000-4000-8000-000000000000';

let owner: User; // the assessing authority's modeller
let assessor: User; // editor
let viewer: User;
let applicantA: User; // contributor, linked to Rooikloof
let applicantB: User; // contributor, no farm link
let consultant: User; // contributor, shares A's application
let farmer: User; // farmer, linked to Kalkoenkrans
let teamApplicant: User; // a team member who is also a direct contributor
let stranger: User;
let projectId: string;
let published: string;
let unpublished: string;
// Gauge ← five farms (five holders: the catchment series' k).
const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
const kalkoenkrans = node('Kalkoenkrans', outlet.id, { damCapacityM3: 50_000 });
const bergvliet = node('Bergvliet', outlet.id);
const doornhoek = node('Doornhoek', outlet.id);
const waterval = node('Waterval', outlet.id);
const OTHER_FARMS = ['Kalkoenkrans', 'Bergvliet', 'Doornhoek', 'Waterval'];
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const damRaise = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

async function runModel(u: User, label: string) {
	const res = await u.call('POST', `${P()}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}

async function apply(u: User, name: string, ops: unknown[] = [damRaise(rooikloof.id, 120_000)]) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.scenario.id as string;
}

beforeAll(async () => {
	[owner, assessor, viewer, applicantA, applicantB, consultant, farmer, teamApplicant, stranger] = (await Promise.all(
		['Aowner', 'Assessor', 'Aviewer', 'Applicanta', 'Applicantb', 'Consultant', 'Afarmer', 'Teamapp', 'Astranger'].map((n) => signUp(n))
	)) as User[] as [User, User, User, User, User, User, User, User, User];
	const team = (await owner.call('POST', '/teams', { name: 'Assessing office' })).body.team.id as string;
	expect((await owner.call('POST', `/teams/${team}/members`, { email: teamApplicant.email, role: 'member' })).status).toBe(201);
	projectId = (await owner.call('POST', '/projects', { name: 'Applications', teamId: team })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans, bergvliet, doornhoek, waterval],
		crops: [citrus, lucerne],
		cropAreas: [
			{ nodeId: rooikloof.id, cropId: citrus.id, areaM2: 50_000 },
			{ nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 30_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: new Array(days).fill(0.2) })).status).toBe(200);
	published = await runModel(owner, 'Baseline');
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	unpublished = await runModel(owner, 'Work in progress');
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor'],
		[consultant, 'contributor'],
		[teamApplicant, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [kalkoenkrans.id] })).status).toBe(201);
	// The assessor acts for the responsible authority (163): only such a member records its decision.
	await actForAuthority(owner, projectId, assessor.id);
	// A contributor keeps farm links (045 widened farm_link_check and /farmers/:userId).
	const linked = await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] });
	expect(linked.status, JSON.stringify(linked.body)).toBe(200);
	expect(linked.body.farmer).toMatchObject({ role: 'contributor', nodeIds: [rooikloof.id] });
	// A and their consultant are one applying party (049): whom A may share with.
	for (const u of [applicantA, consultant]) {
		const res = await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' });
		expect(res.body.member, u.email).toMatchObject({ role: 'contributor', party: 'Rooikloof Trust' });
	}
});

describe('an application', () => {
	let sid: string;
	let draftRun: string;
	const seen: unknown[] = [];
	const asA = async (method: string, path: string, body?: unknown) => {
		const res = await applicantA.call(method, path, body);
		seen.push(res.body);
		return res;
	};

	it('is made by a contributor on the published run, owning their linked farm, and hidden from everyone else', async () => {
		const res = await asA('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof', baseRunId: published, ops: [damRaise(rooikloof.id, 120_000)] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		sid = res.body.scenario.id;
		expect(res.body.scenario).toMatchObject({
			origin: 'applicant',
			status: 'draft',
			ownerUserId: applicantA.id,
			ownedNodeIds: [rooikloof.id],
			baseRun: { id: published, label: 'Baseline' },
			members: [],
			submittedAt: null,
			outcome: null
		});
		// Its own farm: the dam raise is the proposal.
		expect(res.body.check.classified).toEqual(['proposal']);
		// Positive control: A lists and reads it.
		expect((await asA('GET', `${P()}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id)).toEqual([sid]);
		expect((await asA('GET', `${P()}/scenarios/${sid}`)).status).toBe(200);
		// Nobody else does, not even the assessors while it is a draft.
		for (const u of [applicantB, consultant, assessor, viewer, owner]) {
			expect((await u.call('GET', `${P()}/scenarios/${sid}`)).status, u.email).toBe(404);
			expect((await u.call('GET', `${P()}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id), u.email).not.toContain(sid);
			expect(await rowsAs(u, 'SELECT id FROM scenario WHERE id = $1', [sid]), u.email).toEqual([]);
		}
		expect((await assessor.call('GET', `${P()}/applications`)).body.applications).toEqual([]);
		// A farmer: 403 like every scenario route.
		expect((await farmer.call('GET', `${P()}/scenarios`)).status).toBe(403);
	});

	it("is shared with the applicant's consultant, who then reads it (and leaves)", async () => {
		// Whom A may share with: their party, as the owner set it (049), and nobody else.
		expect((await asA('GET', `${P()}/scenarios/${sid}/share-candidates`)).body).toEqual({ candidates: [{ userId: consultant.id, displayName: 'Consultant' }] });
		const res = await asA('POST', `${P()}/scenarios/${sid}/members`, { userId: consultant.id });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.members).toEqual([{ userId: consultant.id, displayName: 'Consultant' }]);
		expect((await consultant.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(200);
		// Still hidden from the other applicant (control above: the consultant sees it).
		expect((await applicantB.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		// Anyone else (members outside the party, a farmer, a stranger, no one):
		// one refusal. oracles.db.test.ts has the full set.
		for (const u of [applicantB.id, farmer.id, stranger.id, ZERO]) {
			expect(await asA('POST', `${P()}/scenarios/${sid}/members`, { userId: u }), u).toEqual({ status: 404, body: { error: 'not someone you can share this application with' } });
		}
		// Only the owner shares, and lists candidates.
		expect((await consultant.call('POST', `${P()}/scenarios/${sid}/members`, { userId: applicantB.id })).status).toBe(403);
		expect((await consultant.call('GET', `${P()}/scenarios/${sid}/share-candidates`)).status).toBe(403);
		// The consultant leaves, then is added back.
		expect((await consultant.call('DELETE', `${P()}/scenarios/${sid}/members/${consultant.id}`)).status).toBe(204);
		expect((await consultant.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		expect((await asA('POST', `${P()}/scenarios/${sid}/members`, { userId: consultant.id })).status).toBe(201);
	});

	it('shows the applicant the base with every other farm anonymised', async () => {
		const res = await asA('GET', `${P()}/scenarios/${sid}/base`);
		expect(res.status).toBe(200);
		const nodes = res.body.model.nodes as { id: string; name: string; damCapacityM3: number; areaKm2: number }[];
		expect(nodes.find((n) => n.id === rooikloof.id)).toMatchObject({ name: 'Rooikloof', damCapacityM3: 100_000 });
		expect(nodes.find((n) => n.id === outlet.id)).toMatchObject({ name: 'Gauge' });
		const k = nodes.find((n) => n.id === kalkoenkrans.id)!;
		expect(k.name).toMatch(/^Farm \d$/);
		expect(k.damCapacityM3).toBe(0);
		expect(k.areaKm2).toBe(0);
		expect(res.body.anonymisedNodeIds.sort()).toEqual([kalkoenkrans.id, bergvliet.id, doornhoek.id, waterval.id].sort());
		// Only the crops on their own farm.
		expect(res.body.model.crops.map((c: { name: string }) => c.name)).toEqual(['Citrus']);
		expect(res.body.model.cropAreas).toEqual([{ nodeId: rooikloof.id, cropId: citrus.id, areaM2: 50_000 }]);
		// Positive control: an editor gets the base as it is.
		const team = await apply(owner, 'Team look', []);
		const full = await owner.call('GET', `${P()}/scenarios/${team}/base`);
		expect(full.body.anonymisedNodeIds).toEqual([]);
		expect(full.body.model.nodes.find((n: { id: string }) => n.id === kalkoenkrans.id)).toMatchObject({ name: 'Kalkoenkrans', damCapacityM3: 50_000 });
	});

	it('runs as the applicant, hidden from the assessors while a draft; its row but never the published run', async () => {
		const res = await asA('POST', `${P()}/scenarios/${sid}/runs`, {});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		draftRun = res.body.run.id;
		// Metadata only: the summary names every farm.
		expect(res.body.run.summary).toBeUndefined();
		expect(res.body.run.scenarioId).toBe(sid);
		// A and the consultant read the run's metadata (app_scenario_run_meta,
		// 046) and the application's run count, never its row: its inputs are
		// the whole base, every farm's parameters. Nor its stored input series.
		for (const u of [applicantA, consultant]) {
			expect(await rowsAs(u, 'SELECT id, label FROM app_scenario_run_meta($1, $2)', [projectId, sid]), u.email).toEqual([{ id: draftRun, label: 'Raise Rooikloof' }]);
			expect((await u.call('GET', `${P()}/scenarios/${sid}`)).body.scenario, u.email).toMatchObject({ runCount: 1, lastRun: { id: draftRun, label: 'Raise Rooikloof' } });
			expect(await rowsAs(u, 'SELECT id, inputs FROM model_run WHERE id = $1', [draftRun]), u.email).toEqual([]);
			expect(await rowsAs(u, 'SELECT id FROM model_run WHERE scenario_id = $1', [sid]), u.email).toEqual([]);
			expect(await rowsAs(u, 'SELECT kind FROM run_input_series WHERE run_id = $1', [draftRun]), u.email).toEqual([]);
			// The published-base channel answers a published run of the model only, never a scenario run.
			expect(await rowsAs(u, 'SELECT inputs FROM app_published_run_input($1, $2)', [projectId, draftRun]), u.email).toEqual([]);
			expect(await rowsAs(u, 'SELECT kind FROM app_published_run_series($1, $2)', [projectId, draftRun]), u.email).toEqual([]);
			// Its series: the application's own node (Rooikloof, whoever reads it)
			// and the catchment allowlist; no other farm's, whose demand and
			// storage carry that farm's area and dam.
			const series = await rowsAs<{ key: string; node_id: string | null }>(u, 'SELECT key, node_id FROM run_series WHERE run_id = $1', [draftRun]);
			expect(new Set(series.filter((k) => k.node_id !== null).map((k) => k.node_id)), u.email).toEqual(new Set([rooikloof.id]));
			const catchment = series.filter((k) => k.node_id === null).map((k) => k.key);
			expect(catchment.length, u.email).toBeGreaterThan(0);
			expect(catchment.every((k) => ['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall'].includes(k)), u.email).toBe(true);
		}
		// Positive control: the row, its inputs and every farm's series exist (the schema owner reads them).
		const [row] = await asOwner('SELECT inputs FROM model_run WHERE id = $1', [draftRun]);
		expect(JSON.stringify(row.inputs)).toContain('Kalkoenkrans');
		const allNodes = await asOwner('SELECT DISTINCT node_id FROM run_series WHERE run_id = $1 AND node_id IS NOT NULL', [draftRun]);
		expect(allNodes.map((r: { node_id: string }) => r.node_id)).toContain(kalkoenkrans.id);
		expect((await asOwner('SELECT count(*)::int AS n FROM run_input_series WHERE run_id = $1', [draftRun]))[0].n).toBeGreaterThan(0);
		// The assessors and viewers don't, nor does the other applicant.
		for (const u of [assessor, viewer, applicantB]) {
			expect(await rowsAs(u, 'SELECT id FROM model_run WHERE id = $1', [draftRun]), u.email).toEqual([]);
			expect((await rowsAs<{ n: number }>(u, 'SELECT count(*)::int AS n FROM run_series WHERE run_id = $1', [draftRun]))[0]!.n, u.email).toBe(0);
		}
		expect((await assessor.call('GET', `${P()}/runs`)).body.runs.map((r: { id: string }) => r.id)).not.toContain(draftRun);
		// The published run's row stays out of reach (its inputs hold every farm); its catchment series don't.
		expect(await rowsAs(applicantA, 'SELECT id FROM model_run WHERE id = $1', [published])).toEqual([]);
		const keys = await rowsAs<{ key: string; node_id: string | null }>(applicantA, 'SELECT key, node_id FROM run_series WHERE run_id = $1', [published]);
		const catchment = keys.filter((k) => k.node_id === null);
		expect(catchment.length).toBeGreaterThan(0);
		expect(catchment.every((k) => ['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall'].includes(k.key))).toBe(true);
		// …and, as a farmer would, their own farm's allowlisted keys (022), no other farm's.
		expect(new Set(keys.filter((k) => k.node_id !== null).map((k) => k.node_id))).toEqual(new Set([rooikloof.id]));
		// …of a published run only (control: the published one above).
		expect(await rowsAs(applicantA, 'SELECT key FROM run_series WHERE run_id = $1', [unpublished])).toEqual([]);
		// A contributor without farm links reads the same catchment series, and no farm's.
		expect((await rowsAs(applicantB, 'SELECT key FROM run_series WHERE run_id = $1 AND node_id IS NOT NULL', [published]))).toEqual([]);
		// The project's log says a run was made, not what the draft is called.
		const [event] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'run.created' AND subject->>'runId' = $2`, [projectId, draftRun]);
		expect(event.subject).toEqual(expect.objectContaining({ application: true }));
		expect(JSON.stringify(event.subject)).not.toContain('Raise Rooikloof');
	});

	it('keeps an applicant to the published baseline and their own scenarios through the API', async () => {
		// An unpublished run is not a base (404, as if it didn't exist), nor is any run's page.
		expect((await asA('POST', `${P()}/scenarios`, { name: 'Sneaky', baseRunId: unpublished })).status).toBe(404);
		for (const r of [published, unpublished, draftRun]) {
			expect((await asA('GET', `${P()}/runs/${r}`)).status, r).toBe(403);
			expect((await asA('GET', `/compare/runs?a=${projectId}:${published}&b=${projectId}:${r}`)).status, r).toBe(403);
		}
		expect((await asA('GET', `${P()}/model`)).status).toBe(403);
		expect((await asA('PUT', `${P()}/model`, { nodes: [], crops: [], cropAreas: [], transfers: [] })).status).toBe(403);
		// Positive control: an editor can.
		expect((await assessor.call('GET', `${P()}/model`)).status).toBe(200);
		// An applicant's own hydrological units are their links, not what they claim.
		expect((await asA('POST', `${P()}/scenarios`, { name: 'Claim', baseRunId: published, ownedNodeIds: [kalkoenkrans.id] })).status).toBe(403);
		// A team scenario is not theirs to read.
		expect((await asA('GET', `${P()}/scenarios`)).body.scenarios.every((s: { origin: string }) => s.origin === 'applicant')).toBe(true);
	});

	it('names no other farm in anything the applicant received (D2 default)', async () => {
		// An op on another farm is a baseline assumption (the engine's messages
		// about it are renamed: applicant.test.ts).
		const res = await asA('PATCH', `${P()}/scenarios/${sid}`, { ops: [damRaise(rooikloof.id, 120_000), damRaise(kalkoenkrans.id, 10)] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.check.classified).toEqual(['proposal', 'baseline']);
		// The names kept with the ops (047): only their own farm's, in the answer and in the row itself
		// (positive control: a team scenario keeps every name its ops need, scenarios.db.test.ts).
		expect(res.body.scenario.opNames).toEqual([{ id: rooikloof.id, name: 'Rooikloof' }]);
		const [row] = await asOwner('SELECT op_names FROM scenario WHERE id = $1', [sid]);
		expect(row.op_names).toEqual([{ id: rooikloof.id, name: 'Rooikloof' }]);
		expect((await asA('PATCH', `${P()}/scenarios/${sid}`, { ops: [damRaise(rooikloof.id, 120_000)] })).status).toBe(200);
		const text = JSON.stringify(seen);
		for (const name of OTHER_FARMS) expect(text, name).not.toContain(name);
		expect(text).toContain('Rooikloof');
	});

	it('may change the Reserve’s rule table (engine ≥ 1.6.0), which is always a baseline assumption, never refused', async () => {
		// Like every baseline op (settings, another party's node, an EWR site's flag): an
		// application can't hide an assumption change, but may show one to the assessor.
		const table = { ...blankEwrRuleTable(null), source: 'Invented desktop estimate', sourceKind: 'desktop', ewr: Array.from({ length: 12 }, () => [9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5]) };
		const res = await asA('POST', `${P()}/scenarios`, { name: 'Raise Rooikloof, desktop Reserve', baseRunId: published, ops: [damRaise(rooikloof.id, 120_000), { op: 'ewrRule.set', table }] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.check.problems).toEqual([]);
		// Positive control: the dam raise on their own farm is still the proposal.
		expect(res.body.check.classified).toEqual(['proposal', 'baseline']);
		expect(res.body.check.applied.map((a: { index: number }) => a.index)).toEqual([0, 1]);
		expect((await asA('DELETE', `${P()}/scenarios/${res.body.scenario.id}`)).status).toBe(204);
	});

	it('is submitted by its owner, frozen, then seen by the assessors (not viewers) with its runs', async () => {
		expect((await consultant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(403);
		// Where written objections go, as the notice gives them (166_public_participation): set while a draft…
		const notice = await asA('PATCH', `${P()}/scenarios/${sid}`, { objectionAddress: 'The EAP, PO Box 1', objectionClosingDate: '2026-11-30' });
		expect(notice.status, JSON.stringify(notice.body)).toBe(200);
		expect(notice.body.scenario).toMatchObject({ objectionAddress: 'The EAP, PO Box 1', objectionClosingDate: '2026-11-30' });
		const res = await asA('POST', `${P()}/scenarios/${sid}/submit`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario.status).toBe('submitted');
		expect(res.body.scenario.submittedAt).not.toBeNull();
		// Frozen: the ops can't change, through the API or the table; nor the notice's details (166).
		expect((await asA('PATCH', `${P()}/scenarios/${sid}`, { ops: [] })).status).toBe(409);
		expect((await asA('PATCH', `${P()}/scenarios/${sid}`, { objectionAddress: 'Elsewhere' })).status).toBe(409);
		expect(res.body.scenario).toMatchObject({ objectionAddress: 'The EAP, PO Box 1', objectionClosingDate: '2026-11-30' });
		await expect(withUser(applicantA.id, (db) => db.query(`UPDATE scenario SET ops = '[]' WHERE id = $1`, [sid]))).rejects.toMatchObject({ code: '23514' });
		// The assessors see it, and its run.
		const list = await assessor.call('GET', `${P()}/applications`);
		expect(list.body.applications.map((a: { id: string; owner: string }) => [a.id, a.owner])).toEqual([[sid, 'Applicanta']]);
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(200);
		expect(await rowsAs(assessor, 'SELECT id FROM model_run WHERE id = $1', [draftRun])).toHaveLength(1);
		// …in full, every farm's series too (the applicant still reads neither: control for the test above).
		expect((await rowsAs<{ node_id: string }>(assessor, 'SELECT DISTINCT node_id FROM run_series WHERE run_id = $1', [draftRun])).map((r) => r.node_id)).toContain(kalkoenkrans.id);
		expect(await rowsAs(applicantA, 'SELECT id FROM model_run WHERE id = $1', [draftRun])).toEqual([]);
		// Viewers still don't, until it is decided.
		expect((await viewer.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		expect((await viewer.call('GET', `${P()}/applications`)).status).toBe(403);
		// An assessor can't edit it.
		expect((await assessor.call('PATCH', `${P()}/scenarios/${sid}`, { name: 'Renamed' })).status).toBe(403);
	});

	it('is decided by an assessor, never by its applicant, and viewers then read it', async () => {
		expect((await asA('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(403);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'maybe' })).status).toBe(400);
		// The old words are gone from the API (163).
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'approved' })).status).toBe(400);
		// The authority's date and the reasons flag are part of the record.
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { outcome: 'licence_issued', authority: 'X' })).status).toBe(400);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', decisionDate: '2999-01-01' })).status).toBe(400);
		// An owner who doesn't act for the authority can't (163; the assessor, marked, can: below).
		expect((await owner.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(403);
		const res = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued', note: 'Releases of 5 % in dry months.' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario).toMatchObject({
			status: 'decided',
			outcome: 'licence_issued',
			decisionNote: 'Releases of 5 % in dry months.',
			decidedBy: 'Assessor',
			decisionAuthority: DECISION.authority,
			decisionDate: DECISION.decisionDate,
			decisionReference: DECISION.reference,
			reasonsReceived: true
		});
		// Final: no second decision, no withdrawal, no delete.
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_refused' })).status).toBe(409);
		expect((await asA('POST', `${P()}/scenarios/${sid}/withdraw`)).status).toBe(409);
		expect((await asA('DELETE', `${P()}/scenarios/${sid}`)).status).toBe(409);
		// Viewers read a decided application (control above: not before).
		expect((await viewer.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(200);
		const kinds = (await asOwner(`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND subject->>'scenarioId' = $2 AND kind LIKE 'scenario.%' ORDER BY id`, [projectId, sid])).map(
			(e: { kind: string; subject: { name?: string } }) => [e.kind, e.subject.name ?? null]
		);
		expect(kinds).toEqual([
			['scenario.created', null],
			['scenario.shared', null],
			['scenario.unshared', null],
			['scenario.shared', null],
			['scenario.changed', null],
			['scenario.changed', null],
			// The notice's objection details (166).
			['scenario.changed', null],
			['scenario.submitted', null],
			['scenario.decided', 'Raise Rooikloof']
		]);
	});
});

describe('withdraw, reopen and delete', () => {
	it('lets the owner withdraw, reopen and delete, which takes the draft runs with it', async () => {
		const sid = await apply(applicantB, 'Pump from the river', []);
		const run = await applicantB.call('POST', `${P()}/scenarios/${sid}/runs`, {});
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		expect((await applicantB.call('POST', `${P()}/scenarios/${sid}/submit`)).body.scenario.status).toBe('submitted');
		expect((await applicantB.call('POST', `${P()}/scenarios/${sid}/withdraw`)).body.scenario.status).toBe('withdrawn');
		// A decision racing the withdrawal: RLS filters the assessor's UPDATE to no
		// row, silently (why the route's move() checks the count and answers 409).
		const raced = await withUser(assessor.id, (db) => db.query(`UPDATE scenario SET status = 'decided', outcome = 'licence_issued' WHERE id = $1`, [sid]));
		expect(raced.rowCount).toBe(0);
		expect((await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(409);
		expect((await asOwner('SELECT status FROM scenario WHERE id = $1', [sid]))[0].status).toBe('withdrawn');
		expect((await applicantB.call('POST', `${P()}/scenarios/${sid}/reopen`)).body.scenario).toMatchObject({ status: 'draft', submittedAt: null });
		// Hidden again from the assessor once a draft.
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		expect((await applicantB.call('DELETE', `${P()}/scenarios/${sid}`)).status).toBe(204);
		// Its run went with it (not left behind, visible to every viewer with scenario_id cleared).
		expect(await asOwner('SELECT id FROM model_run WHERE id = $1', [run.body.run.id])).toEqual([]);
	});

	it('keeps an application to its newest runs, as its owner', async () => {
		const sid = await apply(applicantB, 'Many runs', []);
		const ids: string[] = [];
		for (let i = 0; i < 7; i++) ids.push((await applicantB.call('POST', `${P()}/scenarios/${sid}/runs`, {})).body.run.id);
		const left = await asOwner('SELECT id FROM model_run WHERE scenario_id = $1 ORDER BY created_at DESC, id DESC', [sid]);
		expect(left).toHaveLength(5);
		expect(ids.slice(-1)[0]).toBe(left[0].id);
		// Nobody but the owner trims (app_trim_application_runs, 046): another
		// contributor, an assessor and the project owner delete nothing.
		for (const u of [applicantA, assessor, owner]) {
			expect(await rowsAs(u, 'SELECT app_trim_application_runs($1, $2, 0)', [projectId, sid]), u.email).toEqual([]);
		}
		expect(await asOwner('SELECT id FROM model_run WHERE scenario_id = $1', [sid])).toHaveLength(5);
		// Positive control: the owner can, down to what they ask to keep.
		expect(await rowsAs(applicantB, 'SELECT app_trim_application_runs($1, $2, 4)', [projectId, sid])).toHaveLength(1);
		expect(await asOwner('SELECT id FROM model_run WHERE scenario_id = $1', [sid])).toHaveLength(4);
	});
});

describe('roles', () => {
	it('lets a contributor linked to a farm read that farm’s publication row (control: one without a link can’t)', async () => {
		expect(await rowsAs(applicantA, 'SELECT node_id FROM publication_farm')).toEqual([{ node_id: rooikloof.id }]);
		expect(await rowsAs(applicantB, 'SELECT node_id FROM publication_farm')).toEqual([]);
		// And their farm view, as a farmer's.
		expect((await applicantA.call('GET', `${P()}/farm`)).body.farms).toEqual([{ nodeId: rooikloof.id, name: 'Rooikloof' }]);
	});

	it('gives a team member who is also a contributor the editor view (app_project_role takes the max)', async () => {
		const mine = (await teamApplicant.call('GET', '/projects')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(mine.role).toBe('editor');
		expect((await teamApplicant.call('GET', `${P()}/model`)).status).toBe(200);
		// …so a scenario they make is a team scenario, not an application.
		const res = await teamApplicant.call('POST', `${P()}/scenarios`, { name: 'Team member idea', baseRunId: published });
		expect(res.body.scenario.origin).toBe('team');
	});

	it('lets an owner give and change the contributor role', async () => {
		const u = await signUp('Latecomer');
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role: 'contributor' })).body.invite.role).toBe('contributor');
		// A member once they accepted (helpers.ts signUp accepts at once).
		expect(await asOwner('SELECT role::text AS role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, u.id])).toEqual([{ role: 'contributor' }]);
		expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { role: 'viewer' })).body.member.role).toBe('viewer');
	});

	it('keeps viewers from making scenarios (control: a contributor and an editor can)', async () => {
		expect((await viewer.call('POST', `${P()}/scenarios`, { name: 'Viewer idea', baseRunId: published })).status).toBe(403);
	});
});

// Which routes admit a contributor (and that every other one refuses them at
// the role check, with a request its validation accepts, and an unknown id
// answers 404) is swept in projects/role-ladder.db.test.ts (BELOW_VIEWER).
describe('project routes for a contributor', () => {
	it('answers a contributor’s alert-events with no event', async () => {
		expect(await applicantB.call('GET', `/projects/${projectId}/alert-events`)).toEqual({ status: 200, body: { events: [] } });
	});
});
