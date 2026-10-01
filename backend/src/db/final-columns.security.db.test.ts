// "Final" columns stay final (docs/security.md § API keys). A column that
// records a one-way event (a key or link revoked, a publication superseded,
// a note deleted, a scenario decided, every session signed out) and that
// water_app may UPDATE is one statement away from being undone by the same
// grant that set it: an owner's transaction (an API bug, an injected query)
// could bring a revoked key back to life with the record of who revoked it
// gone. 065 closed that for share_link; 067 for api_key, run_publication
// and app_user.sessions_revoked_at.
//
// The sweep reads the live grants: every column water_app can UPDATE whose
// name says it is a one-way event must be claimed by a probe below, so a new
// such column fails this file until someone decides how it stays final. Each
// probe has a positive control (the forward move the API makes still works).
import { beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, anon, app, asOwner, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from './tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

// A column name that records a one-way event.
const FINAL_NAME = /(^|_)(revoked|superseded|consumed|used|deleted|decided|redeemed|withdrawn)(_at|_by)?$/;

// Every such column water_app may UPDATE → what keeps it final (the probe in
// this file that proves it).
const CLAIMED = new Map<string, string>([
	['api_key.revoked_at', '067 api_key_revoke_final (probe: api keys)'],
	['api_key.revoked_by', '067 api_key_revoke_final: only the foreign key clears it (probe: api keys)'],
	['share_link.revoked_at', '065 share_link_revoke_final (probe: share links; share.security.db.test.ts)'],
	['share_link.revoked_by', '065 share_link_revoke_final: only the foreign key clears it'],
	['run_publication.superseded_at', '067 run_publication_final: a superseded publication is history, frozen (probe: publications)'],
	['app_user.sessions_revoked_at', '067 app_user_sessions_watermark: the watermark only moves forward (probe: sessions)'],
	['note.deleted_at', '037/048 note_guard: a deleted note refuses every update (probe: notes)'],
	['note.deleted_by', '037/048 note_guard: set by the trigger, cleared only by the foreign key'],
	['scenario.decided_at', '045/052 scenario guard: decided is a terminal status, the decision never changes (probe: scenarios)'],
	['scenario.decided_by', '045/052 scenario guard, as decided_at']
]);

let owner: User;
let coOwner: User;
let projectId: string;
const outlet = node('Final Weir', null);
const farm = node('Farm Final', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(0.9) };

const CHECK = { code: '23514' };
/**
 * The owner's own transaction tries `sql`: refused means the guard raised
 * check_violation, or RLS left the row out of reach (no row updated). Either
 * way nothing changed; each probe then reads the row back to be sure.
 */
async function expectRefused(sql: string, params: unknown[]) {
	const res = await withUser(owner.id, (db) => db.query(sql, params)).catch((err: { code?: string }) => {
		expect(err, sql).toMatchObject(CHECK);
		return null;
	});
	if (res) expect(res.rowCount, `${sql} updated a final row`).toBe(0);
}

/** A run of the owner's (a run's creator can't be deleted), published by `by`. */
async function publish(by: User, notice: string) {
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: notice });
	expect(run.status).toBe(201);
	const res = await by.call('POST', `/projects/${projectId}/publication`, {
		runId: run.body.run.id,
		note: 'staff note',
		restriction: { level: 'advisory', pct: 10, notice: { en: notice } },
		nextExpectedOn: '2023-06-01'
	});
	expect(res.status).toBe(201);
	return { runId: run.body.run.id as string, pubId: res.body.publication.id as string };
}

beforeAll(async () => {
	[owner, coOwner] = (await Promise.all(['FCowner', 'FCcoowner'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Final catchment' })).body.project.id;
	expect(
		(
			await owner.call('PUT', `/projects/${projectId}/model`, {
				nodes: [outlet, farm],
				crops: [crop],
				cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }],
				transfers: []
			})
		).status
	).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBe(201);
	const values = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-01', values })).status).toBe(200);
}, 90_000);

describe('the sweep', () => {
	it('claims every one-way-event column water_app can update, and nothing that is gone', async () => {
		const rows = await asOwner(
			`SELECT table_name || '.' || column_name AS col FROM information_schema.column_privileges
			 WHERE grantee = 'water_app' AND privilege_type = 'UPDATE' AND table_schema = 'public' ORDER BY 1`
		);
		const all = rows.map((r) => r.col as string);
		// Positive control: the sweep reads real grants (065's own column is among them).
		expect(all).toContain('share_link.revoked_at');
		const finals = all.filter((c) => FINAL_NAME.test(c.split('.')[1]!));
		expect(finals.sort()).toEqual([...CLAIMED.keys()].sort());
	});

	it('names a guard trigger on every claimed table that the probes rely on', async () => {
		const rows = await asOwner(
			`SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			 WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND c.relnamespace = 'public'::regnamespace
			   AND (t.tgtype & 16) <> 0 AND (t.tgtype & 2) <> 0` // UPDATE, BEFORE
		);
		const byTable = new Map<string, string[]>();
		for (const r of rows) byTable.set(r.tbl, [...(byTable.get(r.tbl) ?? []), r.tgname]);
		for (const [tbl, trg] of [
			['api_key', 'api_key_revoke_final'],
			['share_link', 'share_link_revoke_final'],
			['run_publication', 'run_publication_final'],
			['app_user', 'app_user_sessions_watermark']
		] as const) {
			expect(byTable.get(tbl) ?? [], tbl).toContain(trg);
		}
	});
});

describe('api keys', () => {
	const newKey = async (name: string) => {
		const r = await owner.call('POST', `/projects/${projectId}/api-keys`, { name });
		expect(r.status).toBe(201);
		return { id: r.body.key.id as string, secret: r.body.secret as string };
	};
	/** The key's own check: 200 while live, 401 once revoked. */
	const push = async (secret: string) => (await app.request('/ingest/v1/whoami', { headers: { authorization: `Bearer ${secret}` } })).status;

	it('refuses to un-revoke a key or rewrite its revocation, even as an owner in SQL', async () => {
		const key = await newKey('Logger');
		// Positive control: a live key answers; revoking (the API's own path) stops it.
		expect(await push(key.secret)).toBe(200);
		expect((await owner.call('DELETE', `/projects/${projectId}/api-keys/${key.id}`)).status).toBe(204);
		expect(await push(key.secret)).toBe(401);
		for (const [sql, params] of [
			['UPDATE api_key SET revoked_at = NULL, revoked_by = NULL WHERE id = $1', [key.id]],
			['UPDATE api_key SET revoked_at = NULL WHERE id = $1', [key.id]],
			["UPDATE api_key SET revoked_at = revoked_at + interval '1 year' WHERE id = $1", [key.id]],
			['UPDATE api_key SET revoked_by = $2 WHERE id = $1', [key.id, coOwner.id]],
			// Only the foreign key clears it, for a deleted account; never for a live one.
			['UPDATE api_key SET revoked_by = NULL WHERE id = $1', [key.id]]
		] as const) {
			await expectRefused(sql, [...params]);
		}
		expect(await push(key.secret)).toBe(401);
		const [row] = await asOwner('SELECT revoked_by FROM api_key WHERE id = $1', [key.id]);
		expect(row.revoked_by).toBe(owner.id);
	});

	it('still clears who revoked it when that account is deleted, and the key stays revoked', async () => {
		const key = await newKey('Second logger');
		const gone = await signUp('FCgone');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: gone.email, role: 'owner' })).status).toBe(201);
		expect((await gone.call('DELETE', `/projects/${projectId}/api-keys/${key.id}`)).status).toBe(204);
		await asOwner('DELETE FROM app_user WHERE id = $1', [gone.id]);
		const [row] = await asOwner('SELECT revoked_at, revoked_by FROM api_key WHERE id = $1', [key.id]);
		expect(row.revoked_by).toBeNull();
		expect(row.revoked_at).not.toBeNull();
		expect(await push(key.secret)).toBe(401);
	});
});

describe('share links', () => {
	// share.security.db.test.ts has the un-revoke cases (065); this is 067's tightening.
	it('never clears who revoked a link while that account exists (positive control: the owner revokes)', async () => {
		const made = await owner.call('POST', `/projects/${projectId}/share-links`, { label: 'Final', expiresInDays: 30 });
		expect(made.status).toBe(201);
		const id = made.body.link.id as string;
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${id}`)).status).toBe(204);
		await expectRefused('UPDATE share_link SET revoked_by = NULL WHERE id = $1', [id]);
		const [row] = await asOwner('SELECT revoked_by FROM share_link WHERE id = $1', [id]);
		expect(row.revoked_by).toBe(owner.id);
	});
});

describe('publications', () => {
	let first: string;
	let second: string;

	beforeAll(async () => {
		first = (await publish(coOwner, 'First notice')).pubId;
		expect((await coOwner.call('PATCH', `/projects/${projectId}/publication/${first}`, { note: 'edited while current' })).status).toBe(200);
		second = (await publish(owner, 'Second notice')).pubId;
	}, 90_000);

	it('supersedes on publish, and the current one still takes a notice change (positive control)', async () => {
		const [old] = await asOwner('SELECT superseded_at FROM run_publication WHERE id = $1', [first]);
		expect(old.superseded_at).not.toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}/publication/${second}`, { note: 'current change' })).status).toBe(200);
	});

	it('refuses to bring back or rewrite a superseded publication, even as an editor in SQL', async () => {
		for (const sql of [
			"UPDATE run_publication SET notice = '{\"en\": \"rewritten history\"}' WHERE id = $1",
			"UPDATE run_publication SET superseded_at = superseded_at + interval '1 year' WHERE id = $1",
			"UPDATE run_publication SET restriction_level = 'none', restriction_pct = NULL WHERE id = $1"
		]) {
			await expectRefused(sql, [first]);
		}
		// Un-superseding needs the current one out of the way first (one current per
		// project): in one transaction, as a determined caller would.
		await expect(
			withUser(owner.id, async (db) => {
				await db.query('UPDATE run_publication SET superseded_at = now() WHERE id = $1', [second]);
				await db.query('UPDATE run_publication SET superseded_at = NULL WHERE id = $1', [first]);
			})
		).rejects.toMatchObject(CHECK);
		const [row] = await asOwner('SELECT notice, superseded_at FROM run_publication WHERE id = $1', [first]);
		expect(row).toMatchObject({ notice: { en: 'First notice' } });
		expect(row.superseded_at).not.toBeNull();
	});

	it('still clears who published or changed it when that account is deleted', async () => {
		await asOwner('DELETE FROM app_user WHERE id = $1', [coOwner.id]);
		const [row] = await asOwner('SELECT published_by, updated_by, superseded_at, note FROM run_publication WHERE id = $1', [first]);
		expect(row).toMatchObject({ published_by: null, updated_by: null, note: 'edited while current' });
		expect(row.superseded_at).not.toBeNull();
	});
});

describe('sessions', () => {
	it('never moves the sign-out-everywhere watermark back, so a signed-out session stays out', async () => {
		const u = await signUp('FCsessions');
		const stolen = u.cookie;
		// Positive control: the session works, and sign out everywhere ends it.
		expect((await anon('GET', '/auth/me', undefined, stolen)).status).toBe(200);
		expect((await u.call('POST', '/auth/logout-everywhere')).status).toBe(204);
		expect((await anon('GET', '/auth/me', undefined, stolen)).status).toBe(401);
		const [before] = await asOwner('SELECT sessions_revoked_at FROM app_user WHERE id = $1', [u.id]);
		for (const sql of [
			'UPDATE app_user SET sessions_revoked_at = NULL WHERE id = $1',
			"UPDATE app_user SET sessions_revoked_at = now() - interval '1 day' WHERE id = $1"
		]) {
			// As the account itself: under app_user's own-row policy (068) that is the one water_app context that reaches the row.
			const touched = await withUser(u.id, (db) => db.query(sql, [u.id]));
			expect(touched.rowCount, sql).toBe(1);
			const [after] = await asOwner('SELECT sessions_revoked_at FROM app_user WHERE id = $1', [u.id]);
			expect(after.sessions_revoked_at, sql).toEqual(before.sessions_revoked_at);
			expect((await anon('GET', '/auth/me', undefined, stolen)).status, sql).toBe(401);
		}
		// Forward still moves it (a later sign out everywhere).
		await withUser(u.id, (db) => db.query("UPDATE app_user SET sessions_revoked_at = now() + interval '1 minute' WHERE id = $1", [u.id]));
		const [later] = await asOwner('SELECT sessions_revoked_at FROM app_user WHERE id = $1', [u.id]);
		expect(later.sessions_revoked_at.getTime()).toBeGreaterThan(before.sessions_revoked_at.getTime());
	});
});

describe('notes', () => {
	it('refuses to undelete a note (positive control: the author deletes it)', async () => {
		const n = await owner.call('POST', `/projects/${projectId}/notes`, { body: 'to be deleted' });
		expect(n.status).toBe(201);
		const id = n.body.note.id as string;
		expect((await owner.call('DELETE', `/projects/${projectId}/notes/${id}`)).status).toBe(204);
		for (const sql of ['UPDATE note SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', "UPDATE note SET body = 'back' WHERE id = $1"]) {
			// Out of reach under RLS (note_update needs deleted_at IS NULL) ...
			await expectRefused(sql, [id]);
		}
		// ... and refused by note_guard even past RLS, as the schema owner.
		await expect(asOwner('UPDATE note SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [id])).rejects.toMatchObject(CHECK);
		const [row] = await asOwner('SELECT deleted_at, deleted_by, body FROM note WHERE id = $1', [id]);
		expect(row).toMatchObject({ deleted_by: owner.id, body: 'to be deleted' });
		expect(row.deleted_at).not.toBeNull();
	});
});

describe('scenarios', () => {
	it('refuses to undo or rewrite a decision (positive control: an editor decides it)', async () => {
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'scenario base' });
		expect(run.status).toBe(201);
		const s = await owner.call('POST', `/projects/${projectId}/scenarios`, { name: 'Final scenario', baseRunId: run.body.run.id, ops: [] });
		expect(s.status).toBe(201);
		const sid = s.body.scenario.id as string;
		expect((await owner.call('POST', `/projects/${projectId}/scenarios/${sid}/submit`, {})).status).toBe(200);
		await actForAuthority(owner, projectId, owner.id);
		expect((await owner.call('POST', `/projects/${projectId}/scenarios/${sid}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(200);
		for (const sql of [
			"UPDATE scenario SET status = 'submitted', decided_at = NULL, decided_by = NULL, outcome = NULL WHERE id = $1",
			"UPDATE scenario SET outcome = 'licence_refused' WHERE id = $1",
			"UPDATE scenario SET decided_at = decided_at + interval '1 day' WHERE id = $1",
			// 161: the authority's record is set once, with the outcome.
			"UPDATE scenario SET decision_authority = 'Someone else' WHERE id = $1",
			"UPDATE scenario SET decision_date = decision_date - 1 WHERE id = $1",
			"UPDATE scenario SET reasons_received = false WHERE id = $1",
			"UPDATE scenario SET decision_reference = '' WHERE id = $1"
		]) {
			await expectRefused(sql, [sid]);
		}
		const [row] = await asOwner('SELECT status, outcome, decided_by FROM scenario WHERE id = $1', [sid]);
		expect(row).toMatchObject({ status: 'decided', outcome: 'licence_issued', decided_by: owner.id });
	});
});
