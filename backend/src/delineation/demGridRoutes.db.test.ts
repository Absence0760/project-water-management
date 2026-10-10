// The DEM grid layer's route (demGridRoutes.ts): GET
// /projects/:id/map/dem-grid?bbox= over the committed synthetic DEM. A viewer
// reads every 10th cell each way with its elevation (the point cap is
// demGrid.test.ts's); off (409) without DEM_URL; a bad or oversized bbox
// is 400; a non-member gets 404 and a farmer 403, with the owner's read as the
// positive control.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { DEM_GRID_BBOX_MAX_DEG } from './demGridRoutes.js';
import { FIXTURE_CELLS, FIXTURE_FILE, fixtureLonLat } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
const before = process.env.DEM_URL;

const outlet = node('Weir', null);
const farm = node('Farm D', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const url = (bbox: string, id = projectId) => `/projects/${id}/map/dem-grid?bbox=${encodeURIComponent(bbox)}`;
/** The middle quarter of the fixture: inside its ridge, all land. */
const [w, n] = fixtureLonLat(FIXTURE_CELLS / 4, FIXTURE_CELLS / 4);
const [e, s] = fixtureLonLat((3 * FIXTURE_CELLS) / 4, (3 * FIXTURE_CELLS) / 4);
const middle = `${w},${s},${e},${n}`;

beforeAll(async () => {
	process.env.DEM_URL = fileURLToPath(FIXTURE_FILE);
	[owner, viewer, farmer, stranger] = (await Promise.all(['DGowner', 'DGviewer', 'DGfarmer', 'DGstranger'].map((x) => signUp(x)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'DEM grid layer' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('GET /projects/:id/map/dem-grid', () => {
	it('gives a viewer every 10th DEM cell each way in the box, each its centre and whole-metre elevation, with the DEM named', async () => {
		const res = await viewer.call('GET', url(middle));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ stride: 10, tooDense: false, max: 5000, dataset: { label: expect.stringMatching(/^Synthetic DEM/), zoom: 10 } });
		expect(res.body.points.length).toBeGreaterThan(100);
		for (const [lon, lat, m] of res.body.points as [number, number, number][]) {
			expect(lon).toBeGreaterThanOrEqual(w);
			expect(lon).toBeLessThanOrEqual(e);
			expect(lat).toBeGreaterThanOrEqual(s);
			expect(lat).toBeLessThanOrEqual(n);
			expect(Number.isInteger(m)).toBe(true);
		}
		expect(res.body.cellM).toBeGreaterThan(100);
	});

	it('refuses a malformed, inverted or oversized bbox (400), with no DEM path in the answer', async () => {
		for (const bbox of ['21,-33', '20.8,-33.5,20.7,-33.4', `20,-34,${20 + DEM_GRID_BBOX_MAX_DEG + 0.1},-33.8`]) {
			const res = await viewer.call('GET', url(bbox));
			expect(res.status, bbox).toBe(400);
			expect(JSON.stringify(res.body)).not.toMatch(/pmtiles|fixtures/);
		}
	});

	it('is off (409) without a DEM', async () => {
		const keep = process.env.DEM_URL;
		process.env.DEM_URL = '';
		try {
			const res = await viewer.call('GET', url(middle));
			expect(res.status).toBe(409);
			expect(res.body.error).toMatch(/no elevation model/);
		} finally {
			process.env.DEM_URL = keep;
		}
	});

	it('is closed to a non-member (404) and to a farmer (403); the owner reads it (control)', async () => {
		expect((await stranger.call('GET', url(middle))).status).toBe(404);
		expect((await farmer.call('GET', url(middle))).status).toBe(403);
		const mine = await owner.call('GET', url(middle));
		expect(mine.status).toBe(200);
		expect(mine.body.points.length).toBeGreaterThan(100);
	});
});
