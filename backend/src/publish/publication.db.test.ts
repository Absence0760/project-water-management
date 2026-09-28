// Publishing a run (WP-2.3, 022_publication.sql) and the farmer's farm view
// built from it (WP-2.6 API). Every "cannot see" check has a positive
// control: the same farmer sees their own farm, a viewer sees every farm.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, asOwner, makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { trimRuns } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User; // linked to farm 1
let farmer2: User; // linked to farm 2 (later farms 2–4)
let stranger: User;
let projectId: string;
// Outlet ← 1 ← 2 ← 3, and 4, 5, 6 straight into the outlet: six farms, so the aggregate rule (k = 5) can go either way.
const outlet = node('Weir', null);
const one = node('Farm One', outlet.id);
const two = node('Farm Two', one.id);
const farms = [
	one,
	two,
	node('Farm Three', two.id),
	node('Farm Four', outlet.id),
	node('Farm Five', outlet.id, { damMinPct: 0 }),
	node('Farm Six', outlet.id, { damCapacityM3: 0, damInitialPct: 0 })
];
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const RAIN_START = '2021-10-01';
const DAYS = 820; // to 2023-12-29

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);
const run = async (u: User, pid = projectId) => {
	const res = await u.call('POST', `/projects/${pid}/runs`, { label: 'r' });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
};
const publish = (u: User, runId: string, extra: Record<string, unknown> = {}, pid = projectId) => u.call('POST', `/projects/${pid}/publication`, { runId, ...extra });
const csv = async (u: User, path: string) => {
	const r = await app.request(path, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	return { status: r.status, text: await r.text(), headers: r.headers };
};

/** A project with the six-farm network; node and crop ids are the shared ones for the main project, fresh for any other (ids are global). */
async function makeProject(u: User, name: string, sharedIds = false, days = DAYS) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const ids = new Map<string, string>([outlet, ...farms, crop].map((x) => [x.id, sharedIds ? x.id : crypto.randomUUID()]));
	const remap = (v: string | null) => (v === null ? null : ids.get(v)!);
	const model = {
		nodes: [outlet, ...farms].map((n) => ({ ...n, id: remap(n.id), downstreamNodeId: remap(n.downstreamNodeId) })),
		crops: [{ ...crop, id: remap(crop.id) }],
		cropAreas: farms.map((f, i) => ({ nodeId: remap(f.id), cropId: remap(crop.id), areaM2: 100_000 + 40_000 * i })),
		transfers: []
	};
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: rain })).status).toBe(200);
	return id;
}

beforeAll(async () => {
	[owner, editor, viewer, farmer, farmer2, stranger] = (await Promise.all(['Powner', 'Peditor', 'Pviewer', 'Pfarmer', 'Pfarmertwo', 'Pstranger'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User,
		User
	];
	projectId = await makeProject(owner, 'Publication', true);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer2.email, nodeIds: [farms[1]!.id] })).status).toBe(201);
}, 60_000);

/** The project as each member's GET /projects lists it (null when it isn't listed). */
const listed = async (u: User, pid = projectId) =>
	((await u.call('GET', '/projects')).body.projects as { id: string; publishedAt: string | null }[]).find((p) => p.id === pid) ?? null;

describe('publishedAt on the project list (WP-2.1, WP-2.3)', () => {
	it('is null for every member before any publication', async () => {
		for (const u of [owner, editor, viewer, farmer]) expect((await listed(u))?.publishedAt, u.email).toBeNull();
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.publishedAt).toBeNull();
	});

	it('carries the current publication’s date for every member, farmers included, and follows a re-publish', async () => {
		const other = await makeProject(owner, 'Publication elsewhere');
		const first = await publish(owner, await run(owner, other), {}, other);
		expect(first.status).toBe(201);
		const at = first.body.publication.publishedAt as string;
		const farmer3 = await signUp('Pfarmerthree');
		// Positive control: the owner, a viewer and a farmer of that project all see it.
		expect((await owner.call('POST', `/projects/${other}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${other}/farmers`, { email: farmer3.email, nodeIds: [(await asOwner("SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' LIMIT 1", [other]))[0].id] })).status).toBe(201);
		for (const u of [owner, viewer, farmer3]) expect((await listed(u, other))?.publishedAt, u.email).toBe(at);
		expect((await viewer.call('GET', `/projects/${other}`)).body.project.publishedAt).toBe(at);
		// A stranger isn't listed the project at all; the main project (no publication yet) stays null.
		expect(await listed(stranger, other)).toBeNull();
		expect((await listed(viewer))?.publishedAt).toBeNull();
		// Re-publishing moves it to the new publication, never the superseded one.
		const second = await publish(owner, await run(owner, other), {}, other);
		expect(second.status).toBe(201);
		expect((await listed(farmer3, other))?.publishedAt).toBe(second.body.publication.publishedAt);
		expect(Date.parse(second.body.publication.publishedAt)).toBeGreaterThanOrEqual(Date.parse(at));
	});
});

describe('publishing', () => {
	it('publishes a run as an editor, with one projection per farm, and one current publication', async () => {
		const r1 = await run(editor);
		const res = await publish(editor, r1, { note: 'First baseline', restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.', af: 'Spaar asseblief water.' } }, nextExpectedOn: '2024-01-15' });
		expect(res.status).toBe(201);
		expect(res.body.farms).toBe(6);
		expect(res.body.publication).toMatchObject({
			runId: r1,
			publishedBy: 'Peditor',
			note: 'First baseline',
			restriction: { level: 'advisory', pct: 10, notice: { en: 'Please save water.', af: 'Spaar asseblief water.' } },
			nextExpectedOn: '2024-01-15',
			supersededAt: null,
			catchmentView: { runStart: RAIN_START, farmCount: 6, runoffModel: 'gr4j' }
		});
		const r2 = await run(editor);
		expect((await publish(editor, r2)).status).toBe(201);
		const list = await viewer.call('GET', `/projects/${projectId}/publication`);
		expect(list.body.current.runId).toBe(r2);
		expect(list.body.current.restriction).toEqual({ level: 'none', pct: null, notice: {} });
		expect(list.body.history.map((h: { runId: string }) => h.runId)).toEqual([r2, r1]);
		expect(list.body.history[1].supersededAt).not.toBeNull();
		const current = await asOwner('SELECT count(*)::int AS n FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		expect(current).toEqual([{ n: 1 }]);
		expect((await asOwner('SELECT count(*)::int AS n FROM publication_farm WHERE project_id = $1', [projectId]))[0].n).toBe(12);
		// The runs list flags the current one.
		const runs = (await viewer.call('GET', `/projects/${projectId}/runs`)).body.runs as { id: string; published: boolean }[];
		expect(runs.find((r) => r.id === r2)!.published).toBe(true);
		expect(runs.find((r) => r.id === r1)!.published).toBe(false);
	});

	it('refuses a second current publication in the database itself', async () => {
		const [{ run_id: runId }] = await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		await expect(
			withUser(editor.id, (db) => db.query('INSERT INTO run_publication (project_id, run_id, published_by) VALUES ($1, $2, $3)', [projectId, runId, editor.id]))
		).rejects.toMatchObject({ code: '23505' });
	});

	it('lets only editors publish, and only runs of this project', async () => {
		const [{ run_id: runId }] = await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		expect((await publish(viewer, runId)).status).toBe(403);
		expect((await publish(farmer, runId)).status).toBe(403);
		expect((await publish(stranger, runId)).status).toBe(404);
		const other = await makeProject(owner, 'Elsewhere');
		const foreignRun = await run(owner, other);
		expect(await publish(editor, foreignRun)).toEqual({ status: 400, body: { error: 'no such run in this project' } });
		// And in the database: a publication naming another project's run.
		await expect(
			withUser(owner.id, async (db) => {
				await db.query('UPDATE run_publication SET superseded_at = now() WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
				await db.query('INSERT INTO run_publication (project_id, run_id, published_by) VALUES ($1, $2, $3)', [projectId, foreignRun, owner.id]);
			})
		).rejects.toMatchObject({ code: '23503' });
		// A farmer can't write a publication even past the API.
		await expect(
			withUser(farmer.id, (db) => db.query('INSERT INTO run_publication (project_id, run_id, published_by) VALUES ($1, $2, $3)', [projectId, runId, farmer.id]))
		).rejects.toMatchObject({ code: '42501' });
		expect((await owner.call('DELETE', `/projects/${other}`)).status).toBe(204);
	});

	it('refuses a stored legacy-runoff-model run', async () => {
		const legacy = await makeProject(owner, 'Legacy');
		// Saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
		const r = await run(owner, legacy);
		await makeStoredLegacyRun(r);
		const res = await publish(owner, r, {}, legacy);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/legacy runoff model/);
		expect((await owner.call('DELETE', `/projects/${legacy}`)).status).toBe(204);
	});

	it('validates the notice', async () => {
		const [{ run_id: runId }] = await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		expect((await publish(editor, runId, { restriction: { level: 'none', pct: 5 } })).status).toBe(400);
		expect((await publish(editor, runId, { restriction: { level: 'severe' } })).status).toBe(400);
		expect((await publish(editor, runId, { restriction: { level: 'advisory', notice: { en: 'x'.repeat(2001) } } })).status).toBe(400);
		expect((await publish(editor, runId, { nextExpectedOn: '2024-02-31' })).status).toBe(400);
	});
});

describe('changing the notice', () => {
	it('changes the restriction, note and next date without re-publishing, as an editor', async () => {
		const cur = (await viewer.call('GET', `/projects/${projectId}/publication`)).body.current;
		const res = await editor.call('PATCH', `/projects/${projectId}/publication/${cur.id}`, {
			restriction: { level: 'restricted', pct: 25.5, notice: { en: 'Irrigation cut by 25 %.' } },
			nextExpectedOn: null
		});
		expect(res.status).toBe(200);
		expect(res.body.publication).toMatchObject({ id: cur.id, runId: cur.runId, restriction: { level: 'restricted', pct: 25.5, notice: { en: 'Irrigation cut by 25 %.' } }, nextExpectedOn: null, updatedBy: 'Peditor' });
		expect(res.body.publication.catchmentView).toEqual(cur.catchmentView);
		expect((await viewer.call('PATCH', `/projects/${projectId}/publication/${cur.id}`, { note: 'x' })).status).toBe(403);
		expect((await farmer.call('PATCH', `/projects/${projectId}/publication/${cur.id}`, { note: 'x' })).status).toBe(403);
		expect((await editor.call('PATCH', `/projects/${projectId}/publication/${cur.id}`, {})).status).toBe(400);
		const old = (await viewer.call('GET', `/projects/${projectId}/publication`)).body.history[1];
		expect((await editor.call('PATCH', `/projects/${projectId}/publication/${old.id}`, { note: 'late' })).status).toBe(409);
	});

	it('keeps the notice’s languages of the table, drops blank ones, and refuses a code the table doesn’t list (issue #58)', async () => {
		const cur = (await viewer.call('GET', `/projects/${projectId}/publication`)).body.current;
		const at = `/projects/${projectId}/publication/${cur.id}`;
		const trimmed = await editor.call('PATCH', at, { restriction: { level: 'advisory', notice: { af: '  Besproei snags.  ', en: ' \n ' } } });
		expect(trimmed.status).toBe(200);
		expect(trimmed.body.publication.restriction.notice).toEqual({ af: 'Besproei snags.' });
		for (const notice of [{ de: 'Nachts bewässern' }, { en: 'x', xx: 'stand-in' }, { EN: 'x' }, ['x'], 'x']) {
			expect((await editor.call('PATCH', at, { restriction: { level: 'advisory', notice } })).status, JSON.stringify(notice)).toBe(400);
		}
		// The two-column shape is gone (the body is strict).
		expect((await editor.call('PATCH', at, { restriction: { level: 'advisory', noticeEn: 'x' } })).status).toBe(400);
		// Nothing above landed; null is no notice.
		expect((await viewer.call('GET', `/projects/${projectId}/publication`)).body.current.restriction.notice).toEqual({ af: 'Besproei snags.' });
		const none = await editor.call('PATCH', at, { restriction: { level: 'none', notice: null } });
		expect(none.status).toBe(200);
		expect(none.body.publication.restriction.notice).toEqual({});
		// Back as the tests below expect it.
		expect((await editor.call('PATCH', at, { restriction: cur.restriction, nextExpectedOn: cur.nextExpectedOn })).status).toBe(200);
	});

	it('refuses a notice change that a concurrent publish superseded while it waited', async () => {
		const cur = (await viewer.call('GET', `/projects/${projectId}/publication`)).body.current;
		// Hold the row as a publish would (superseding it, uncommitted), then PATCH: the PATCH passes its
		// first check, waits on the row lock, and must answer 409 once the supersession commits.
		const pg = await import('pg');
		const holder = new pg.default.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await holder.connect();
		try {
			await holder.query('BEGIN');
			await holder.query('UPDATE run_publication SET superseded_at = now() WHERE id = $1', [cur.id]);
			const patch = editor.call('PATCH', `/projects/${projectId}/publication/${cur.id}`, { note: 'raced' });
			// Wait for the real signal: the PATCH's UPDATE blocked on the row lock.
			for (;;) {
				// pg_locks (unlike another role's pg_stat_activity row) is visible to the schema owner. DB test files run one at a time.
				const { rows } = await holder.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid = ANY (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`);
				if (rows[0].n > 0) break;
			}
			await holder.query('COMMIT');
			expect(await patch).toEqual({ status: 409, body: { error: 'this publication has been superseded; change the current one' } });
		} finally {
			// Put it back as the current one for the tests below. A superseded
			// publication is frozen (067_final_states.sql), so only the schema
			// owner, with the guard off for this one statement, can undo it.
			await holder.query('ROLLBACK').catch(() => {});
			await holder.query('BEGIN');
			await holder.query('ALTER TABLE run_publication DISABLE TRIGGER run_publication_final');
			await holder.query('UPDATE run_publication SET superseded_at = NULL WHERE id = $1', [cur.id]);
			await holder.query('ALTER TABLE run_publication ENABLE TRIGGER run_publication_final');
			await holder.query('COMMIT');
			await holder.end();
		}
		expect((await asOwner('SELECT note FROM run_publication WHERE id = $1', [cur.id]))[0].note).not.toBe('raced');
	});

	it('never lets the app change what was published, only the notice', async () => {
		const cur = (await viewer.call('GET', `/projects/${projectId}/publication`)).body.current;
		for (const sql of ["UPDATE run_publication SET catchment_view = '{}' WHERE id = $1", 'UPDATE run_publication SET published_at = now() WHERE id = $1']) {
			await expect(withUser(owner.id, (db) => db.query(sql, [cur.id]))).rejects.toMatchObject({ code: '42501' });
		}
		await expect(withUser(owner.id, (db) => db.query(`UPDATE publication_farm SET view = '{}' WHERE publication_id = $1`, [cur.id]))).rejects.toMatchObject({ code: '42501' });
	});
});

describe('publications keep their runs', () => {
	it('spares published runs from the trim (positive control: an unpublished run is trimmed)', async () => {
		const unpublished = await run(editor);
		const published = (await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1', [projectId])).map((r) => r.run_id as string);
		expect(published.length).toBeGreaterThanOrEqual(2);
		const newest = await run(editor);
		const removed = await withUser(editor.id, (db) => trimRuns(db, projectId, 1));
		expect(removed).toContain(unpublished);
		for (const r of published) expect(removed).not.toContain(r);
		expect(removed).not.toContain(newest);
		const left = (await asOwner('SELECT id FROM model_run WHERE project_id = $1', [projectId])).map((r) => r.id);
		expect(left.sort()).toEqual([...published, newest].sort());
	});

	it('answers 409 to deleting a published run (positive control: an unpublished one goes)', async () => {
		const [{ run_id: runId }] = await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		expect(await editor.call('DELETE', `/projects/${projectId}/runs/${runId}`)).toEqual({ status: 409, body: { error: 'run is published: it is, or was, the published baseline, so it is kept' } });
		const loose = await run(editor);
		expect((await editor.call('DELETE', `/projects/${projectId}/runs/${loose}`)).status).toBe(204);
	});

	it('keeps the newest 12 publications, and their runs become trimmable', async () => {
		// Thirteen publications of three runs: the first run once, then the other
		// two in turn. The cap counts publications, not runs, and a model run is
		// most of a publish's cost, so thirteen runs would only slow this down.
		const p = await makeProject(owner, 'History cap', false, 60);
		const [first, a, b] = [await run(owner, p), await run(owner, p), await run(owner, p)];
		const order = [first, ...Array.from({ length: 12 }, (_, i) => (i % 2 ? b : a))];
		for (const r of order) expect((await publish(owner, r, {}, p)).status).toBe(201);
		const history = (await owner.call('GET', `/projects/${p}/publication`)).body.history as { runId: string }[];
		expect(history.map((h) => h.runId)).toEqual(order.slice(1).reverse());
		// The first run is no longer held; with a newer unpublished run and a cap of 1, it goes.
		await run(owner, p);
		const removed = await withUser(owner.id, (db) => trimRuns(db, p, 1));
		expect(removed).toEqual([first]);
		// A project with publications still deletes whole.
		expect((await owner.call('DELETE', `/projects/${p}`)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM run_publication WHERE project_id = $1', [p])).toEqual([]);
	});
});

describe('what a farmer reads', () => {
	let currentRun: string;
	beforeAll(async () => {
		currentRun = (await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]))[0].run_id;
	});

	it('shows a farmer only their own farm’s projection; a viewer sees every farm', async () => {
		const own = await rowsAs<{ node_id: string }>(farmer, 'SELECT DISTINCT node_id FROM publication_farm WHERE project_id = $1', [projectId]);
		expect(own).toEqual([{ node_id: farms[0]!.id }]);
		expect((await rowsAs(viewer, 'SELECT DISTINCT node_id FROM publication_farm WHERE project_id = $1', [projectId])).length).toBe(6);
		expect(await rowsAs(stranger, 'SELECT 1 FROM publication_farm WHERE project_id = $1', [projectId])).toEqual([]);
		// Every member reads the publication itself; a stranger doesn't.
		expect((await rowsAs(farmer, 'SELECT 1 FROM run_publication WHERE project_id = $1', [projectId])).length).toBeGreaterThan(0);
		expect(await rowsAs(stranger, 'SELECT 1 FROM run_publication WHERE project_id = $1', [projectId])).toEqual([]);
	});

	it('lets a farmer read only their farm’s allowlisted series of the current published run', async () => {
		const keys = await rowsAs<{ node_id: string; key: string; run_id: string }>(farmer, 'SELECT node_id, key, run_id FROM run_series WHERE project_id = $1', [projectId]);
		expect(new Set(keys.map((k) => k.node_id))).toEqual(new Set([farms[0]!.id]));
		expect(new Set(keys.map((k) => k.run_id))).toEqual(new Set([currentRun]));
		expect(keys.map((k) => k.key).sort()).toEqual(['dam_storage', 'deficit', 'demand', 'spill', 'supplied', 'transfer']);
		// Positive control: a viewer reads every series of every run, flows included.
		const all = await rowsAs<{ key: string }>(viewer, 'SELECT key FROM run_series WHERE project_id = $1 AND run_id = $2', [projectId, currentRun]);
		expect(all.some((r) => r.key === 'inflow_upstream')).toBe(true);
		expect(all.length).toBeGreaterThan(keys.length);
		// No model_run and no time series, published or not.
		expect(await rowsAs(farmer, 'SELECT 1 FROM model_run WHERE project_id = $1', [projectId])).toEqual([]);
	});

	it('serves the farm view of the farmer’s own farm, naming no other node', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${farms[0]!.id}`);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			project: { id: projectId, name: 'Publication' },
			farm: { nodeId: farms[0]!.id, name: 'Farm One', dataUntil: '2023-12-29', season: { from: '2023-10-01', to: '2023-12-29' } },
			context: { farmsUpstream: 2, farmsDownstream: 0, farmCount: 6 },
			publication: { publishedBy: 'Peditor', restriction: { level: 'restricted', pct: 25.5, notice: { en: 'Irrigation cut by 25 %.' } }, nextExpectedOn: null },
			outlet30: { name: 'Weir', days: 30 },
			stale: true
		});
		expect(res.body.farm.monthly).toHaveLength(12);
		expect(res.body.farm.lastSeason).toMatchObject({ from: '2022-10-01', to: '2022-12-29' });
		expect(typeof res.body.publication.engineVersion).toBe('string');
		// The response scan: no other farm's id or name, anywhere.
		const text = JSON.stringify(res.body);
		for (const f of farms.slice(1)) {
			expect(text).not.toContain(f.id);
			expect(text).not.toContain(f.name);
		}
		// Their publication list names no farm and carries no staff note.
		const pubs = await farmer.call('GET', `/projects/${projectId}/publication`);
		expect(pubs.status).toBe(200);
		expect(pubs.body.current).not.toHaveProperty('note');
		const ptext = JSON.stringify(pubs.body);
		for (const f of farms) {
			expect(ptext).not.toContain(f.id);
			expect(ptext).not.toContain(f.name);
		}
		// Positive control: the viewer's list has the note.
		expect((await viewer.call('GET', `/projects/${projectId}/publication`)).body.current).toHaveProperty('note');
	});

	it('carries the notice in both languages as the WUA wrote them (the page picks one)', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${farms[0]!.id}`);
		expect(res.body.publication.restriction).toEqual({ level: 'restricted', pct: 25.5, notice: { en: 'Irrigation cut by 25 %.' } });
	});

	it('404s a farm the farmer isn’t linked to, even with a publication (positive control: their own is 200)', async () => {
		for (const n of [farms[1]!.id, farms[3]!.id, outlet.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
			expect((await farmer.call('GET', `/projects/${projectId}/farm/${n}`)).status, n).toBe(404);
			expect((await csv(farmer, `/projects/${projectId}/farm/${n}/export.csv`)).status, n).toBe(404);
		}
		expect((await stranger.call('GET', `/projects/${projectId}/farm/${farms[0]!.id}`)).status).toBe(404);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${farms[0]!.id}`)).status).toBe(200);
		// A viewer previews any farm.
		expect((await viewer.call('GET', `/projects/${projectId}/farm/${farms[3]!.id}`)).status).toBe(200);
	});

	it('lists a farmer’s own farms and the current publication', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm`);
		expect(res.body).toEqual({
			project: { id: projectId, name: 'Publication', wuaName: null },
			farms: [{ nodeId: farms[0]!.id, name: 'Farm One' }],
			publication: { publishedAt: expect.any(String), restriction: { level: 'restricted' } }
		});
		expect((await viewer.call('GET', `/projects/${projectId}/farm`)).body.farms).toHaveLength(6);
	});

	it('downloads the farm’s own daily CSV: farm keys only, no other node', async () => {
		const res = await csv(farmer, `/projects/${projectId}/farm/${farms[0]!.id}/export.csv?from=2023-12-01`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="publication_farm-one_daily_\d{4}-\d{2}-\d{2}\.csv"$/);
		const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
		expect(lines).toHaveLength(1 + 29);
		expect(lines[1]!.startsWith('2023-12-01,')).toBe(true);
		const header = lines[0]!;
		expect(header.split(',').length).toBe(7);
		expect(header).not.toMatch(/inflow|outflow|runoff|ewr/i);
		for (const f of farms.slice(1)) expect(res.text).not.toContain(f.name);
		expect((await csv(farmer, `/projects/${projectId}/farm/${farms[0]!.id}/export.csv?from=2030-01-01`)).status).toBe(400);
	});

	// WP-2.16 abuse case "a farmer using a removed membership": access is
	// re-checked on every request (RLS reads project_member each transaction),
	// so a removed farmer's still-valid session reads nothing from the next
	// request on. Positive control: the same session reads the farm just before.
	it('ends a removed farmer’s access on their next request, with the same session', async () => {
		const removed = await signUp('Premoved');
		const farm = farms[3]!.id;
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: removed.email, nodeIds: [farm] })).status).toBe(201);
		expect((await removed.call('GET', `/projects/${projectId}/farm/${farm}`)).status).toBe(200);
		expect((await removed.call('POST', `/projects/${projectId}/notes`, { body: 'before', nodeId: farm, visibility: 'farm' })).status).toBe(201);

		expect((await owner.call('DELETE', `/projects/${projectId}/members/${removed.id}`)).status).toBe(204);

		expect((await removed.call('GET', `/projects/${projectId}/farm/${farm}`)).status).toBe(404);
		expect((await csv(removed, `/projects/${projectId}/farm/${farm}/export.csv`)).status).toBe(404);
		expect((await removed.call('GET', `/projects/${projectId}/farm`)).status).toBe(404);
		expect((await removed.call('GET', `/projects/${projectId}/publication`)).status).toBe(404);
		expect((await removed.call('GET', `/projects/${projectId}/notes`)).status).toBe(404);
		expect((await removed.call('POST', `/projects/${projectId}/notes`, { body: 'after', nodeId: farm, visibility: 'farm' })).status).toBe(404);
		expect((await removed.call('GET', '/projects')).body.projects).toEqual([]);
		expect(await rowsAs(removed, 'SELECT 1 FROM publication_farm WHERE project_id = $1', [projectId])).toEqual([]);
		expect(await rowsAs(removed, 'SELECT 1 FROM run_series WHERE project_id = $1', [projectId])).toEqual([]);
		// Their links went with the membership (farm_link → project_member ON DELETE CASCADE).
		expect(await asOwner('SELECT 1 FROM farm_link WHERE user_id = $1', [removed.id])).toEqual([]);
	});
});

describe('the aggregate rule on the even share', () => {
	const share = async (u: User, nodeId: string) =>
		(await u.call('GET', `/projects/${projectId}/farm/${nodeId}`)).body.farm.river as { equitableFraction: number | null; aboveBelowShareM3Day: number | null; cutBeyondShare: boolean };

	it('shows the even share with at least k − 1 other holders, and hides it below', async () => {
		// Farmer: the other holders are farmer2 (farm 2) and farms 3–6 unlinked = 5 ≥ 4.
		const shown = await share(farmer, farms[0]!.id);
		expect(shown.equitableFraction).not.toBeNull();
		expect(shown.aboveBelowShareM3Day).not.toBeNull();
		// Farmer2 takes farms 2–4: the others are farmer2 once, farms 5 and 6 = 3 < 4.
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${farmer2.id}`, { nodeIds: [farms[1]!.id, farms[2]!.id, farms[3]!.id] })).status).toBe(200);
		const hidden = await share(farmer, farms[0]!.id);
		expect(hidden).toMatchObject({ equitableFraction: null, aboveBelowShareM3Day: null, cutBeyondShare: false });
		// Farmer2 sees farmer (farm 1) and farms 5, 6 = 3: hidden too.
		expect((await share(farmer2, farms[2]!.id)).equitableFraction).toBeNull();
		// Stored as computed; a viewer (who links nothing: six holders) sees it.
		expect((await share(viewer, farms[0]!.id)).equitableFraction).toBe(shown.equitableFraction);
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${farmer2.id}`, { nodeIds: [farms[1]!.id] })).status).toBe(200);
	});
});

describe('a run that goes on on forecast rain', () => {
	it('projects only to the last day of observed rain, and the CSV stops there too', async () => {
		const p = await makeProject(owner, 'Forecast tail', false, 90); // observed rain to 2021-12-29
		expect((await owner.call('PUT', `/projects/${p}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2021-12-30', values: new Array(10).fill(4) })).status).toBe(200);
		// An ordinary run stops at the observed rain (WP-2.12); a forecast run goes on through the forecast.
		const ordinary = await run(owner, p);
		const res = await owner.call('POST', `/projects/${p}/runs`, { label: 'forecast', forecast: true });
		expect(res.status).toBe(201);
		const r = res.body.run.id as string;
		const metas = (await owner.call('GET', `/projects/${p}/runs`)).body.runs as { id: string; endDate: string }[];
		expect(metas.find((x) => x.id === ordinary)!.endDate).toBe('2021-12-29');
		const meta = metas.find((x) => x.id === r)!;
		expect(meta.endDate).toBe('2022-01-08');
		expect((await publish(owner, r, {}, p)).status).toBe(201);
		const farmId = (await owner.call('GET', `/projects/${p}/farm`)).body.farms[0].nodeId as string;
		const view = (await owner.call('GET', `/projects/${p}/farm/${farmId}`)).body;
		expect(view.farm.dataUntil).toBe('2021-12-29');
		expect(view.farm.season).toMatchObject({ from: '2021-10-01', to: '2021-12-29' });
		const pub = (await owner.call('GET', `/projects/${p}/publication`)).body.current;
		expect(pub.catchmentView).toMatchObject({ dataUntil: '2021-12-29', runDays: 90 });
		const file = await csv(owner, `/projects/${p}/farm/${farmId}/export.csv`);
		const lines = file.text.replace(/^﻿/, '').trim().split('\r\n');
		expect(lines).toHaveLength(1 + 90);
		expect(lines.at(-1)!.startsWith('2021-12-29,')).toBe(true);
		// The forecast's madeOn is the day the run was made where the catchment is (058): a run made at
		// 22:30 UTC was made on the next day in South Africa. Positive control: the same run in a UTC project.
		await asOwner(`UPDATE model_run SET created_at = '2026-09-25T22:30:00Z' WHERE id = $1`, [r]);
		expect((await publish(owner, r, {}, p)).status).toBe(201);
		expect((await owner.call('GET', `/projects/${p}/farm/${farmId}`)).body.farm.forecast.madeOn).toBe('2026-09-26');
		expect((await owner.call('PATCH', `/projects/${p}`, { timeZone: 'UTC' })).status).toBe(200);
		expect((await publish(owner, r, {}, p)).status).toBe(201);
		expect((await owner.call('GET', `/projects/${p}/farm/${farmId}`)).body.farm.forecast.madeOn).toBe('2026-09-25');
		expect((await owner.call('DELETE', `/projects/${p}`)).status).toBe(204);
	});
});

describe('the farm view’s freshness', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Farm One's figures run to 2023-12-29; they are stale past 7 days. At 23:30 UTC on 5 January it is
	// already the 6th in South Africa (8 days: stale), still the 5th in UTC (7 days: fresh). Only the
	// clock is faked, so the server's own zone plays no part (rule 7).
	it('counts the figures’ age to the project’s today, not UTC’s (positive control: a UTC project)', async () => {
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2024-01-05T23:30:00Z') });
		const view = async () => (await farmer.call('GET', `/projects/${projectId}/farm/${farms[0]!.id}`)).body;
		expect(await view()).toMatchObject({ farm: { dataUntil: '2023-12-29' }, stale: true });
		await asOwner(`UPDATE project SET time_zone = 'UTC' WHERE id = $1`, [projectId]);
		try {
			expect(await view()).toMatchObject({ farm: { dataUntil: '2023-12-29' }, stale: false });
		} finally {
			await asOwner(`UPDATE project SET time_zone = DEFAULT WHERE id = $1`, [projectId]);
		}
	});
});
