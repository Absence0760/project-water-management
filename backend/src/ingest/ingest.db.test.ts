// Per-project API keys and the ingest endpoint (WP-2.9, 039_api_keys.sql).
// Every "cannot" has a positive control: the owner can, a live key writes its
// own project's series, an allowed series merges.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withApiKey, withUser } from '../db/tx.js';
import { BAD_KEY } from './auth.js';
import { INGEST_RATE } from './keys.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Res = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;

const ORIGIN = 'http://localhost:7777';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

async function ingest(method: string, path: string, key: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
	const r = await app.request(`/ingest/v1${path}`, {
		method,
		headers: { ...(key !== null ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}

const createKey = (pid: string, body: Record<string, unknown> = {}, as: User = owner) => as.call('POST', `/projects/${pid}/api-keys`, { name: 'Weir logger', ...body });
async function newKey(pid: string, body: Record<string, unknown> = {}): Promise<{ id: string; secret: string }> {
	const res = await createKey(pid, body);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return { id: res.body.key.id, secret: res.body.secret };
}

const rain = (startDate: string, values: (number | null)[], name = '') => ({ kind: 'rain_catchment_mm', name, unit: 'mm', startDate, values });
const merge = (key: string, body: unknown) => ingest('POST', '/series/merge', key, body);

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Kowner', 'Keditor', 'Kviewer', 'Kstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Keyed catchment' })).body.project.id;
	otherProjectId = (await owner.call('POST', '/projects', { name: 'Other catchment' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
}, 60_000);

describe('owning API keys', () => {
	it('lets an owner create, list and revoke a key; the secret is shown once and only its hash is stored', async () => {
		const res = await createKey(projectId, { name: 'Gateway A', expiresInDays: 90 });
		expect(res.status).toBe(201);
		const { key, secret } = res.body;
		expect(secret).toMatch(/^wm_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
		expect(secret.slice(3, 11)).toBe(key.id.slice(0, 8));
		expect(key).toMatchObject({ name: 'Gateway A', prefix: key.id.slice(0, 8), scopes: ['series:write'], allowedSeries: null, createdBy: 'Kowner', lastUsedAt: null, revokedAt: null });
		expect((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86_400_000).toBeCloseTo(90, 5);
		expect(Object.keys(key).sort()).toEqual(['allowedSeries', 'createdAt', 'createdBy', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt', 'revokedBy', 'scopes']);

		// Stored: the SHA-256 of the whole key, never the key.
		const [row] = await asOwner('SELECT key_hash, prefix, created_by FROM api_key WHERE id = $1', [key.id]);
		expect(Buffer.compare(row.key_hash, sha256(secret))).toBe(0);
		expect(row.created_by).toBe(owner.id);
		const [dump] = await asOwner('SELECT row_to_json(k)::text AS j FROM api_key k WHERE id = $1', [key.id]);
		expect(dump.j).not.toContain(secret.slice(12));

		const list = await owner.call('GET', `/projects/${projectId}/api-keys`);
		expect(list.status).toBe(200);
		expect(list.body.keys.find((k: { id: string }) => k.id === key.id)).toEqual(key);
		const text = JSON.stringify(list.body);
		expect(text).not.toContain(secret.slice(12));
		expect(text).not.toContain(sha256(secret).toString('hex'));
		expect(text).not.toContain('hash');

		// The audit log names the key but never holds the secret.
		const [ev] = await asOwner(`SELECT subject::text AS s, actor_user_id FROM audit_event WHERE project_id = $1 AND kind = 'api_key.created' AND subject->>'keyId' = $2`, [projectId, key.id]);
		expect(ev.actor_user_id).toBe(owner.id);
		expect(ev.s).not.toContain(secret.slice(12));

		expect((await owner.call('DELETE', `/projects/${projectId}/api-keys/${key.id}`)).status).toBe(204);
		expect((await owner.call('DELETE', `/projects/${projectId}/api-keys/${key.id}`)).status).toBe(204); // already revoked: done
		const after = (await owner.call('GET', `/projects/${projectId}/api-keys`)).body.keys.find((k: { id: string }) => k.id === key.id);
		expect(after.revokedAt).not.toBeNull();
		expect(after.revokedBy).toBe('Kowner');
		const kinds = (await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND subject->>'keyId' = $2 ORDER BY id`, [projectId, key.id])).map((r) => r.kind);
		expect(kinds).toEqual(['api_key.created', 'api_key.revoked']);
	});

	it('refuses editors and viewers (403) and strangers (404); the owner is the positive control', async () => {
		const { id } = await newKey(projectId);
		for (const u of [editor, viewer]) {
			expect((await u.call('GET', `/projects/${projectId}/api-keys`)).status).toBe(403);
			expect((await createKey(projectId, {}, u)).status).toBe(403);
			expect((await u.call('DELETE', `/projects/${projectId}/api-keys/${id}`)).status).toBe(403);
		}
		expect((await stranger.call('GET', `/projects/${projectId}/api-keys`)).status).toBe(404);
		expect((await createKey(projectId, {}, stranger)).status).toBe(404);
		expect((await stranger.call('DELETE', `/projects/${projectId}/api-keys/${id}`)).status).toBe(404);
		// Another project's key id under this project: not found, and not revoked.
		expect((await owner.call('DELETE', `/projects/${otherProjectId}/api-keys/${id}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${projectId}/api-keys`)).body.keys.find((k: { id: string }) => k.id === id).revokedAt).toBeNull();
	});

	it('hides the table from everyone but owners in the database itself, and nobody deletes a key', async () => {
		await newKey(projectId);
		const seen = async (u: User) => withUser(u.id, async (db) => (await db.query('SELECT id FROM api_key WHERE project_id = $1', [projectId])).rows.length);
		expect(await seen(owner)).toBeGreaterThan(0);
		for (const u of [editor, viewer, stranger]) expect(await seen(u)).toBe(0);
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM api_key WHERE project_id = $1', [projectId]))).rejects.toMatchObject({ code: '42501' });
		// Nor can the owner rewrite a key's hash or scopes past the API.
		await expect(withUser(owner.id, (db) => db.query('UPDATE api_key SET key_hash = $2 WHERE project_id = $1', [projectId, Buffer.alloc(32, 1)]))).rejects.toMatchObject({ code: '42501' });
		await expect(
			withUser(editor.id, (db) => db.query("INSERT INTO api_key (project_id, name, key_hash) VALUES ($1, 'x', $2)", [projectId, Buffer.alloc(32, 7)]))
		).rejects.toMatchObject({ code: '42501' });
	});

	it('validates the body', async () => {
		for (const body of [
			{ name: '' },
			{ name: 'x'.repeat(101) },
			{ name: 'ok', expiresInDays: 0 },
			{ name: 'ok', expiresInDays: 3651 },
			{ name: 'ok', expiresInDays: 1.5 },
			{ name: 'ok', scopes: ['admin'] },
			{ name: 'ok', scopes: [] },
			{ name: 'ok', allowedSeries: [] },
			{ name: 'ok', allowedSeries: [{ kind: 'not_a_kind', name: '' }] },
			{ name: 'ok', secret: 'mine' }
		]) {
			expect((await owner.call('POST', `/projects/${projectId}/api-keys`, body)).status, JSON.stringify(body)).toBe(400);
		}
	});
});

describe('authenticating with a key', () => {
	it('answers whoami for a live key, and one 401 for every bad one', async () => {
		const { id, secret } = await newKey(projectId, { name: 'Whoami key' });
		const ok = await ingest('GET', '/whoami', secret);
		expect(ok.status).toBe(200);
		expect(ok.body).toEqual({ project: { id: projectId, name: 'Keyed catchment' }, key: { id, name: 'Whoami key', scopes: ['series:write'], allowedSeries: null } });
		expect(ok.headers.get('cache-control')).toBe('no-store');

		const wrongSecret = `${secret.slice(0, 12)}${secret[12] === 'A' ? 'B' : 'A'}${secret.slice(13)}`;
		const unknownPrefix = `wm_00000000_${secret.slice(12)}`;
		for (const [label, header] of [
			['no header', null],
			['wrong secret, right prefix', `Bearer ${wrongSecret}`],
			['unknown prefix', `Bearer ${unknownPrefix}`],
			['malformed', 'Bearer wm_short'],
			['another scheme', `Basic ${secret}`],
			['the bare key', secret],
			['upper-case prefix', `Bearer ${secret.replace(/^wm_([0-9a-f]{8})/, (_m, p: string) => `wm_${p.toUpperCase()}`)}`]
		] as const) {
			const r = await app.request('/ingest/v1/whoami', { headers: header === null ? {} : { authorization: header } });
			expect(r.status, label).toBe(401);
			expect(await r.json(), label).toEqual({ error: BAD_KEY });
			expect(r.headers.get('www-authenticate'), label).toBe('Bearer');
		}
		// The scheme is case-insensitive.
		expect((await app.request('/ingest/v1/whoami', { headers: { authorization: `bearer ${secret}` } })).status).toBe(200);
	});

	it('refuses a revoked key on the next request (positive control: it worked just before)', async () => {
		const { id, secret } = await newKey(projectId);
		expect((await merge(secret, rain('2024-01-01', [1]))).status).toBe(200);
		expect((await owner.call('DELETE', `/projects/${projectId}/api-keys/${id}`)).status).toBe(204);
		const r = await merge(secret, rain('2024-01-02', [2]));
		expect(r.status).toBe(401);
		expect(r.body).toEqual({ error: BAD_KEY });
		expect((await ingest('GET', '/whoami', secret)).status).toBe(401);
		// And in the database: the revoked key's context sees and writes nothing.
		expect(await withApiKey(id, async (db) => (await db.query('SELECT 1 FROM time_series WHERE project_id = $1', [projectId])).rows.length)).toBe(0);
	});

	it('refuses an expired key', async () => {
		const { id, secret } = await newKey(projectId, { expiresInDays: 1 });
		expect((await ingest('GET', '/whoami', secret)).status).toBe(200);
		await asOwner("UPDATE api_key SET created_at = now() - interval '3 days', expires_at = now() - interval '1 second' WHERE id = $1", [id]);
		expect((await ingest('GET', '/whoami', secret)).status).toBe(401);
	});

	it('is not a session: a key opens no /projects route', async () => {
		const { secret } = await newKey(projectId);
		const r = await app.request(`/projects/${projectId}/series`, { headers: { authorization: `Bearer ${secret}`, origin: ORIGIN } });
		expect(r.status).toBe(401);
	});

	it('records when a key was last used', async () => {
		const { id, secret } = await newKey(projectId);
		expect((await ingest('GET', '/whoami', secret)).status).toBe(200);
		const key = (await owner.call('GET', `/projects/${projectId}/api-keys`)).body.keys.find((k: { id: string }) => k.id === id);
		expect(key.lastUsedAt).not.toBeNull();
	});
});

describe('ingesting days', () => {
	it("merges days into its own project's series, and the history names the key", async () => {
		const { id, secret } = await newKey(projectId, { name: 'Rain gateway' });
		const first = await merge(secret, { ...rain('2024-03-01', [0, 4.5, 12], 'Weir gauge'), source: 'gateway-7' });
		expect(first.status, JSON.stringify(first.body)).toBe(200);
		expect(first.body.series).toMatchObject({ kind: 'rain_catchment_mm', name: 'Weir gauge', unit: 'mm', startDate: '2024-03-01', length: 3 });
		expect(first.body.daysChanged).toBe(3);
		// Automatic runs are off in this project: nothing is queued (the queued case is below).
		expect(first.body.rerunQueuedFor).toBeNull();

		const next = await merge(secret, rain('2024-03-03', [13, 2], 'Weir gauge'));
		expect(next.status).toBe(200);
		expect(next.body.daysChanged).toBe(2);
		const values = (await owner.call('GET', `/projects/${projectId}/series/${first.body.series.id}`)).body.values;
		expect(values).toEqual([0, 4.5, 13, 2]);

		const events = await asOwner(
			`SELECT kind, actor_user_id, actor_api_key_id, actor_label, subject FROM audit_event WHERE project_id = $1 AND subject->>'seriesId' = $2 ORDER BY id`,
			[projectId, first.body.series.id]
		);
		expect(events.map((e) => e.kind)).toEqual(['series.created', 'series.merged']);
		for (const e of events) {
			expect(e).toMatchObject({ actor_user_id: null, actor_api_key_id: id, actor_label: 'API key “Rain gateway”' });
		}
		expect(events[0].subject.source).toBe('gateway-7');
		// A key's merge keeps no series revision (like a data feed's).
		expect(await asOwner('SELECT 1 FROM series_revision WHERE project_id = $1 AND series_id = $2', [projectId, first.body.series.id])).toEqual([]);
		// Viewers see it in the History tab, by the key's name.
		const history = await viewer.call('GET', `/projects/${projectId}/history?kind=series`);
		expect(history.status).toBe(200);
		const seen = history.body.items.filter((i: { subject?: { seriesId?: string } }) => i.subject?.seriesId === first.body.series.id);
		expect(seen.map((i: { actor: string }) => i.actor)).toEqual(['API key “Rain gateway”', 'API key “Rain gateway”']);
	});

	it('is idempotent: the same days again change nothing and record nothing', async () => {
		const { secret } = await newKey(projectId);
		const body = rain('2024-05-01', [1, 2, 3], 'Idempotent');
		expect((await merge(secret, body)).status).toBe(200);
		const [{ n: before }] = await asOwner('SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1', [projectId]);
		const again = await merge(secret, body);
		expect(again.status).toBe(200);
		expect(again.body.daysChanged).toBe(0);
		expect(again.body.rerunQueuedFor).toBeNull();
		const [{ n: after }] = await asOwner('SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1', [projectId]);
		expect(after).toBe(before);
	});

	it("writes only its own project: another project's key lands in its own project, and can't reach this one in SQL", async () => {
		const mine = await newKey(projectId);
		const theirs = await newKey(otherProjectId);
		const r = await merge(theirs.secret, rain('2024-06-01', [7], 'Crossover'));
		expect(r.status).toBe(200);
		const [row] = await asOwner(`SELECT project_id FROM time_series WHERE id = $1`, [r.body.series.id]);
		expect(row.project_id).toBe(otherProjectId);
		expect(await asOwner(`SELECT 1 FROM time_series WHERE project_id = $1 AND name = 'Crossover'`, [projectId])).toEqual([]);

		// In the database: this project's series are invisible to their key (positive control: visible to mine).
		const count = (keyId: string) => withApiKey(keyId, async (db) => (await db.query('SELECT 1 FROM time_series WHERE project_id = $1', [projectId])).rows.length);
		expect(await count(mine.id)).toBeGreaterThan(0);
		expect(await count(theirs.id)).toBe(0);
		await expect(
			withApiKey(theirs.id, (db) => db.query("INSERT INTO time_series (project_id, kind, name, unit, start_date, \"values\") VALUES ($1, 'rain_catchment_mm', 'x', 'mm', '2024-01-01', '{1}')", [projectId]))
		).rejects.toMatchObject({ code: '42501' });
		const updated = await withApiKey(theirs.id, async (db) => (await db.query("UPDATE time_series SET \"values\" = '{0}' WHERE project_id = $1", [projectId])).rowCount);
		expect(updated).toBe(0);
		// Nor can it log an event against this project, or as anyone else.
		await expect(
			withApiKey(theirs.id, (db) => db.query("INSERT INTO audit_event (project_id, actor_api_key_id, actor_label, kind) VALUES ($1, $2, 'x', 'series.merged')", [projectId, theirs.id]))
		).rejects.toMatchObject({ code: '42501' });
		await expect(
			withApiKey(mine.id, (db) => db.query("INSERT INTO audit_event (project_id, actor_api_key_id, actor_label, kind) VALUES ($1, $2, 'x', 'series.merged')", [projectId, theirs.id]))
		).rejects.toMatchObject({ code: '42501' });
	});

	it("can't read the model, runs, members, the project, keys or the history", async () => {
		const { id, secret } = await newKey(projectId);
		expect((await merge(secret, rain('2024-07-01', [1], 'Visible'))).status).toBe(200);
		const seen = await withApiKey(id, async (db) => {
			const n = async (sql: string) => (await db.query(sql, [projectId])).rows.length;
			return {
				time_series: await n('SELECT 1 FROM time_series WHERE project_id = $1'),
				project: await n('SELECT 1 FROM project WHERE id = $1'),
				project_member: await n('SELECT 1 FROM project_member WHERE project_id = $1'),
				node: await n('SELECT 1 FROM node WHERE project_id = $1'),
				model_run: await n('SELECT 1 FROM model_run WHERE project_id = $1'),
				api_key: await n('SELECT 1 FROM api_key WHERE project_id = $1'),
				audit_event: await n('SELECT 1 FROM audit_event WHERE project_id = $1'),
				series_revision: await n('SELECT 1 FROM series_revision WHERE project_id = $1'),
				data_feed: await n('SELECT 1 FROM data_feed WHERE project_id = $1')
			};
		});
		// Positive control: its own series.
		expect(seen.time_series).toBeGreaterThan(0);
		expect({ ...seen, time_series: 0 }).toEqual({
			time_series: 0,
			project: 0,
			project_member: 0,
			node: 0,
			model_run: 0,
			api_key: 0,
			audit_event: 0,
			series_revision: 0,
			data_feed: 0
		});
		// And no deleting a series.
		expect(await withApiKey(id, async (db) => (await db.query('DELETE FROM time_series WHERE project_id = $1', [projectId])).rowCount)).toBe(0);
	});

	it('holds a key to its allowed series (403), in the route and in the database', async () => {
		const { id, secret } = await newKey(projectId, { allowedSeries: [{ kind: 'rain_catchment_mm', name: 'Allowed gauge' }] });
		expect((await merge(secret, rain('2024-08-01', [1], 'Allowed gauge'))).status).toBe(200);
		const refused = await merge(secret, rain('2024-08-01', [1], 'Other gauge'));
		expect(refused.status).toBe(403);
		expect(refused.body).toEqual({ error: 'this key may not write that series' });
		const flow = await merge(secret, { kind: 'flow_observed_m3s', name: 'Allowed gauge', unit: 'm3/s', startDate: '2024-08-01', values: [1] });
		expect(flow.status).toBe(403);
		expect((await ingest('GET', '/whoami', secret)).body.key.allowedSeries).toEqual([{ kind: 'rain_catchment_mm', name: 'Allowed gauge' }]);
		// In the database: the other series of the project don't exist for it.
		const names = await withApiKey(id, async (db) => (await db.query('SELECT name FROM time_series WHERE project_id = $1', [projectId])).rows.map((r) => r.name));
		expect(names).toEqual(['Allowed gauge']);
		await expect(
			withApiKey(id, (db) => db.query("INSERT INTO time_series (project_id, kind, name, unit, start_date, \"values\") VALUES ($1, 'rain_catchment_mm', 'Sneaky', 'mm', '2024-01-01', '{1}')", [projectId]))
		).rejects.toMatchObject({ code: '42501' });
	});

	it('checks the scope in the database: series:write holds, another scope never does', async () => {
		const { id } = await newKey(projectId);
		const scoped = await withApiKey(id, async (db) => (await db.query("SELECT app_api_key_project('series:write') AS a, app_api_key_project('model:write') AS b, app_api_key_project(NULL) AS c")).rows[0]);
		expect(scoped).toEqual({ a: projectId, b: null, c: projectId });
		// A user's transaction has no key project, and the two contexts never mix.
		expect(await withUser(owner.id, async (db) => (await db.query("SELECT app_api_key_project('series:write') AS p")).rows[0].p)).toBeNull();
		expect(
			await withApiKey(id, async (db) => {
				await db.query("SELECT set_config('app.current_user_id', $1, true)", [owner.id]);
				return (await db.query("SELECT app_api_key_project('series:write') AS p")).rows[0].p;
			})
		).toBeNull();
		// Only known scopes can be stored.
		await expect(asOwner("UPDATE api_key SET scopes = '{series:write,admin}' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23514' });
	});

	it('validates the body like the series merge (400), after the key (401 first)', async () => {
		const { secret } = await newKey(projectId);
		expect((await merge(secret, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-02-30', values: [1] })).status).toBe(400);
		expect((await merge(secret, { kind: 'rain_catchment_mm', unit: 'furlongs', startDate: '2024-01-01', values: [1] })).status).toBe(400);
		expect((await merge(secret, { ...rain('2024-01-01', [1]), source: 'x'.repeat(101) })).status).toBe(400);
		const notJson = await app.request('/ingest/v1/series/merge', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{"kind":' });
		expect(notJson.status).toBe(400);
		expect((await merge('wm_00000000_' + 'a'.repeat(43), { nonsense: true })).status).toBe(401);
		// A form post is refused (csrf); ingest takes JSON only.
		const form = await app.request('/ingest/v1/series/merge', {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
			body: 'kind=rain_catchment_mm'
		});
		expect(form.status).toBe(403);
	});

	it('refuses a merge that would pass 60 000 days (413)', async () => {
		const { secret } = await newKey(projectId);
		expect((await merge(secret, rain('1900-01-01', [1], 'Long'))).status).toBe(200);
		const r = await merge(secret, rain('2100-01-01', [1], 'Long'));
		expect(r.status).toBe(413);
	});
});

describe('the rate limit', () => {
	it('answers 429 with Retry-After once the bucket is empty (positive control: a full bucket answers)', async () => {
		const { id, secret } = await newKey(projectId);
		expect((await ingest('GET', '/whoami', secret)).status).toBe(200);
		await asOwner('UPDATE api_key_throttle SET tokens = 0, refilled_at = clock_timestamp() WHERE key_id = $1', [id]);
		const r = await ingest('GET', '/whoami', secret);
		expect(r.status).toBe(429);
		expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
		expect(r.body.error).toContain(`${INGEST_RATE.perMinute} a minute`);
		// Another key has its own bucket.
		const other = await newKey(projectId);
		expect((await ingest('GET', '/whoami', other.secret)).status).toBe(200);
	});

	it('counts concurrent requests one by one: of 12 at once against a bucket of 5, exactly 5 go ahead', async () => {
		const { id } = await newKey(projectId);
		const clients = await Promise.all(
			Array.from({ length: 12 }, async () => {
				const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
				await c.connect();
				return c;
			})
		);
		try {
			const waits = await Promise.all(clients.map(async (c) => (await c.query<{ w: number }>('SELECT app_api_key_take($1, 5, 1) AS w', [id])).rows[0]!.w));
			expect(waits.filter((w) => w === 0)).toHaveLength(5);
			expect(waits.filter((w) => w > 0)).toHaveLength(7);
		} finally {
			await Promise.all(clients.map((c) => c.end()));
		}
	});

	it('takes nothing for a revoked key (-1)', async () => {
		const { id } = await newKey(projectId);
		expect((await owner.call('DELETE', `/projects/${projectId}/api-keys/${id}`)).status).toBe(204);
		const [{ w }] = await asOwner('SELECT app_api_key_take($1, 5, 1) AS w', [id]);
		expect(w).toBe(-1);
	});
});

describe('automatic re-runs from an ingest (042_auto_rerun.sql, WP-2.11)', () => {
	/** A fresh project owned by `u`, automatic runs as given, and a key `u` made for it. */
	async function keyed(u: User, autoRun: Record<string, unknown> | null) {
		const pid = (await u.call('POST', '/projects', { name: 'Auto-run ingest' })).body.project.id as string;
		if (autoRun) expect((await u.call('PATCH', `/projects/${pid}`, { settings: { autoRun } })).status).toBe(200);
		const res = await createKey(pid, {}, u);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return { pid, keyId: res.body.key.id as string, secret: res.body.secret as string };
	}
	const rerunJobs = async (pid: string) =>
		(await asOwner(`SELECT id, run_after, acting_user_id, payload FROM job WHERE project_id = $1 AND kind = 'rerun'`, [pid])) as {
			id: string;
			run_after: Date;
			acting_user_id: string;
			payload: Record<string, unknown>;
		}[];

	it('with automatic runs on, queues a re-run acting as the key’s creator and answers when it is due', async () => {
		const { pid, secret } = await keyed(owner, { enabled: true });
		const res = await merge(secret, rain('2026-03-01', [1, 2]));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const jobs = await rerunJobs(pid);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ acting_user_id: owner.id, payload: { trigger: 'auto', cause: 'ingest' } });
		expect(res.body.rerunQueuedFor).toBe(jobs[0]!.run_after.toISOString());
		// The same days again change nothing: no push-back, and null.
		const again = await merge(secret, rain('2026-03-01', [1, 2]));
		expect(again.body.rerunQueuedFor).toBeNull();
		expect(await rerunJobs(pid)).toHaveLength(1);
		await asOwner('DELETE FROM job WHERE project_id = $1', [pid]);
	});

	it('with automatic runs off, queues nothing (positive control: the days merge)', async () => {
		const { pid, secret } = await keyed(owner, null);
		const res = await merge(secret, rain('2026-03-01', [1, 2]));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ daysChanged: 2, rerunQueuedFor: null });
		expect(await rerunJobs(pid)).toHaveLength(0);
	});

	it('a key whose creator’s account was deleted still ingests, and skips the re-run', async () => {
		const creator = await signUp('Kcreator');
		const pid = (await owner.call('POST', '/projects', { name: 'Orphaned key' })).body.project.id as string;
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: creator.email, role: 'owner' })).status).toBe(201);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		const res0 = await createKey(pid, {}, creator);
		expect(res0.status).toBe(201);
		const { key, secret } = res0.body as { key: { id: string }; secret: string };
		// The account goes; api_key.created_by is ON DELETE SET NULL, so the key keeps working.
		await asOwner('DELETE FROM app_user WHERE id = $1', [creator.id]);
		expect((await asOwner('SELECT created_by FROM api_key WHERE id = $1', [key.id]))[0].created_by).toBeNull();

		const res = await merge(secret, rain('2026-03-01', [4, 5]));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ daysChanged: 2, rerunQueuedFor: null });
		expect(await rerunJobs(pid)).toHaveLength(0);
		// The days are there: the ingest committed.
		const [row] = await asOwner(`SELECT "values" FROM time_series WHERE project_id = $1 AND kind = 'rain_catchment_mm'`, [pid]);
		expect(row.values).toEqual([4, 5]);
	});
});
