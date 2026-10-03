// The elevation model's channels route (delineation/channelRoutes.ts, issue
// #374), against Postgres and the committed synthetic DEM: off without a DEM;
// editors only (a viewer 403, a stranger 404); a bad tile 400; a tile outside
// the DEM 422; a tile computed once and then served from the cache, and only
// the computed one counting against the per-account elevation-model cap.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { clearChannelCache } from './channelRoutes.js';
import { DAM_CELL, fixtureLonLat } from './fixture.js';

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
		expect(first.body).toMatchObject({ cached: false, minKm2: 1, tile: TILE.split(',').map(Number) });
		expect(first.body.lines.length).toBeGreaterThan(5);
		expect(Math.max(...first.body.lines.map((l: { km2: number }) => l.km2))).toBeGreaterThan(100);
		expect(await attempts(editor)).toBe(n0 + 1);
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
	});
});
