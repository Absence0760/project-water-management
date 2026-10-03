// Sub-catchments from clicks on the rivers (delineation/clicks.ts), end to
// end against Postgres and the committed synthetic DEM (backend/fixtures/dem/):
//  - off (DEM_URL empty): 409 with a sentence;
//  - an editor's clicks come back as one piece each, in click order, the
//    pieces tiling the valley, and nothing is stored;
//  - a viewer can't ask, a stranger gets 404, a refusal is 422 with its reason;
//  - save routes the clicks again and saves one "other" polygon per piece,
//    named by its click, with the provenance in its description, and audits
//    it without a polygon;
//  - the per-account cap on elevation-model work counts every request.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { DEM_ATTEMPTS } from './attempt.js';
import { BASIN_AREA_M2, DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;

const at = (p: string) => `/projects/${projectId}${p}`;
const point = (x: number, y: number) => {
	const [lon, lat] = fixtureLonLat(x + 0.5, y + 0.5);
	return { lon, lat };
};
const OUTLET = point(OUTLET_CELL.x, OUTLET_CELL.y);
const DAM = point(DAM_CELL.x, DAM_CELL.y + 1);
const near = (a: number, b: number, tol: number) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Cowner', 'Ceditor', 'Cviewer', 'Cstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Clicks' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('sub-catchments off', () => {
	it('refuses clicks with a sentence while DEM_URL is empty', async () => {
		process.env.DEM_URL = '';
		const res = await editor.call('POST', at('/map/subcatchments'), { clicks: [OUTLET] });
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/Sub-catchments are off/);
	});
});

describe('sub-catchments from clicks (synthetic DEM)', () => {
	beforeAll(() => {
		process.env.DEM_URL = FIXTURE;
	});

	it('gives each click its own piece, in click order, tiling the valley, and stores nothing', async () => {
		const res = await editor.call('POST', at('/map/subcatchments'), { clicks: [DAM, OUTLET] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const r = res.body;
		expect(r.lowest).toBe(1);
		expect(r.pieces.map((p: { click: number; drainsInto: number | null }) => [p.click, p.drainsInto])).toEqual([
			[0, 1],
			[1, null]
		]);
		const [dam, low] = r.pieces;
		near(dam.areaM2 + low.areaM2, BASIN_AREA_M2, 0.04);
		near(low.totalAreaM2, dam.areaM2 + low.areaM2, 0.01);
		expect(dam.geometry.type).toBe('Polygon');
		expect(r.dataset.label).toMatch(/Synthetic DEM/);
		expect(r.methodVersion).toBe('start-12');
		const stored = await asOwner(`SELECT count(*)::integer AS n FROM map_feature WHERE project_id = $1`, [projectId]);
		expect(stored[0]!.n).toBe(0);
	});

	it('lets no viewer or stranger ask, and refuses a click off the DEM with 422 and a sentence', async () => {
		expect((await viewer.call('POST', at('/map/subcatchments'), { clicks: [OUTLET] })).status).toBe(403);
		expect((await viewer.call('POST', at('/map/subcatchments/save'), { clicks: [OUTLET] })).status).toBe(403);
		expect((await stranger.call('POST', at('/map/subcatchments'), { clicks: [OUTLET] })).status).toBe(404);
		const off = await editor.call('POST', at('/map/subcatchments'), { clicks: [{ lon: 25, lat: -30 }] });
		expect(off.status).toBe(422);
		expect(off.body.error).toMatch(/^The clicks are outside the elevation model/);
	});

	it('saves one area per piece, named by its click, from the server’s own routing, and audits it without a polygon', async () => {
		const res = await editor.call('POST', at('/map/subcatchments/save'), { clicks: [DAM, OUTLET] });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.features.map((f: { kind: string; name: string }) => [f.kind, f.name])).toEqual([
			['other', 'Sub-catchment 1'],
			['other', 'Sub-catchment 2']
		]);
		expect(res.body.summary).toMatch(/^2 sub-catchments, [\d.]+ km² in all$/);
		const rows = (await asOwner(
			`SELECT name, properties->>'description' AS description, area_m2 FROM map_feature WHERE project_id = $1 ORDER BY name`,
			[projectId]
		)) as { name: string; description: string; area_m2: number }[];
		// The upper piece holds the valley's pan: its description says how much of it drains there (start-11).
		expect(rows[0]!.description).toMatch(/drains into sub-catchment 2; .* km² upstream in all\. [\d.]+ km² of its own area drains into pans \(non-contributing in WR2012’s sense; still in its area\)\. Delineated from Synthetic DEM.*\(start-12\)/);
		expect(rows[1]!.description).toMatch(/the lowest click/);
		near(rows[0]!.area_m2 + rows[1]!.area_m2, BASIN_AREA_M2, 0.04);
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.subcatchments_saved'`, [projectId]);
		expect(audit[0]!.subject).toMatchObject({ pieces: 2, methodVersion: 'start-12', featureIds: res.body.features.map((f: { id: string }) => f.id) });
		expect(JSON.stringify(audit[0]!.subject)).not.toMatch(/coordinates/);
	});

	it('counts every request against the per-account cap on elevation-model work', async () => {
		const u = await signUp('Ccapped');
		const pid = (await u.call('POST', '/projects', { name: 'Capped' })).body.project.id;
		await asOwner(
			`INSERT INTO dem_attempt (user_id, kind, started_at, finished_at) SELECT $1, 'delineation', now(), now() FROM generate_series(1, $2)`,
			[u.id, DEM_ATTEMPTS.perHour]
		);
		const res = await u.call('POST', `/projects/${pid}/map/subcatchments`, { clicks: [OUTLET] });
		expect(res.status).toBe(429);
	});
});
