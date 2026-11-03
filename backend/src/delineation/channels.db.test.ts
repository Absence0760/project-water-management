// The elevation model's channels route (delineation/channelRoutes.ts, issue
// #374), against Postgres and the committed synthetic DEM: off without a DEM;
// editors only (a viewer 403, a stranger 404); a bad tile 400; a tile outside
// the DEM 422; a tile computed once and then served from the cache, and only
// the computed one counting against the per-account elevation-model cap, and
// finished by the time the response is back (issue #541); and its answer the
// same as the precomputed archive's (channelArchive.ts) for the tile.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { CHANNEL_ATTEMPTS, CHANNELS_HOURLY } from './attempt.js';
import { CHANNELS_FIXTURE_FILE } from '../../scripts/channels-build.js';
import { channelArchiveZxy } from './channelArchive.js';
import { clearChannelCache } from './channelRoutes.js';
import { CHANNEL_FLOOR_KM2 } from './channels.js';
import { byteSource } from './dem.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { PmtilesReader } from './pmtiles.js';

type User = Awaited<ReturnType<typeof signUp>>;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const [lon, lat] = fixtureLonLat(DAM_CELL.x + 0.5, DAM_CELL.y + 60.5);
const TILE = `${Math.floor(lon / 0.2)},${Math.floor(lat / 0.2)}`;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
const at = (q: string) => `/projects/${projectId}/map/channels?${q}`;
const attempts = async (u: User) => (await asOwner(`SELECT count(*)::int AS n FROM dem_attempt WHERE user_id = $1`, [u.id]))[0]!.n as number;
/** The attempts not yet finished: none once a response is back (the route awaits the finish, issue #541). */
const unfinished = async (u: User) => (await asOwner(`SELECT count(*)::int AS n FROM dem_attempt WHERE user_id = $1 AND finished_at IS NULL`, [u.id]))[0]!.n as number;

beforeAll(async () => {
	[editor, viewer, stranger] = (await Promise.all(['Cheditor', 'Chviewer', 'Chstranger'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await editor.call('POST', '/projects', { name: 'Channels' })).body.project.id;
	expect((await editor.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	clearChannelCache();
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('the elevation model’s channels', () => {
	it('is off without a DEM', async () => {
		process.env.DEM_URL = '';
		const r = await editor.call('GET', at(`tile=${TILE}`));
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/channels are off/);
	});

	it('draws the valley’s tile once, then serves it from the cache, counting only the computed one', async () => {
		process.env.DEM_URL = FIXTURE;
		const n0 = await attempts(editor);
		const first = await editor.call('GET', at(`tile=${TILE}`));
		expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
		// Down to the floor (0.1 km²), every line with its area: the Map shows the small ones only zoomed in.
		expect(first.body).toMatchObject({ cached: false, minKm2: CHANNEL_FLOOR_KM2, tile: TILE.split(',').map(Number) });
		expect(first.body.lines.length).toBeGreaterThan(5);
		expect(first.body.lines.some((l: { km2: number }) => l.km2 < 1)).toBe(true);
		expect(Math.max(...first.body.lines.map((l: { km2: number }) => l.km2))).toBeGreaterThan(100);
		expect(await attempts(editor)).toBe(n0 + 1);
		// In the channel tiles' own pool (307), never delineation's.
		expect((await asOwner(`SELECT kind FROM dem_attempt WHERE user_id = $1 ORDER BY started_at DESC LIMIT 1`, [editor.id]))[0]!.kind).toBe('channels');
		expect(await unfinished(editor)).toBe(0);
		const again = await editor.call('GET', at(`tile=${TILE}`));
		expect(again.body.cached).toBe(true);
		expect(again.body.lines).toEqual(first.body.lines);
		expect(await attempts(editor)).toBe(n0 + 1);
	});

	it('is for editors: a viewer 403, a stranger 404; a bad tile 400, one outside the DEM 422', async () => {
		process.env.DEM_URL = FIXTURE;
		expect((await viewer.call('GET', at(`tile=${TILE}`))).status).toBe(403);
		expect((await stranger.call('GET', at(`tile=${TILE}`))).status).toBe(404);
		expect((await editor.call('GET', at('tile=1.5,2'))).status).toBe(400);
		expect((await editor.call('GET', at(''))).status).toBe(400);
		const out = await editor.call('GET', at('tile=125,-150'));
		expect(out.status).toBe(422);
		expect(out.body.error).toMatch(/outside the elevation model/);
		expect(await unfinished(editor)).toBe(0);
	});

	it('answers, for a tile, exactly what the precomputed archive holds for it (the static source the Map reads first)', async () => {
		process.env.DEM_URL = FIXTURE;
		const r = await editor.call('GET', at(`tile=${TILE}`));
		expect(r.status).toBe(200);
		const archive = new PmtilesReader(byteSource(fileURLToPath(CHANNELS_FIXTURE_FILE)));
		const [i, j] = TILE.split(',').map(Number) as [number, number];
		const stored = JSON.parse(new TextDecoder().decode((await archive.getTile(...channelArchiveZxy([i, j])))!));
		const { cached: _cached, ...answer } = r.body;
		expect(answer).toEqual(stored);
		expect(stored.lines.length).toBeGreaterThan(5);
	});

	it('past their own hourly pool, new tiles are paused, and a delineation still succeeds (it has its own)', async () => {
		process.env.DEM_URL = FIXTURE;
		const u = await signUp('Chpaused');
		const pid = (await u.call('POST', '/projects', { name: 'Channels paused' })).body.project.id;
		await asOwner(
			`INSERT INTO dem_attempt (user_id, kind, started_at, finished_at) SELECT $1, 'channels', now() - interval '10 minutes', now() - interval '10 minutes' FROM generate_series(1, $2)`,
			[u.id, CHANNEL_ATTEMPTS.perHour]
		);
		clearChannelCache();
		const tile = await u.call('GET', `/projects/${pid}/map/channels?tile=${TILE}`);
		expect(tile.status).toBe(429);
		expect(tile.body).toMatchObject({ error: expect.stringMatching(/DEM rivers paused for this hour.*delineation still works/), details: { reason: CHANNELS_HOURLY } });
		// Positive control: the delineation the editor came to run.
		const [olon, olat] = fixtureLonLat(OUTLET_CELL.x + 0.5, OUTLET_CELL.y + 0.5);
		const del = await u.call('POST', `/projects/${pid}/map/delineation`, { lon: olon, lat: olat, from: 'outlet' });
		expect(del.status, JSON.stringify(del.body).slice(0, 300)).toBe(201);
		const pools = await asOwner(`SELECT kind, count(*)::int AS n FROM dem_attempt WHERE user_id = $1 GROUP BY kind ORDER BY kind`, [u.id]);
		expect(pools).toEqual([
			{ kind: 'channels', n: CHANNEL_ATTEMPTS.perHour },
			{ kind: 'delineation', n: 1 }
		]);
	});
});
