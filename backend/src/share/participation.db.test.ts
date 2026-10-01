// Public participation without a project role (166_public_participation;
// licensing positions item 7, build items 9–11, provisional position,
// pre-counsel research, 2026-10-01; docs/scenarios.md § Sharing and
// comments, docs/security.md § Share links → Link participants). Every
// "cannot" has its positive control (CLAUDE.md rule 5):
//
//   - where objections go: an application's notice details, set while it is
//     a draft, frozen once submitted (route and database), never on a team
//     scenario; shown on the application's and its pack's share pages;
//   - link participants: any signed-in account comments through a live link
//     to a submitted application or an issued pack, with no project role;
//     never signed out, never through a revoked, baseline or draft link;
//     they read nothing of the project; water_app never stamps a link on a
//     note; 10 an hour per account;
//   - the register opt-in: on public comments only;
//   - the reg 19 export: the application's owner and the editors; the email
//     only where the commenter agreed; a removed comment's words for the
//     editors only; never another contributor or a viewer; audited;
//   - the commenter's own data export says how each comment was posted.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, node, signUp } from '../__tests__/helpers.js';
import { newToken } from '../auth/tokens.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let owner: User;
let assessor: User; // editor
let viewer: User;
let applicant: User; // contributor, owns the application
let otherApplicant: User; // contributor
let ngo: User; // no role in the project
let busy: User; // no role, the throttle's
let projectId: string;
let app1: string; // submitted
let draftApp: string; // a draft
let pack: string; // issued, of app1
let scenarioToken: string;
let packToken: string;
let draftToken: string;
let revokedToken: string;
let baselineToken: string;

const outlet = node('Rooikloof', null);
const P = () => `/projects/${projectId}`;
const comment = (u: User | null, token: string, body: string, registerConsent = false) =>
	u ? u.call('POST', '/share/comment', { token, body, registerConsent }) : anon('POST', '/share/comment', { token, body, registerConsent });
const ADDRESS = 'The Catchment Manager, Private Bag X1, Rooikloof';

async function arrange<T>(fn: (q: Q) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	[owner, assessor, viewer, applicant, otherApplicant, ngo, busy] = (await Promise.all(
		['Ppowner', 'Ppassessor', 'Ppviewer', 'Ppapplicant', 'Ppother', 'Ppngo', 'Ppbusy'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Participation' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[otherApplicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	const tokens = [newToken(), newToken(), newToken(), newToken(), newToken()];
	[scenarioToken, packToken, draftToken, revokedToken, baselineToken] = tokens.map((t) => t.token) as [string, string, string, string, string];
	await arrange(async (q) => {
		const [run] = await q(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`,
			[projectId, owner.id]
		);
		const plant = async (name: string, status: string) =>
			(
				await q(
					`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at, owned_node_ids, objection_address, objection_closing_date)
					 VALUES ($1, $2, $3, repeat('a', 64), $4, 'applicant', $5, CASE WHEN $5 = 'submitted' THEN now() END, '{}', $6, $7) RETURNING id::text`,
					[projectId, name, run!.id, applicant.id, status, status === 'submitted' ? ADDRESS : null, status === 'submitted' ? '2026-12-01' : null]
				)
			)[0]!.id as string;
		app1 = await plant('Raise the weir dam', 'submitted');
		draftApp = await plant('Still a draft', 'draft');
		const [appRun] = await q(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}', $3) RETURNING id::text`,
			[projectId, owner.id, app1]
		);
		pack = randomUUID();
		await q(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, scenario_id, scenario_run_id, status, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
			 VALUES ($1, $2, $3, 1, $4, $5, 'issued', '{"report":{}}', repeat('b', 64), 'evidence-8', '1.50.0', $6, now(), $6)`,
			[pack, projectId, run!.id, app1, appRun!.id, assessor.id]
		);
		const link = (i: number, kind: string | null, target: string | null, revoked = false) =>
			q(
				`INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id, created_by, revoked_at)
				 VALUES ($1, 'Forum', $2, now() + interval '30 days', $3, $4, $5, CASE WHEN $6 THEN now() END)`,
				[projectId, tokens[i]!.hash, kind, target, owner.id, revoked]
			);
		await link(0, 'scenario', app1);
		await link(1, 'pack', pack);
		await link(2, 'scenario', draftApp);
		await link(3, 'scenario', app1, true);
		await link(4, null, null);
	});
}, 120_000);

describe('where written objections go', () => {
	it('are set while a draft (scenarios/applications.db.test.ts sets them through the route) and frozen once submitted, in the route and the database', async () => {
		// Control: a draft's change goes through in the database.
		await withUser(applicant.id, (db) => db.query(`UPDATE scenario SET objection_address = 'The EAP, PO Box 1', objection_closing_date = '2026-11-30' WHERE id = $1`, [draftApp]));
		expect(await asOwner('SELECT objection_address FROM scenario WHERE id = $1', [draftApp])).toEqual([{ objection_address: 'The EAP, PO Box 1' }]);
		expect((await applicant.call('PATCH', `${P()}/scenarios/${draftApp}`, { objectionClosingDate: '2026-02-30' })).status).toBe(400);
		expect((await applicant.call('PATCH', `${P()}/scenarios/${app1}`, { objectionAddress: 'Elsewhere' })).status).toBe(409);
		await expect(withUser(applicant.id, (db) => db.query(`UPDATE scenario SET objection_address = 'Elsewhere' WHERE id = $1`, [app1]))).rejects.toMatchObject({
			code: '23514'
		});
		// Never on a team scenario (the CHECK, past every trigger).
		await expect(
			arrange((q) =>
				q(
					`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, owned_node_ids, objection_address)
					 SELECT project_id, 'Team', base_run_id, ops_sha256, $2, 'team', 'draft', '{}', 'x' FROM scenario WHERE id = $1`,
					[draftApp, owner.id]
				)
			)
		).rejects.toMatchObject({ code: '23514' });
	});

	it('the application’s and its pack’s share pages print them', async () => {
		expect((await anon('POST', '/share/scenario', { token: scenarioToken })).body.objection).toEqual({ address: ADDRESS, closingDate: '2026-12-01' });
		expect((await anon('POST', '/share/pack', { token: packToken })).body.objection).toEqual({ address: ADDRESS, closingDate: '2026-12-01' });
	});
});

describe('link participants', () => {
	it('any signed-in account comments through a live link, with no project role; never signed out', async () => {
		expect((await comment(null, scenarioToken, 'Signed out')).status).toBe(401);
		const r = await comment(ngo, scenarioToken, 'The river needs this water.', true);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.comment).toMatchObject({ body: 'The river needs this water.', author: 'Ppngo' });
		expect((await anon('POST', '/share/scenario', { token: scenarioToken })).body.comments).toEqual([expect.objectContaining({ body: 'The river needs this water.', author: 'Ppngo' })]);
		const [row] = await asOwner('SELECT visibility, share_link_id IS NOT NULL AS linked, register_consent, scenario_id::text FROM note WHERE author_id = $1', [ngo.id]);
		expect(row).toEqual({ visibility: 'public_participation', linked: true, register_consent: true, scenario_id: app1 });
		// Through the pack's link too (control for the pack target).
		expect((await comment(ngo, packToken, 'And on the evidence.')).status).toBe(201);
		expect((await anon('POST', '/share/pack', { token: packToken })).body.comments).toEqual([expect.objectContaining({ body: 'And on the evidence.' })]);
	});

	it('refuses a revoked, a baseline and a draft application’s link alike (404), and a malformed body (400)', async () => {
		for (const t of [revokedToken, baselineToken, draftToken, 'not-a-token']) expect((await comment(ngo, t, 'x')).status, t).toBe(404);
		expect((await comment(ngo, scenarioToken, '   ')).status).toBe(400);
		expect((await comment(ngo, scenarioToken, 'x'.repeat(4001))).status).toBe(400);
	});

	it('reads nothing of the project (control: a member reads the notes)', async () => {
		expect((await ngo.call('GET', `${P()}/notes?scenarioId=${app1}`)).status).toBe(404);
		expect((await ngo.call('GET', `${P()}/scenarios/${app1}`)).status).toBe(404);
		expect(await withUser(ngo.id, async (db) => (await db.query('SELECT id FROM note WHERE project_id = $1', [projectId])).rows)).toEqual([]);
		// The members read the link comment with its author's name, as the link shows it (control for "a former member").
		const seen = (await assessor.call('GET', `${P()}/notes?scenarioId=${app1}`)).body.notes as { body: string; author: string | null }[];
		expect(seen.find((n) => n.body === 'The river needs this water.')?.author).toBe('Ppngo');
		const [n] = await asOwner(`SELECT id FROM note WHERE author_id = $1 AND body = 'The river needs this water.'`, [ngo.id]);
		const nameAs = async (u: User) => (await withUser(u.id, (db) => db.query<{ a: string | null }>('SELECT app_link_comment_author($1) AS a', [n!.id]))).rows[0]!.a;
		// Never to someone outside the project (control: a member gets it).
		expect(await nameAs(busy)).toBeNull();
		expect(await nameAs(viewer)).toBe('Ppngo');
	});

	it('water_app never names a share link on a note; only app_share_comment does', async () => {
		const [link] = await asOwner('SELECT id FROM share_link WHERE target_id = $1 AND revoked_at IS NULL LIMIT 1', [app1]);
		await expect(
			withUser(applicant.id, (db) =>
				db.query(`INSERT INTO note (project_id, author_id, body, scenario_id, visibility, share_link_id) VALUES ($1, app_current_user_id(), 'x', $2, 'public_participation', $3)`, [
					projectId,
					app1,
					link!.id
				])
			)
		).rejects.toThrow(/row-level security/);
	});

	it('10 an hour per account: the 11th answers 429 comment_throttled (control: another account still posts)', async () => {
		for (let i = 0; i < 10; i++) expect((await comment(busy, scenarioToken, `Comment ${i}`)).status).toBe(201);
		const r = await comment(busy, scenarioToken, 'One too many');
		expect(r).toMatchObject({ status: 429, body: { code: 'comment_throttled' } });
		expect(Number(r.body.params.seconds)).toBeGreaterThan(0);
		expect((await comment(ngo, scenarioToken, 'Still welcome')).status).toBe(201);
	});

	it('the register opt-in is only for a public comment', async () => {
		expect((await assessor.call('POST', `${P()}/notes`, { body: 'Team', registerConsent: true })).status).toBe(400);
		expect((await applicant.call('POST', `${P()}/notes`, { body: 'Mine', scenarioId: app1, visibility: 'parties', registerConsent: true })).status).toBe(400);
	});
});

describe('the reg 19 export', () => {
	const exp = (u: User, sid = app1, q = '') => u.call('GET', `${P()}/scenarios/${sid}/participation-export${q}`);

	it('the application’s owner gets every public comment, the email only where the commenter agreed', async () => {
		const r = await exp(applicant);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.application).toMatchObject({ id: app1, objectionAddress: ADDRESS, objectionClosingDate: '2026-12-01' });
		const byBody = new Map((r.body.comments as { body: string; email: string | null; viaLink: boolean; target: string }[]).map((c) => [c.body, c]));
		expect(byBody.get('The river needs this water.')).toMatchObject({ email: ngo.email, viaLink: true, target: 'application' });
		expect(byBody.get('And on the evidence.')).toMatchObject({ email: null, target: 'pack', packVersion: 1 });
		expect(r.body.register).toEqual([{ name: 'Ppngo', email: ngo.email }]);
		// How it was put out for comment: the live and the revoked application link, and the pack's.
		expect(r.body.links.map((l: { target: string; revokedAt: string | null }) => [l.target, l.revokedAt !== null]).sort()).toEqual([
			['application', false],
			['application', true],
			['pack', false]
		]);
		// Never a token.
		expect(JSON.stringify(r.body)).not.toContain(scenarioToken);
		expect(await asOwner(`SELECT subject->>'emails' AS emails FROM audit_event WHERE project_id = $1 AND kind = 'scenario.participation_exported'`, [projectId])).toEqual([{ emails: '1' }]);
	});

	it('a CSV too, one row per text', async () => {
		const res = await app.request(`${P()}/scenarios/${app1}/participation-export?format=csv`, { headers: { cookie: applicant.cookie, origin: 'http://localhost:7777' } });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/text\/csv/);
		const text = await res.text();
		expect(text.split('\n')[0]).toMatch(/^comment_id,on,text_version/);
		expect(text).toContain(ngo.email);
	});

	it('the editors get it, a removed comment’s words with it; the owner gets the removal without the words', async () => {
		const [n] = await asOwner(`SELECT id FROM note WHERE author_id = $1 AND body = 'Still welcome'`, [ngo.id]);
		expect((await assessor.call('DELETE', `${P()}/notes/${n!.id}`)).status).toBe(204);
		const ed = (await exp(assessor)).body.comments.find((c: { id: string }) => c.id === n!.id);
		expect(ed).toMatchObject({ state: 'removed', body: 'Still welcome' });
		const own = (await exp(applicant)).body.comments.find((c: { id: string }) => c.id === n!.id);
		expect(own).toMatchObject({ state: 'removed', body: null });
	});

	it('never another contributor or a viewer (404), nor someone outside the project', async () => {
		expect((await exp(otherApplicant)).status).toBe(404);
		expect((await exp(viewer)).status).toBe(404);
		expect((await exp(ngo)).status).toBe(404);
		// Control: the owner's own draft application answers too (nothing on it yet).
		expect((await exp(applicant, draftApp)).body.comments).toEqual([]);
	});
});

describe('the commenter’s own data export', () => {
	it('lists their public comments with how each was posted and whether they agreed to the register', async () => {
		const r = await ngo.call('GET', '/auth/me/export');
		expect(r.status).toBe(200);
		expect(r.body.publicComments).toEqual(
			expect.arrayContaining([expect.objectContaining({ projectId, scenarioId: app1, viaLink: true, registerConsent: true }), expect.objectContaining({ packId: pack, viaLink: true })])
		);
	});
});
