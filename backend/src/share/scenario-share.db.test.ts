// Share links to one scenario, and comments on it (roadmap WP-3.15, issue
// #71; 113_scenario_share_notes.sql; docs/security.md § Share links, § Notes;
// docs/data-model.md § Notes). An NGO opens a submitted application's link
// signed out, and comments as a viewer; the assessors see it. Every "cannot"
// has its positive control (CLAUDE.md rule 5):
//
//   - who makes, lists and revokes a scenario link;
//   - a link opens its own scenario only (not another, not the catchment),
//     and a catchment link opens no scenario;
//   - revoked, expired, withdrawn: no answer, with a live token as control;
//   - the public answer is redacted (no other farm, member, e-mail,
//     allocation holder), and hides results a server stamp doesn't cover;
//   - the note visibility matrix on a scenario, reads and writes, per role;
//   - every edit of a scenario note keeps the text it replaced.
import { blankEwrRuleTable } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor
let ngo: User; // viewer
let applicantA: User; // contributor, linked to Rooikloof
let consultant: User; // contributor, one of A's parties (scenario_member)
let applicantB: User; // contributor, another application
let farmer: User;
let projectId: string;
let published: string;
let appA: string;
let appB: string;

const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
const others = ['Kalkoenkrans', 'Bergvliet', 'Doornhoek', 'Waterval'].map((n) => node(n, outlet.id));
const OTHER_FARMS = others.map((n) => n.name);
const HOLDER = 'Secret Holder Pty';
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };

const P = () => `/projects/${projectId}`;
const damRaise = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;
const openScenario = (token: string) => anon('POST', '/share/scenario', { token });
const link = (u: User, scenarioId: string, label = 'Forum') =>
	u.call('POST', `${P()}/share-links`, { label, expiresInDays: 30, targetKind: 'scenario', targetId: scenarioId });
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);

async function application(u: User, name: string, nodeId: string) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops: [damRaise(nodeId, 150_000)] });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await u.call('POST', `${P()}/scenarios/${sid}/runs`, {})).status).toBe(201);
	return sid;
}

beforeAll(async () => {
	[owner, assessor, ngo, applicantA, consultant, applicantB, farmer] = (await Promise.all(
		['Showner', 'Shassessor', 'Shngo', 'Shapplicanta', 'Shconsultant', 'Shapplicantb', 'Shfarmer'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Shared applications' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, ...others],
		crops: [citrus],
		cropAreas: [rooikloof, ...others].map((n, i) => ({ nodeId: n.id, cropId: citrus.id, areaM2: 40_000 + 10_000 * i })),
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	const table = { ...blankEwrRuleTable(null), source: 'Invented study' };
	table.ewr = table.ewr.map((row) => row.map(() => 0.01));
	const settings = await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(3000), ewrRules: [table] } });
	expect(settings.status, JSON.stringify(settings.body)).toBe(200);
	const days = 400;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : i % 3 === 0 ? 2 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-10-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[ngo, 'viewer'],
		[applicantA, 'contributor'],
		[consultant, 'contributor'],
		[applicantB, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [others[0]!.id] })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	for (const u of [applicantA, consultant]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
	expect((await owner.call('POST', `${P()}/allocations`, { nodeId: others[1]!.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000, holder: HOLDER })).status).toBe(201);

	appA = await application(applicantA, 'Raise Rooikloof', rooikloof.id);
	expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/members`, { userId: consultant.id })).status).toBe(201);
	appB = await application(applicantB, 'Other proposal', rooikloof.id);
}, 120_000);

describe('making a scenario link', () => {
	it('refuses a draft (409): it is still changing', async () => {
		expect((await link(applicantA, appA)).status).toBe(409);
	});

	it('lets the applicant and an assessor link a submitted application; not its other party, a viewer, another applicant or a farmer', async () => {
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/submit`)).status).toBe(200);
		const own = await link(applicantA, appA, 'For the forum');
		expect(own.status, JSON.stringify(own.body)).toBe(201);
		expect(own.body.link).toMatchObject({ targetKind: 'scenario', targetId: appA, mine: true, label: 'For the forum' });
		expect(own.body.link.url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}&k=scenario$/);
		expect((await link(assessor, appA, 'Assessor copy')).status).toBe(201);
		expect((await link(owner, appA, 'Owner copy')).status).toBe(201);
		// The consultant reads it but may not publish it; the others can't read it at all.
		expect((await link(consultant, appA)).status).toBe(403);
		expect((await link(ngo, appA)).status).toBe(404);
		expect((await link(applicantB, appA)).status).toBe(404);
		expect((await link(farmer, appA)).status).toBe(403);
		// The same in the database, past the route (share_link_insert).
		const hash = Buffer.alloc(32, 7);
		await expect(
			rowsAs(consultant, `INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, now() + interval '1 day', 'scenario', $3)`, [
				projectId,
				hash,
				appA
			])
		).rejects.toThrow(/row-level security/);
		// A baseline link is still the owner's alone.
		expect((await assessor.call('POST', `${P()}/share-links`, { label: 'x', expiresInDays: 1 })).status).toBe(403);
	});

	it("refuses another project's scenario as a target, in the database too", async () => {
		const other = (await owner.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id as string;
		await expect(
			asOwner(`INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, now() + interval '1 day', 'scenario', $3)`, [
				other,
				Buffer.alloc(32, 9),
				appA
			])
		).rejects.toThrow(/different project/);
		await expect(
			asOwner(`INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind) VALUES ($1, 'x', $2, now() + interval '1 day', 'scenario')`, [other, Buffer.alloc(32, 8)])
		).rejects.toThrow(/share_link_target_both/);
	});

	it("lists a scenario's links: every one to the assessors, only their own to the applicant; the baseline list stays baseline links", async () => {
		const byAssessor = await assessor.call('GET', `${P()}/share-links?scenarioId=${appA}`);
		expect(byAssessor.body.links.map((l: { label: string }) => l.label).sort()).toEqual(['Assessor copy', 'For the forum', 'Owner copy']);
		const byA = await applicantA.call('GET', `${P()}/share-links?scenarioId=${appA}`);
		expect(byA.body.links.map((l: { label: string }) => l.label)).toEqual(['For the forum']);
		expect((await consultant.call('GET', `${P()}/share-links?scenarioId=${appA}`)).body.links).toEqual([]);
		expect((await ngo.call('GET', `${P()}/share-links?scenarioId=${appA}`)).status).toBe(404);
		expect((await owner.call('GET', `${P()}/share-links`)).body.links).toEqual([]);
	});
});

describe('opening a scenario link', () => {
	let tokenA: string;
	let tokenB: string;
	let catchmentToken: string;

	beforeAll(async () => {
		tokenA = tokenOf((await link(assessor, appA, 'Open A')).body.link.url);
		expect((await applicantB.call('POST', `${P()}/scenarios/${appB}/submit`)).status).toBe(200);
		tokenB = tokenOf((await link(applicantB, appB, 'Open B')).body.link.url);
		catchmentToken = tokenOf((await owner.call('POST', `${P()}/share-links`, { label: 'Baseline', expiresInDays: 30 })).body.link.url);
	});

	it('shows its own scenario, the EWR per site first, and nothing that names another farm, a member or a holder', async () => {
		expect((await ngo.call('POST', `${P()}/notes`, { body: 'The river needs this water.', scenarioId: appA, visibility: 'public_participation' })).status).toBe(201);
		expect((await applicantA.call('POST', `${P()}/notes`, { body: 'Private to the assessors', scenarioId: appA, visibility: 'assessors' })).status).toBe(201);
		const res = await openScenario(tokenA);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.project).toEqual({ id: projectId, name: 'Shared applications' });
		expect(res.body.scenario.id).toBe(appA);
		expect(res.body.scenario).toMatchObject({ name: 'Raise Rooikloof', status: 'submitted', origin: 'applicant', ownedNodeIds: [rooikloof.id], opNames: [{ id: rooikloof.id, name: 'Rooikloof' }] });
		expect(res.body.results).toBe('ready');
		expect(res.body.base.ewrSites).toHaveLength(1);
		expect(res.body.base.ewrSites[0]).toMatchObject({ name: null, isOutlet: true });
		expect(res.body.run.ewrSites[0].byMonth).toHaveLength(12);
		// Five farm holders: the catchment's volumes are shown (the k rule).
		expect(res.body.run.volumes.farms.count).toBe(5);
		expect(res.body.comments).toEqual([expect.objectContaining({ body: 'The river needs this water.', author: 'Shngo' })]);
		const text = JSON.stringify(res.body);
		for (const name of OTHER_FARMS) expect(text, name).not.toContain(name);
		for (const n of others) expect(text).not.toContain(n.id);
		for (const u of [owner, assessor, ngo, applicantA, consultant, applicantB, farmer]) expect(text).not.toContain(u.email);
		for (const who of ['Shconsultant', 'Shapplicanta', 'Shapplicantb', 'Shassessor', 'Showner']) expect(text, who).not.toContain(who);
		expect(text).not.toContain(HOLDER);
		expect(text).not.toContain('Private to the assessors');
		expect(text).not.toContain('Other proposal');
		expect(text).not.toMatch(/user_display|"members"|"email"/);
	});

	it("can't read another scenario, the catchment view or its series; a catchment link opens no scenario", async () => {
		const b = (await openScenario(tokenB)).body;
		expect(b.scenario.name).toBe('Other proposal');
		// B's change is to another unit (a baseline assumption): baseline minus application would be that
		// unit's figures, so no volumes, on either run (A's own-unit proposal shows them: the test above).
		expect(b.scenario.classified).toEqual(['baseline']);
		expect([b.run.volumes, b.base.volumes]).toEqual([null, null]);
		expect(b.run.ewrSites[0].deficitM3).toBeNull();
		expect((await openScenario(tokenA)).body.scenario.name).toBe('Raise Rooikloof');
		for (const t of [tokenA, tokenB]) {
			expect((await anon('POST', '/share/view', { token: t })).status).toBe(404);
			expect((await anon('POST', '/share/series', { token: t, key: 'ewr' })).status).toBe(404);
		}
		expect((await openScenario(catchmentToken)).status).toBe(404);
		// Positive control: the catchment link still opens the catchment, exactly as before.
		expect((await anon('POST', '/share/view', { token: catchmentToken })).status).toBe(200);
	});

	it('answers nothing once revoked or expired, and nothing while the application is withdrawn', async () => {
		const made = await link(applicantA, appA, 'To revoke');
		const token = tokenOf(made.body.link.url);
		expect((await openScenario(token)).status).toBe(200);
		expect((await applicantA.call('DELETE', `${P()}/share-links/${made.body.link.id}`)).status).toBe(204);
		expect((await openScenario(token)).status).toBe(404);
		// The consultant can't revoke A's link; the assessor can revoke any.
		const other = await link(applicantA, appA, 'Kept');
		expect((await consultant.call('DELETE', `${P()}/share-links/${other.body.link.id}`)).status).toBe(403);
		expect((await ngo.call('DELETE', `${P()}/share-links/${other.body.link.id}`)).status).toBe(403);
		const expiring = await link(assessor, appA, 'To expire');
		const expToken = tokenOf(expiring.body.link.url);
		await asOwner(`UPDATE share_link SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, [expiring.body.link.id]);
		expect((await openScenario(expToken)).status).toBe(404);
		// Control: a live link to the same scenario answers.
		expect((await openScenario(tokenA)).status).toBe(200);
		expect((await assessor.call('DELETE', `${P()}/share-links/${other.body.link.id}`)).status).toBe(204);
		// Withdrawn: dead until it is submitted again.
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/withdraw`)).status).toBe(200);
		expect((await openScenario(tokenA)).status).toBe(404);
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/reopen`)).status).toBe(200);
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/submit`)).status).toBe(200);
		expect((await openScenario(tokenA)).status).toBe(200);
	});

	it('shows no results when a run was not stored by the backend (its stamp no longer matches)', async () => {
		const [run] = await asOwner('SELECT id, summary FROM model_run WHERE scenario_id = $1 ORDER BY created_at DESC LIMIT 1', [appB]);
		await asOwner(`UPDATE model_run SET summary = jsonb_set(summary, '{catchment,ewrDaysNotMet}', '999') WHERE id = $1`, [run!.id]);
		try {
			const res = await openScenario(tokenB);
			expect(res.body).toMatchObject({ results: 'unverified', base: null, run: null });
			// Control: A's untouched runs verify.
			expect((await openScenario(tokenA)).body.results).toBe('ready');
		} finally {
			await asOwner('UPDATE model_run SET summary = $2 WHERE id = $1', [run!.id, run!.summary]);
		}
		expect((await openScenario(tokenB)).body.results).toBe('ready');
	});
});

describe('notes on a scenario', () => {
	const bodies = (res: { body: { notes: { body: string }[] } }) => res.body.notes.map((n) => n.body).sort();
	const listAs = (u: User, sid = appA) => u.call('GET', `${P()}/notes?scenarioId=${sid}`);

	it('reads each audience as the matrix says, each with a positive control', async () => {
		// team: assessor; assessors: applicant A; parties: the assessor; public: the NGO (already posted).
		expect((await assessor.call('POST', `${P()}/notes`, { body: 'Team only', scenarioId: appA, visibility: 'team' })).status).toBe(201);
		expect((await assessor.call('POST', `${P()}/notes`, { body: 'To the parties', scenarioId: appA, visibility: 'parties' })).status).toBe(201);
		const expected: [User, string[]][] = [
			[assessor, ['Private to the assessors', 'Team only', 'The river needs this water.', 'To the parties']],
			[owner, ['Private to the assessors', 'Team only', 'The river needs this water.', 'To the parties']],
			[applicantA, ['Private to the assessors', 'The river needs this water.', 'To the parties']],
			[consultant, ['The river needs this water.', 'To the parties']],
			[applicantB, ['The river needs this water.']],
			[ngo, ['The river needs this water.']],
			[farmer, []]
		];
		for (const [u, want] of expected) {
			const res = await listAs(u);
			expect(res.status, u.email).toBe(200);
			expect(bodies(res), u.email).toEqual(want);
		}
		// The same straight from the table (RLS), for the two narrowest audiences.
		expect(await rowsAs(consultant, `SELECT body FROM note WHERE scenario_id = $1 AND visibility = 'assessors'`, [appA])).toEqual([]);
		expect(await rowsAs(assessor, `SELECT body FROM note WHERE scenario_id = $1 AND visibility = 'assessors'`, [appA])).toEqual([{ body: 'Private to the assessors' }]);
	});

	it('writes each audience as the matrix says', async () => {
		const post = (u: User, visibility: string, sid = appA) => u.call('POST', `${P()}/notes`, { body: `${visibility} by ${u.email}`, scenarioId: sid, visibility });
		// The NGO: public participation only.
		expect((await post(ngo, 'parties')).status).toBe(403);
		expect((await post(ngo, 'assessors')).status).toBe(403);
		expect((await post(ngo, 'team')).status).toBe(403);
		// Another applicant: public participation only.
		expect((await post(applicantB, 'public_participation')).status).toBe(201);
		expect((await post(applicantB, 'parties')).status).toBe(403);
		// A's consultant: the parties, the assessors, public participation; not the team.
		for (const v of ['parties', 'assessors', 'public_participation']) expect((await post(consultant, v)).status, v).toBe(201);
		expect((await post(consultant, 'team')).status).toBe(403);
		// A farmer: nothing on a scenario.
		expect((await post(farmer, 'public_participation')).status).toBe(403);
		// A farm note needs a node, never a scenario.
		expect((await post(assessor, 'farm')).status).toBe(400);
		// The database refuses a participation audience without a scenario.
		await expect(asOwner(`INSERT INTO note (project_id, author_id, body, visibility) VALUES ($1, $2, 'x', 'parties')`, [projectId, assessor.id])).rejects.toThrow(
			/note_participation_on_scenario/
		);
	});

	it('opens public comment only with a live link or a decision', async () => {
		const appC = await application(applicantB, 'Third proposal', rooikloof.id);
		expect((await applicantB.call('POST', `${P()}/scenarios/${appC}/submit`)).status).toBe(200);
		const post = (u: User) => u.call('POST', `${P()}/notes`, { body: 'An objection', scenarioId: appC, visibility: 'public_participation' });
		expect((await post(ngo)).status).toBe(404);
		const made = await link(assessor, appC, 'Comment period');
		expect((await post(ngo)).status).toBe(201);
		expect(bodies(await listAs(ngo, appC))).toEqual(['An objection']);
		expect((await assessor.call('DELETE', `${P()}/share-links/${made.body.link.id}`)).status).toBe(204);
		// Closed again: the NGO still reads their own comment, but posts no more.
		expect((await post(ngo)).status).toBe(404);
		expect(bodies(await listAs(ngo, appC))).toEqual(['An objection']);
		expect(bodies(await listAs(applicantA, appC))).toEqual([]);
	});

	it('keeps the text each edit replaced, readable as the note is', async () => {
		const made = await applicantA.call('POST', `${P()}/notes`, { body: 'First words', scenarioId: appA, visibility: 'parties' });
		const id = made.body.note.id as string;
		expect((await applicantA.call('PATCH', `${P()}/notes/${id}`, { body: 'Second words' })).status).toBe(200);
		const edited = await applicantA.call('PATCH', `${P()}/notes/${id}`, { body: 'Third words' });
		expect(edited.body.note.editedAt).not.toBeNull();
		for (const u of [applicantA, consultant, assessor]) {
			const res = await u.call('GET', `${P()}/notes/${id}/revisions`);
			expect(res.status, u.email).toBe(200);
			expect(res.body.note.body).toBe('Third words');
			expect(res.body.revisions.map((r: { body: string }) => r.body)).toEqual(['First words', 'Second words']);
		}
		for (const u of [ngo, applicantB, farmer]) expect((await u.call('GET', `${P()}/notes/${id}/revisions`)).status, u.email).toBe(404);
		// The author's own earlier words are in their data export (POPIA s23), under the note.
		const exported = (await applicantA.call('GET', '/auth/me/export')).body.notes.find((n: { id: string }) => n.id === id);
		expect(exported).toMatchObject({ scenarioId: appA, body: 'Third words' });
		expect(exported.revisions.map((r: { body: string }) => r.body)).toEqual(['First words', 'Second words']);
		expect(await rowsAs(applicantB, 'SELECT body FROM note_revision WHERE note_id = $1', [id])).toEqual([]);
		// water_app never writes one itself.
		await expect(
			rowsAs(applicantA, `INSERT INTO note_revision (note_id, project_id, body, written_at) VALUES ($1, $2, 'forged', now())`, [id, projectId])
		).rejects.toThrow(/permission denied/);
		// A note on anything else keeps no history (WP-2.7, unchanged).
		const plain = await owner.call('POST', `${P()}/notes`, { body: 'Project note' });
		expect((await owner.call('PATCH', `${P()}/notes/${plain.body.note.id}`, { body: 'Project note, edited' })).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM note_revision WHERE note_id = $1', [plain.body.note.id])).toEqual([]);
	});

	it('lets an assessor hide a public comment, which leaves the shared view', async () => {
		const token = tokenOf((await link(assessor, appA, 'Moderation')).body.link.url);
		const posted = await ngo.call('POST', `${P()}/notes`, { body: 'Abusive words', scenarioId: appA, visibility: 'public_participation' });
		expect((await openScenario(token)).body.comments.map((c: { body: string }) => c.body)).toContain('Abusive words');
		expect((await assessor.call('DELETE', `${P()}/notes/${posted.body.note.id}`)).status).toBe(204);
		expect((await openScenario(token)).body.comments.map((c: { body: string }) => c.body)).not.toContain('Abusive words');
		// Counts carry the scenario's notes for the drawer's badge.
		expect((await assessor.call('GET', `${P()}/notes/counts`)).body.scenarios[appA]).toBeGreaterThan(0);
	});
});

describe('keeping the record', () => {
	it('refuses to delete a withdrawn application that drew public comments', async () => {
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/withdraw`)).status).toBe(200);
		const del = await applicantA.call('DELETE', `${P()}/scenarios/${appA}`);
		expect(del.status, JSON.stringify(del.body)).toBe(409);
		expect(del.body.error).toMatch(/public comments/);
		// The trigger holds without the route.
		await expect(rowsAs(applicantA, 'DELETE FROM scenario WHERE id = $1', [appA])).rejects.toThrow(/public comments/);
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/reopen`)).status).toBe(200);
		expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/submit`)).status).toBe(200);
		// Control: an application nobody commented on is deleted as before.
		const bare = (await applicantB.call('POST', `${P()}/scenarios`, { name: 'Bare draft', baseRunId: published, ops: [] })).body.scenario.id as string;
		expect((await applicantB.call('DELETE', `${P()}/scenarios/${bare}`)).status).toBe(204);
	});
});

describe('a small catchment', () => {
	it('never links a team scenario, and shows an application its EWR days but no volumes under 5 farm holders', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Two farms' })).body.project.id as string;
		const out = node('Weir', null);
		const f1 = node('Tiny A', out.id);
		const f2 = node('Tiny B', out.id);
		const crop = { ...citrus, id: crypto.randomUUID() };
		const put = await owner.call('PUT', `/projects/${pid}/model`, {
			nodes: [out, f1, f2],
			crops: [crop],
			cropAreas: [{ nodeId: f1.id, cropId: crop.id, areaM2: 50_000 }],
			transfers: []
		});
		expect(put.status, JSON.stringify(put.body)).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(3000) } })).status).toBe(200);
		const rain = Array.from({ length: 120 }, (_, i) => (i % 7 === 0 ? 20 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-10-01', values: rain })).status).toBe(200);
		const base = (await owner.call('POST', `/projects/${pid}/runs`, { label: 'Base' })).body.run.id as string;
		expect((await owner.call('POST', `/projects/${pid}/publication`, { runId: base })).status).toBe(201);
		const makeLink = (sid: string) => owner.call('POST', `/projects/${pid}/share-links`, { label: 'x', expiresInDays: 3, targetKind: 'scenario', targetId: sid });

		// A team scenario names every farm by id with its values: refused, in the database too.
		const team = (await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'Team idea', baseRunId: base, ops: [damRaise(f2.id, 1000)] })).body.scenario.id as string;
		expect((await owner.call('POST', `/projects/${pid}/scenarios/${team}/submit`)).status).toBe(200);
		expect((await makeLink(team)).status).toBe(409);
		await expect(
			rowsAs(owner, `INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, now() + interval '1 day', 'scenario', $3)`, [
				pid,
				Buffer.alloc(32, 5),
				team
			])
		).rejects.toThrow(/row-level security/);

		// Positive control: an application in the same catchment is linked.
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: applicantB.email, role: 'contributor' })).status).toBe(201);
		expect((await owner.call('PUT', `/projects/${pid}/farmers/${applicantB.id}`, { nodeIds: [f1.id] })).status).toBe(200);
		const made = await applicantB.call('POST', `/projects/${pid}/scenarios`, { name: 'Tiny raise', baseRunId: base, ops: [damRaise(f1.id, 1000)] });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const sid = made.body.scenario.id as string;
		expect((await applicantB.call('POST', `/projects/${pid}/scenarios/${sid}/runs`, {})).status).toBe(201);
		expect((await applicantB.call('POST', `/projects/${pid}/scenarios/${sid}/submit`)).status).toBe(200);
		const linked = await makeLink(sid);
		expect(linked.status, JSON.stringify(linked.body)).toBe(201);
		const res = await openScenario(tokenOf(linked.body.link.url));
		expect(res.body.results).toBe('ready');
		expect(res.body.run.volumes).toBeNull();
		expect(res.body.base.volumes).toBeNull();
		expect(typeof res.body.run.ewrDaysNotMet).toBe('number');
		// Its own unit is named; the other isn't.
		expect(JSON.stringify(res.body)).toContain('Tiny A');
		expect(JSON.stringify(res.body)).not.toContain('Tiny B');
	});
});
