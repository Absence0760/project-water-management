// Read-only share links (WP-2.3 phase 2, 025_share_links.sql). Every "cannot"
// has a positive control: the owner can, a live link answers, enough farm
// holders open the series.
import { FARMER_K } from '@water-management/engine';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let unpublishedId: string;

const outlet = node('Weir', null);
const farms = [
	node('Farm Alpha', outlet.id),
	node('Farm Bravo', outlet.id),
	node('Farm Charlie', outlet.id),
	node('Farm Delta', outlet.id),
	node('Farm Echo', outlet.id),
	node('Farm Foxtrot', outlet.id)
];
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const NOTE = 'Staff only: calibrated against the 2022 gaugings';
const NOTICE = 'The river is low. Irrigate at night.';
const DAYS = 820;

async function makeProject(u: User, name: string, sharedIds: boolean) {
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
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	return id;
}

async function publish(pid: string) {
	const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	const res = await owner.call('POST', `/projects/${pid}/publication`, {
		runId: run.body.run.id,
		note: NOTE,
		restriction: { level: 'advisory', pct: 15, notice: { en: NOTICE, af: 'Die rivier is laag.' } },
		nextExpectedOn: '2024-02-01'
	});
	expect(res.status).toBe(201);
	return run.body.run.id as string;
}

const create = (pid: string, label = 'Forum', expiresInDays = 30, as: User = owner) => as.call('POST', `/projects/${pid}/share-links`, { label, expiresInDays });
const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '');
const view = (token: string) => anon('POST', '/share/view', { token });
const series = (token: string, key: string) => anon('POST', '/share/series', { token, key });

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Sowner', 'Seditor', 'Sviewer', 'Sfarmer', 'Sstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = await makeProject(owner, 'Share catchment', true);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);
	await publish(projectId);
	unpublishedId = await makeProject(owner, 'Not yet published', false);
}, 90_000);

describe('owning share links', () => {
	it('lets an owner create, list and revoke a link; the URL carries the token in its fragment, once', async () => {
		const res = await create(projectId, 'Catchment forum', 14);
		expect(res.status).toBe(201);
		const { link } = res.body;
		expect(link).toMatchObject({ label: 'Catchment forum', createdBy: 'Sowner', revokedAt: null, lastUsedAt: null });
		expect(link.url).toMatch(/^http:\/\/localhost:7777\/share#t=[A-Za-z0-9_-]{43}$/);
		const days = (Date.parse(link.expiresAt) - Date.parse(link.createdAt)) / 86_400_000;
		expect(days).toBeCloseTo(14, 5);

		const list = await owner.call('GET', `/projects/${projectId}/share-links`);
		expect(list.status).toBe(200);
		const listed = list.body.links.find((l: { id: string }) => l.id === link.id);
		expect(listed).toEqual({ id: link.id, label: 'Catchment forum', createdAt: link.createdAt, createdBy: 'Sowner', expiresAt: link.expiresAt, revokedAt: null, revokedBy: null, lastUsedAt: null, targetKind: null, targetId: null, target: null, mine: true });
		// The list never carries the token or its hash.
		expect(JSON.stringify(list.body)).not.toContain(tokenOf(link.url));
		expect(Object.keys(listed)).not.toContain('url');

		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(204);
		// Revoking again is done already.
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(204);
		const after = (await owner.call('GET', `/projects/${projectId}/share-links`)).body.links.find((l: { id: string }) => l.id === link.id);
		expect(after.revokedAt).not.toBeNull();
		expect(after.revokedBy).toBe('Sowner');
	});

	it('refuses viewers, editors and farmers (403) and strangers (404); the owner is the positive control', async () => {
		const { link } = (await create(projectId)).body;
		for (const u of [editor, viewer, farmer]) {
			expect((await u.call('GET', `/projects/${projectId}/share-links`)).status).toBe(403);
			expect((await create(projectId, 'x', 1, u)).status).toBe(403);
			expect((await u.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(403);
		}
		expect((await stranger.call('GET', `/projects/${projectId}/share-links`)).status).toBe(404);
		expect((await create(projectId, 'x', 1, stranger)).status).toBe(404);
		expect((await stranger.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${projectId}/share-links`)).status).toBe(200);
		// Still live: no refusal above revoked it.
		expect((await view(tokenOf(link.url))).status).toBe(200);
	});

	it('hides the table from everyone but owners in the database itself, and nobody deletes a link', async () => {
		const seen = async (u: User) => withUser(u.id, async (db) => (await db.query('SELECT id FROM share_link WHERE project_id = $1', [projectId])).rows.length);
		expect(await seen(owner)).toBeGreaterThan(0);
		for (const u of [editor, viewer, farmer, stranger]) expect(await seen(u)).toBe(0);
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM share_link WHERE project_id = $1', [projectId]))).rejects.toMatchObject({ code: '42501' });
		// An editor can't insert one past the API.
		await expect(
			withUser(editor.id, (db) => db.query("INSERT INTO share_link (project_id, label, token_hash, expires_at) VALUES ($1, 'x', $2, now() + interval '1 day')", [projectId, Buffer.alloc(32, 7)]))
		).rejects.toMatchObject({ code: '42501' });
	});

	it('validates the label and the lifetime', async () => {
		for (const body of [
			{ label: '', expiresInDays: 5 },
			{ label: 'x'.repeat(101), expiresInDays: 5 },
			{ label: 'ok', expiresInDays: 0 },
			{ label: 'ok', expiresInDays: 366 },
			{ label: 'ok', expiresInDays: 1.5 },
			{ label: 'ok' }
		]) {
			expect((await owner.call('POST', `/projects/${projectId}/share-links`, body)).status, JSON.stringify(body)).toBe(400);
		}
		expect((await create(projectId, 'x'.repeat(100), 365)).status).toBe(201);
		expect((await create(projectId, 'Day', 1)).status).toBe(201);
	});

	it('404s revoking another project’s link or a malformed id', async () => {
		const { link } = (await create(unpublishedId)).body;
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${link.id}`)).status).toBe(404);
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/not-a-uuid`)).status).toBe(404);
		expect((await owner.call('DELETE', `/projects/${unpublishedId}/share-links/${link.id}`)).status).toBe(204);
	});

	it('stores only the SHA-256 of the token', async () => {
		const { link } = (await create(projectId, 'Hash check')).body;
		const token = tokenOf(link.url);
		const [row] = await asOwner('SELECT * FROM share_link WHERE id = $1', [link.id]);
		expect((row.token_hash as Buffer).equals(createHash('sha256').update(token, 'utf8').digest())).toBe(true);
		const text = JSON.stringify(row, (_k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('base64url') : v));
		expect(text).not.toContain(token);
		const cols = await asOwner("SELECT column_name FROM information_schema.columns WHERE table_name = 'share_link' ORDER BY column_name");
		expect(cols.map((c) => c.column_name)).toEqual(['created_at', 'created_by', 'expires_at', 'id', 'label', 'last_used_at', 'project_id', 'revoked_at', 'revoked_by', 'target_id', 'target_kind', 'token_hash']);
		// A catchment link names no target (115_scenario_share_notes).
		expect([row.target_kind, row.target_id]).toEqual([null, null]);
	});
});

describe('what a link shows', () => {
	it('shows a live link the catchment view and the notice, signed out', async () => {
		const token = tokenOf((await create(projectId)).body.link.url);
		const res = await view(token);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body).toMatchObject({
			project: { name: 'Share catchment' },
			publication: {
				publishedBy: 'Sowner',
				restriction: { level: 'advisory', pct: 15, notice: { en: NOTICE, af: 'Die rivier is laag.' } },
				nextExpectedOn: '2024-02-01',
				catchmentView: { runStart: '2021-10-01', farmCount: 6 }
			}
		});
		const cv = res.body.publication.catchmentView;
		expect(Object.keys(cv).sort()).toEqual(['dataUntil', 'farmCount', 'last30', 'runDays', 'runStart', 'season', 'sites']);
		expect(cv.sites[0]).toEqual({ name: null, isOutlet: true, daysNotMet: { run: expect.any(Number), season: expect.any(Number), last30: expect.any(Number) } });
	});

	it('never carries the note, a farm’s name or id, or the outlet’s name', async () => {
		const token = tokenOf((await create(projectId)).body.link.url);
		const text = JSON.stringify((await view(token)).body);
		expect(text).not.toContain(NOTE);
		expect(text).not.toContain('"note"');
		for (const f of farms) {
			expect(text).not.toContain(f.name);
			expect(text).not.toContain(f.id);
		}
		expect(text).not.toContain('Weir');
		expect(text).not.toContain(outlet.id);
		// Positive control: the project's own publication does carry them for a viewer.
		const own = JSON.stringify((await viewer.call('GET', `/projects/${projectId}/publication`)).body);
		expect(own).toContain(NOTE);
		expect(own).toContain('Weir');
	});

	it('answers the same 404 for revoked, expired, unknown and malformed tokens, and for a project with nothing published', async () => {
		const live = (await create(projectId)).body.link;
		const revoked = (await create(projectId)).body.link;
		const expired = (await create(projectId)).body.link;
		const unpublished = (await create(unpublishedId)).body.link;
		expect((await owner.call('DELETE', `/projects/${projectId}/share-links/${revoked.id}`)).status).toBe(204);
		await asOwner("UPDATE share_link SET created_at = now() - interval '3 days', expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
		const dead = [tokenOf(revoked.url), tokenOf(expired.url), tokenOf(unpublished.url), 'A'.repeat(43), 'short', ''];
		for (const t of dead) {
			expect(await view(t), t).toMatchObject({ status: 404, body: { error: 'not found' } });
			expect((await series(t, 'simulated_outflow')).status, t).toBe(404);
		}
		// Positive control: the live one answers.
		expect((await view(tokenOf(live.url))).status).toBe(200);
		// And the function itself answers nothing for a dead link.
		const hash = createHash('sha256').update(tokenOf(revoked.url), 'utf8').digest();
		expect(await withUser(stranger.id, async (db) => (await db.query('SELECT * FROM app_share_view($1)', [hash])).rows)).toEqual([]);
		// Publishing the other project brings its link to life.
		await publish(unpublishedId);
		expect((await view(tokenOf(unpublished.url))).status).toBe(200);
	});

	it('bumps last_used_at at most once an hour', async () => {
		const { link } = (await create(projectId)).body;
		const token = tokenOf(link.url);
		const used = async () => (await asOwner('SELECT last_used_at FROM share_link WHERE id = $1', [link.id]))[0].last_used_at as Date | null;
		expect(await used()).toBeNull();
		await view(token);
		expect(await used()).not.toBeNull();
		await asOwner("UPDATE share_link SET last_used_at = now() - interval '30 minutes' WHERE id = $1", [link.id]);
		const half = await used();
		await view(token);
		expect((await used())!.getTime()).toBe(half!.getTime());
		await asOwner("UPDATE share_link SET last_used_at = now() - interval '2 hours' WHERE id = $1", [link.id]);
		const old = await used();
		await view(token);
		expect((await used())!.getTime()).toBeGreaterThan(old!.getTime() + 3_600_000);
		// A series read doesn't count as a visit.
		const before = await used();
		await series(token, 'ewr');
		expect((await used())!.getTime()).toBe(before!.getTime());
	});
});

describe('the series a link reads', () => {
	let token: string;
	beforeAll(async () => {
		token = tokenOf((await create(projectId)).body.link.url);
	});

	it('answers the catchment series as monthly means and the last 365 days (six holders)', async () => {
		const res = await series(token, 'simulated_outflow');
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ key: 'simulated_outflow', unit: 'm³/day', monthly: { startMonth: '2021-10' }, recent: {} });
		// 820 days from 2021-10-01 end on 2023-12-29: 27 months, and the last 365 days start 455 days in.
		expect(res.body.monthly.values).toHaveLength(27);
		expect(res.body.recent.values).toHaveLength(365);
		expect(res.body.recent.startDate).toBe('2022-12-30');
		// The means are the daily values' means (the run's own series, read as the owner).
		const [{ values }] = await asOwner("SELECT \"values\" FROM run_series rs JOIN run_publication p ON p.run_id = rs.run_id AND p.superseded_at IS NULL WHERE p.project_id = $1 AND rs.node_id IS NULL AND rs.key = 'simulated_outflow'", [projectId]);
		const oct = (values as number[]).slice(0, 31);
		expect(res.body.monthly.values[0]).toBeCloseTo(oct.reduce((a, b) => a + b, 0) / 31, 6);
		expect(res.body.recent.values.at(-1)).toBeCloseTo((values as number[]).at(-1)!, 6);
		for (const key of ['natural_flow', 'ewr', 'ewr_shortfall']) expect((await series(token, key)).status, key).toBe(200);
	});

	it('refuses every farm key and a node’s series, whatever the holders', async () => {
		for (const key of ['demand', 'supplied', 'deficit', 'dam_storage', 'spill', 'transfer', 'inflow_upstream', 'ewr_charge', 'rain_used']) {
			expect(await series(token, key), key).toMatchObject({ status: 404 });
		}
		// Straight at the function too: a farm key gets no row.
		const hash = createHash('sha256').update(token, 'utf8').digest();
		expect(await withUser(stranger.id, async (db) => (await db.query("SELECT * FROM app_share_series($1, 'demand')", [hash])).rows)).toEqual([]);
		expect((await withUser(stranger.id, async (db) => (await db.query("SELECT * FROM app_share_series($1, 'ewr')", [hash])).rows)).length).toBe(1);
	});

	it(`answers nothing below ${FARMER_K} farm holders, counting one user’s farms once, and answers again at ${FARMER_K}`, async () => {
		// app_share_series writes k as the literal 5 (SQL can't import it): the two move together.
		expect(FARMER_K).toBe(5);
		// The farmer holds farms 1–4: 1 + 2 unlinked = 3 holders.
		const set = (nodeIds: string[]) => owner.call('PUT', `/projects/${projectId}/farmers/${farmer.id}`, { nodeIds });
		expect((await set(farms.slice(0, 4).map((f) => f.id))).status).toBe(200);
		expect((await series(token, 'simulated_outflow')).status).toBe(404);
		// FARMER_K − 1 holders: still nothing.
		expect((await set(farms.slice(0, 3).map((f) => f.id))).status).toBe(200);
		expect((await series(token, 'simulated_outflow')).status).toBe(404);
		// FARMER_K holders: the farmer's two farms count once, four unlinked farms count one each.
		expect((await set(farms.slice(0, 2).map((f) => f.id))).status).toBe(200);
		expect((await series(token, 'simulated_outflow')).status).toBe(200);
		// The catchment view itself carries no volumes, so it shows at any count.
		expect((await set(farms.slice(0, 4).map((f) => f.id))).status).toBe(200);
		expect((await view(token)).status).toBe(200);
		expect((await set([farms[0]!.id])).status).toBe(200);
	});
});
