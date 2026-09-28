// API-key security sweeps (docs/security.md § API keys). ingest.db.test.ts
// holds the per-feature cases; this file sweeps the live inventories so a new
// table, policy or route is covered the day it lands:
//
//   1. the catalogue: every RLS policy a key context can satisfy is on an
//      allowlist with its reason, and each one re-checks the key is live;
//   2. every table and view, read, updated and deleted as a key of the SAME
//      project (isolation.db.test.ts does another project's key): only the
//      key's own allowed series and its own series_key_days rows show;
//   3. every GET route, as the owner: the secret and its hash never come
//      back after the 201 that made the key;
//   4. the bucket: a wrong secret under a real prefix (which viewers see in
//      the history) takes nothing from the real key's bucket;
//   5. an expired key, and a key moving its series out of bounds, at the
//      database level.
//
// Every "cannot" has a positive control: the owner sees the rows, the key
// sees and updates its own allowed series, the history shows the key's prefix.
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { type Db, withApiKey } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

// Every (table, command) whose policy a key context can satisfy, with why.
// A new entry here widens what a leaked key can do: it needs the same
// scrutiny as an addition to routes.test.ts PUBLIC.
const KEY_POLICIES = new Map<string, string>([
	['time_series:SELECT', 'mergeInto reads the series it merges into (its own project, allowed series only)'],
	['time_series:INSERT', 'the first push of a series creates it'],
	['time_series:UPDATE', 'a push merges days into the series'],
	['audit_event:INSERT', 'every merge is logged with the key as the actor'],
	['series_key_days:SELECT', 'the hold judges a key without its own earlier days (053)'],
	['series_key_days:INSERT', 'the merge records the days this key wrote (053)'],
	['series_key_days:UPDATE', 'and adds to them on a later push (053)']
]);

// Tables a key of the project may see rows of, and which rows. `language`
// (080) is reference data readable by every session, the same for everyone
// and holding nothing of any project or person.
const KEY_VISIBLE = new Set(['time_series', 'series_key_days', 'language']);

const rain = (startDate: string, values: number[], name: string) => ({ kind: 'rain_catchment_mm', name, unit: 'mm', startDate, values });
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

let owner: User;
let projectId: string;
let otherProjectId: string;
let key: { id: string; secret: string; prefix: string };

async function ingest(method: string, path: string, secret: string, body?: unknown) {
	const r = await app.request(`/ingest/v1${path}`, {
		method,
		headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text() };
}

async function newKey(pid: string, body: Record<string, unknown> = {}) {
	const r = await app.request(`/projects/${pid}/api-keys`, {
		method: 'POST',
		headers: { cookie: owner.cookie, origin: ORIGIN, 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'Sweep key', ...body })
	});
	expect(r.status).toBe(201);
	// The one response that carries the secret must not be cached anywhere.
	expect(r.headers.get('cache-control')).toBe('no-store');
	const j = (await r.json()) as { key: { id: string; prefix: string }; secret: string };
	return { id: j.key.id, prefix: j.key.prefix, secret: j.secret };
}

/** Run one statement in a savepoint and roll it back: rows it touched, or the refusal's code. */
async function attempt(db: Db, sql: string): Promise<number | string> {
	await db.query('SAVEPOINT attempt');
	try {
		return (await db.query(sql)).rowCount ?? 0;
	} catch (e) {
		return (e as { code?: string }).code ?? 'error';
	} finally {
		await db.query('ROLLBACK TO SAVEPOINT attempt');
	}
}

beforeAll(async () => {
	owner = await signUp('Keysweep');
	projectId = (await owner.call('POST', '/projects', { name: 'Key sweep catchment' })).body.project.id;
	otherProjectId = (await owner.call('POST', '/projects', { name: 'Key sweep other' })).body.project.id;
	// A project with rows in the core tables: a model, a series the key may not
	// write, a run, a member, a farmer and a note-worthy history.
	const outlet = node('Outlet', null);
	const farm = node('Sweep farm', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	expect(
		(await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] })).status
	).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: days })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/series/merge`, rain('2020-01-01', days, 'Private gauge'))).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Sweep run' })).status).toBe(201);
	const member = await signUp('Keysweepviewer');
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: member.email, role: 'viewer' })).status).toBe(201);
	const farmer = await signUp('Keysweepfarmer');
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	// The other project has a series too, which the key must never see.
	expect((await owner.call('POST', `/projects/${otherProjectId}/series/merge`, rain('2020-01-01', [1], 'Allowed gauge'))).status).toBe(200);

	key = await newKey(projectId, { allowedSeries: [{ kind: 'rain_catchment_mm', name: 'Allowed gauge' }] });
	expect((await ingest('POST', '/series/merge', key.secret, rain('2020-01-01', [1, 2, 3], 'Allowed gauge'))).status).toBe(200);
}, 60_000);

describe('the catalogue: what a key context can satisfy', () => {
	it('lists every policy a key can pass, and each re-checks the key is live (app_api_key_project)', async () => {
		const rows = await asOwner(
			`SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
			 WHERE schemaname = 'public' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'app_api_key|app_current_api_key_id'`
		);
		// Not vacuous: the 039 policies are there.
		expect(rows.length).toBeGreaterThanOrEqual(KEY_POLICIES.size);
		const found = new Set(rows.map((r) => `${r.tablename}:${r.cmd}`));
		expect([...found].sort()).toEqual([...KEY_POLICIES.keys()].sort());
		// Revocation and expiry apply to the next statement only because every
		// key policy calls app_api_key_project, which checks both.
		const unchecked = rows
			.flatMap((r) => [
				['qual', r.qual],
				['with_check', r.with_check]
			].filter(([, e]) => e !== null && !/app_api_key_project\(/.test(e as string)).map(([w]) => `${r.policyname} ${w}`));
		expect(unchecked).toEqual([]);
	});
});

describe('a key of the same project, in every table and view', () => {
	let relations: { name: string; kind: string }[] = [];

	// Every table under RLS, and every view (a view runs as its owner unless it
	// is security_invoker, so it could show what RLS hides; catalogue.db.test.ts
	// requires security_invoker). app_user is in the sweep since it came under
	// RLS (068_app_user_rls.sql); the one table without RLS, schema_migrations,
	// has no grant to water_app at all.
	it('positive control: app_user is in the sweep, and has rows a key must not see', async () => {
		expect(relations.map((r) => r.name)).toContain('app_user');
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM app_user');
		expect(n).toBeGreaterThan(0);
	});
	beforeAll(async () => {
		relations = (
			await asOwner(
				`SELECT c.relname AS name, CASE WHEN c.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'BASE TABLE' END AS kind
				 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				 WHERE n.nspname = 'public' AND (c.relkind IN ('v', 'm') OR (c.relkind IN ('r', 'p') AND c.relrowsecurity))
				 ORDER BY 1`
			)
		).map((r) => ({ name: r.name as string, kind: r.kind as string }));
	});

	it('positive control: the sweep reaches tables that have rows, and the key reads its own allowed series', async () => {
		let filled = 0;
		for (const { name } of relations) {
			const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM "${name}"`);
			if (n > 0) filled++;
		}
		expect(relations.length).toBeGreaterThan(50);
		expect(filled).toBeGreaterThan(12);
		const seen = await withApiKey(key.id, async (db) => (await db.query('SELECT project_id, kind, name FROM time_series')).rows);
		expect(seen).toEqual([{ project_id: projectId, kind: 'rain_catchment_mm', name: 'Allowed gauge' }]);
	});

	it('shows nothing but its own allowed series and its own series_key_days rows', async () => {
		const [{ n: projectRows }] = await asOwner('SELECT count(*)::int AS n FROM node WHERE project_id = $1', [projectId]);
		expect(projectRows).toBeGreaterThan(0); // the project has data the key could leak
		const visible: string[] = [];
		await withApiKey(key.id, async (db) => {
			for (const { name } of relations) {
				await db.query('SAVEPOINT r');
				try {
					const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${name}"`);
					if (rows[0].n > 0 && !KEY_VISIBLE.has(name)) visible.push(`${name} (${rows[0].n})`);
				} catch (e) {
					if ((e as { code?: string }).code !== '42501') throw e; // no grant: as good as no rows
				} finally {
					await db.query('ROLLBACK TO SAVEPOINT r');
				}
			}
			// And the two it may see hold only its own rows.
			const ts = await db.query('SELECT 1 FROM time_series WHERE project_id <> $1 OR name <> $2', [projectId, 'Allowed gauge']);
			if (ts.rows.length) visible.push(`time_series: ${ts.rows.length} rows outside its allowed series`);
			const kd = await db.query('SELECT 1 FROM series_key_days WHERE api_key_id <> $1', [key.id]);
			if (kd.rows.length) visible.push(`series_key_days: ${kd.rows.length} rows of another key`);
		});
		expect(visible).toEqual([]);
	});

	it('updates only its own allowed series and key days, and deletes nothing, in any table', async () => {
		const tables = relations.filter((r) => r.kind === 'BASE TABLE').map((r) => r.name);
		const cols = new Map(
			(
				await asOwner(
					// A column water_app may update, so the statement reaches RLS rather than stopping at the grant.
					`SELECT DISTINCT ON (c.table_name) c.table_name, c.column_name FROM information_schema.columns c
					 JOIN information_schema.column_privileges p USING (table_schema, table_name, column_name)
					 WHERE c.table_schema = 'public' AND p.grantee = 'water_app' AND p.privilege_type = 'UPDATE'
					   AND c.is_generated = 'NEVER' AND c.is_identity = 'NO'
					 ORDER BY c.table_name, c.ordinal_position`
				)
			).map((r) => [r.table_name as string, r.column_name as string])
		);
		const changed: string[] = [];
		const allowed: Record<string, number | string> = {};
		await withApiKey(key.id, async (db) => {
			for (const t of tables) {
				const col = cols.get(t);
				const stmts = [`DELETE FROM "${t}"`, ...(col ? [`UPDATE "${t}" SET "${col}" = "${col}"`] : [])];
				for (const sql of stmts) {
					const r = await attempt(db, sql);
					if (typeof r !== 'number' || r === 0) continue;
					if (sql.startsWith('UPDATE') && KEY_VISIBLE.has(t)) allowed[t] = r;
					else changed.push(`${sql}: ${r} rows`);
				}
			}
		});
		expect(changed).toEqual([]);
		// Positive control: its own rows are the ones it can update (one series, its days).
		expect(allowed).toEqual({ time_series: 1, series_key_days: 1 });
	});
});

describe('the secret after the 201', () => {
	it('never comes back from any GET route, nor its hash (positive control: the history names the key by prefix)', async () => {
		const hash = sha256(key.secret);
		const needles = [key.secret.slice(12), hash.toString('hex'), hash.toString('base64'), hash.toString('base64url')];
		const gets = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))];
		const [run] = await asOwner('SELECT id FROM model_run WHERE project_id = $1', [projectId]);
		const [series] = await asOwner("SELECT id FROM time_series WHERE project_id = $1 AND name = 'Allowed gauge'", [projectId]);
		const ids: Record<string, string> = { id: projectId, runId: run.id, seriesId: series.id, keyId: key.id };
		const leaks: string[] = [];
		let ok = 0;
		let prefixSeen = false;
		for (const pattern of gets) {
			const path = pattern.replace(/:([A-Za-z]+)/g, (_, n: string) => ids[n] ?? crypto.randomUUID());
			const headers: Record<string, string> = pattern.startsWith('/ingest/') ? { authorization: `Bearer ${key.secret}` } : { cookie: owner.cookie, origin: ORIGIN };
			const r = await app.request(path, { headers });
			const text = await r.text();
			if (r.status < 400) ok++;
			if (text.includes(key.prefix)) prefixSeen = true;
			for (const n of needles) if (text.includes(n)) leaks.push(`${pattern} → ${r.status}`);
		}
		expect(gets.length).toBeGreaterThan(50);
		expect(ok).toBeGreaterThan(30);
		expect(prefixSeen).toBe(true);
		expect(leaks).toEqual([]);
	});
});

describe('the bucket', () => {
	it('takes nothing for a wrong secret under a real prefix (positive control: the real key takes a token)', async () => {
		// The prefix is not secret: owners list it and every viewer's History
		// shows it (the api_key.created event). Guessing at it must not throttle
		// the real gateway.
		const k = await newKey(projectId);
		const wrong = `wm_${k.prefix}_${'A'.repeat(43)}`;
		for (let i = 0; i < 5; i++) expect((await ingest('GET', '/whoami', wrong)).status).toBe(401);
		expect(await asOwner('SELECT tokens FROM api_key_throttle WHERE key_id = $1', [k.id])).toEqual([]);
		const [{ last_used_at }] = await asOwner('SELECT last_used_at FROM api_key WHERE id = $1', [k.id]);
		expect(last_used_at).toBeNull();

		// With one token left, every wrong guess still leaves it to the real key.
		await asOwner('INSERT INTO api_key_throttle (key_id, tokens, refilled_at) VALUES ($1, 1, clock_timestamp())', [k.id]);
		for (let i = 0; i < 5; i++) expect((await ingest('GET', '/whoami', wrong)).status).toBe(401);
		expect((await ingest('GET', '/whoami', k.secret)).status).toBe(200);
		const [{ tokens }] = await asOwner('SELECT tokens FROM api_key_throttle WHERE key_id = $1', [k.id]);
		expect(tokens).toBeLessThan(1);
	});
});

describe('liveness and bounds in the database', () => {
	it("an expired key's context reads and writes nothing (positive control: before expiry it does)", async () => {
		const k = await newKey(projectId, { expiresInDays: 1 });
		const count = () => withApiKey(k.id, async (db) => (await db.query('SELECT 1 FROM time_series WHERE project_id = $1', [projectId])).rows.length);
		expect(await count()).toBeGreaterThan(0);
		await asOwner("UPDATE api_key SET created_at = now() - interval '3 days', expires_at = now() - interval '1 second' WHERE id = $1", [k.id]);
		expect(await count()).toBe(0);
		const insert = await withApiKey(k.id, (db) =>
			attempt(db, `INSERT INTO time_series (project_id, kind, name, unit, start_date, "values") VALUES ('${projectId}', 'rain_catchment_mm', 'Late', 'mm', '2024-01-01', '{1}')`)
		);
		expect(insert).toBe('42501');
	});

	it('a key cannot rename its allowed series into another, or move it to another project (positive control: it updates the values)', async () => {
		const run = (sql: string) => withApiKey(key.id, (db) => attempt(db, sql));
		const own = `project_id = '${projectId}' AND name = 'Allowed gauge'`;
		expect(await run(`UPDATE time_series SET "values" = '{9}' WHERE ${own}`)).toBe(1);
		expect(await run(`UPDATE time_series SET name = 'Renamed gauge' WHERE ${own}`)).toBe('42501');
		expect(await run(`UPDATE time_series SET kind = 'flow_observed_m3s' WHERE ${own}`)).toBe('42501');
		expect(await run(`UPDATE time_series SET project_id = '${otherProjectId}' WHERE ${own}`)).toBe('42501');
	});
});
