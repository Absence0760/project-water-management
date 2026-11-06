// Sub-catchments from clicks on the rivers (delineation/clicks.ts), end to
// end against Postgres and the committed synthetic DEM (backend/fixtures/dem/):
//  - off (DEM_URL empty): 409 with a sentence;
//  - an editor's clicks come back as one piece each, in click order, the
//    pieces tiling the valley, and nothing is stored;
//  - a viewer can't ask, a stranger gets 404, a refusal is 422 with its reason;
//  - save routes the clicks again and saves one "other" polygon per piece,
//    named by its click, with the provenance in its description, and audits
//    it without a polygon;
//  - the per-account cap on elevation-model work counts every request;
//  - within a catchment boundary: a click outside it is refused naming it
//    (before any elevation-model work), one inside works (positive control);
//    a boundary from Delineate puts its outlet's piece below the clicks, and
//    Save saves it too; a boundary drawn by hand keeps the lowest click;
//  - what is already on the map: a later Save routes the saved pieces again
//    with its clicks, so a downstream piece saved first is redrawn without the
//    upstream land a later click takes (its area too), and a downstream click
//    after an upstream piece stops at it, leaving it as it was.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { pointInGeometry } from '../geo/geojson.js';
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
		expect(r.methodVersion).toBe('start-18');
		const stored = await asOwner(`SELECT count(*)::integer AS n FROM map_feature WHERE project_id = $1`, [projectId]);
		expect(stored[0]!.n).toBe(0);
	});

	it('puts each click on the channels the Map drew at its zoom (its minKm2), named in the method, and refuses a non-number', async () => {
		const mixed = await editor.call('POST', at('/map/subcatchments'), { clicks: [{ ...DAM, minKm2: 0.25 }, OUTLET] });
		expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
		expect(mixed.body.method).toMatch(/with at least 0\.25 or 1 km² \(the channels the Map drew at each click’s zoom\) draining through it/);
		// Positive control: all at one zoom, one figure.
		const one = await editor.call('POST', at('/map/subcatchments'), { clicks: [{ ...DAM, minKm2: 0.1 }, { ...OUTLET, minKm2: 0.1 }] });
		expect(one.body.method).toMatch(/with at least 0\.1 km² draining through it/);
		expect((await editor.call('POST', at('/map/subcatchments'), { clicks: [{ ...DAM, minKm2: 'small' }] })).status).toBe(400);
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
		expect(rows[0]!.description).toMatch(/drains into sub-catchment 2; .* km² upstream in all\. [\d.]+ km² of its own area drains into pans \(non-contributing in WR2012’s sense; still in its area\)\. Delineated from Synthetic DEM.*\(start-18\)/);
		expect(rows[1]!.description).toMatch(/the lowest click/);
		near(rows[0]!.area_m2 + rows[1]!.area_m2, BASIN_AREA_M2, 0.04);
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.subcatchments_saved'`, [projectId]);
		expect(audit[0]!.subject).toMatchObject({ pieces: 2, methodVersion: 'start-18', featureIds: res.body.features.map((f: { id: string }) => f.id) });
		expect(JSON.stringify(audit[0]!.subject)).not.toMatch(/coordinates/);
		// Each piece keeps what of it drains into pans (195): the upper one the pan's catchment, the lower none.
		const [upper, lower] = res.body.features as { id: string; areaM2: number; nonContributingM2: number }[];
		expect(upper!.nonContributingM2).toBeGreaterThan(0);
		expect(upper!.nonContributingM2).toBeLessThan(upper!.areaM2);
		expect(lower!.nonContributingM2).toBe(0);

		// Use this area on a saved piece: gross by default (unchanged), effective when asked.
		const weir = node('Weir', null);
		const unit = node('Upper unit', weir.id, { areaKm2: 1 });
		expect((await owner.call('PUT', at('/model'), { nodes: [weir, unit], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const url = at(`/nodes/${unit.id}/area-from-map`);
		const gross = await editor.call('POST', url, { featureId: upper!.id });
		expect(gross.status, JSON.stringify(gross.body)).toBe(200);
		expect(gross.body).toMatchObject({ areaBasis: 'gross' });
		expect(gross.body.areaKm2).toBeCloseTo(upper!.areaM2 / 1e6, 9);
		const eff = await editor.call('POST', url, { featureId: upper!.id, basis: 'effective' });
		expect(eff.status, JSON.stringify(eff.body)).toBe(200);
		expect(eff.body).toMatchObject({ areaBasis: 'effective' });
		expect(eff.body.areaKm2).toBeCloseTo((upper!.areaM2 - upper!.nonContributingM2) / 1e6, 9);
		const [n] = await asOwner('SELECT area_basis FROM node WHERE id = $1', [unit.id]);
		expect(n!.area_basis).toBe('effective');
		// The lower piece holds no pan: its effective area is its gross one.
		const low = await editor.call('POST', url, { featureId: lower!.id, basis: 'effective' });
		expect(low.status).toBe(200);
		expect(low.body.areaKm2).toBeCloseTo(lower!.areaM2 / 1e6, 9);
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

describe('sub-catchments within the catchment boundary (synthetic DEM)', () => {
	beforeAll(() => {
		process.env.DEM_URL = FIXTURE;
	});
	const newProject = async (name: string) => {
		const id = (await editor.call('POST', '/projects', { name })).body.project.id as string;
		return (p: string) => `/projects/${id}${p}`;
	};
	const attempts = async () => (await asOwner(`SELECT count(*)::int AS n FROM dem_attempt WHERE user_id = $1`, [editor.id]))[0]!.n as number;
	/** Below the outlet, on the river past the valley's southern rim: outside any boundary round the valley. */
	const BELOW = point(OUTLET_CELL.x, OUTLET_CELL.y + 40);

	it('from Delineate: the outlet is the lowest point, its piece the land between the clicks and it, a click outside refused naming the catchment', async () => {
		const q = await newProject('Clicks, delineated');
		const d = await editor.call('POST', q('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(d.status, JSON.stringify(d.body)).toBe(201);
		expect((await editor.call('POST', q(`/map/delineation/${d.body.proposal.id}/accept`), { as: 'catchment_boundary' })).status).toBe(200);
		await asOwner(`UPDATE map_feature SET name = 'Valley' WHERE kind = 'catchment_boundary' AND project_id = (SELECT project_id FROM delineation_proposal WHERE id = $1)`, [d.body.proposal.id]);

		// Outside: refused with the catchment's name, before the elevation model is read (no attempt counted).
		const before = await attempts();
		const out = await editor.call('POST', q('/map/subcatchments'), { clicks: [DAM, BELOW] });
		expect(out.status).toBe(422);
		expect(out.body.error).toBe('Click 2 is outside “Valley”, the catchment boundary: every sub-catchment lies within it. Click a terrain channel inside the boundary.');
		expect(await attempts()).toBe(before);
		expect((await editor.call('POST', q('/map/subcatchments/save'), { clicks: [BELOW] })).status).toBe(422);

		// Inside (the positive control): the outlet's piece below the click's, together the delineated catchment.
		const res = await editor.call('POST', q('/map/subcatchments'), { clicks: [DAM] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.lowest).toBe(-1);
		expect(res.body.within).toMatchObject({ name: 'Valley', outlet: 'delineation' });
		expect(res.body.pieces.map((p: { click: number; drainsInto: number | null }) => [p.click, p.drainsInto])).toEqual([
			[-1, null],
			[0, -1]
		]);
		expect(res.body.pieces[0].point).toEqual(d.body.proposal.outlet);
		near(res.body.pieces[0].areaM2 + res.body.pieces[1].areaM2, d.body.proposal.areaM2, 0.02);

		const saved = await editor.call('POST', q('/map/subcatchments/save'), { clicks: [DAM] });
		expect(saved.status, JSON.stringify(saved.body)).toBe(201);
		expect(saved.body.features.map((f: { kind: string; name: string }) => [f.kind, f.name])).toEqual([
			['other', 'Sub-catchment at the outlet'],
			['other', 'Sub-catchment 1']
		]);
		expect(saved.body.features[0].properties.description).toMatch(/the catchment’s delineated outlet/);
	});

	it('drawn by hand: a click outside refused, one inside divides as before with the lowest click as the outlet', async () => {
		const q = await newProject('Clicks, drawn');
		const ring = [point(OUTLET_CELL.x - 100, OUTLET_CELL.y - 250), point(OUTLET_CELL.x + 100, OUTLET_CELL.y - 250), point(OUTLET_CELL.x + 100, OUTLET_CELL.y + 5), point(OUTLET_CELL.x - 100, OUTLET_CELL.y + 5)].map((c) => [c.lon, c.lat]);
		const b = await editor.call('POST', q('/map/features'), { kind: 'catchment_boundary', name: '', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
		expect(b.status, JSON.stringify(b.body)).toBe(201);
		const out = await editor.call('POST', q('/map/subcatchments'), { clicks: [BELOW] });
		expect(out.status).toBe(422);
		expect(out.body.error).toMatch(/^Click 1 is outside the catchment boundary/);
		const res = await editor.call('POST', q('/map/subcatchments'), { clicks: [DAM, OUTLET] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.lowest).toBe(1);
		expect(res.body.within).toMatchObject({ featureId: b.body.feature.id, outlet: 'lowest' });
		expect(res.body.pieces.map((p: { click: number }) => p.click)).toEqual([0, 1]);
	});

	it('with no boundary, reports none and divides as before (its project above)', async () => {
		const res = await editor.call('POST', at('/map/subcatchments'), { clicks: [DAM, OUTLET] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.within).toBeNull();
		expect(res.body.lowest).toBe(1);
	});
});

describe('sub-catchments already on the map (synthetic DEM)', () => {
	beforeAll(() => {
		process.env.DEM_URL = FIXTURE;
	});
	/** Just below the dam wall, and on the river halfway from the dam to the outlet. */
	const UP = DAM;
	const DOWN = point(OUTLET_CELL.x, OUTLET_CELL.y - 50);
	const ABOVE = (() => {
		const p = point(DAM_CELL.x, DAM_CELL.y - 60);
		return [p.lon, p.lat] as [number, number];
	})();
	const delineated = async (name: string) => {
		const pid = (await editor.call('POST', '/projects', { name })).body.project.id as string;
		const q = (p: string) => `/projects/${pid}${p}`;
		const d = await editor.call('POST', q('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(d.status, JSON.stringify(d.body)).toBe(201);
		expect((await editor.call('POST', q(`/map/delineation/${d.body.proposal.id}/accept`), { as: 'catchment_boundary' })).status).toBe(200);
		return { pid, q, areaM2: d.body.proposal.areaM2 as number };
	};
	type Row = { id: string; name: string; area_m2: number; geometry: { type: 'Polygon'; coordinates: [number, number][][] }; properties: { subcatchment?: unknown } };
	const pieces = async (pid: string) =>
		(await asOwner(`SELECT id, name, area_m2, geometry, properties FROM map_feature WHERE project_id = $1 AND kind = 'other' ORDER BY name`, [pid])) as Row[];

	it('downstream first, upstream second: the saved downstream piece is redrawn without the upstream land, its area with it', async () => {
		const { pid, q, areaM2 } = await delineated('Clicks, down then up');
		const reference = (await editor.call('POST', q('/map/subcatchments'), { clicks: [DOWN, UP] })).body as { pieces: { click: number; areaM2: number }[] };
		const [refDown, refUp] = [0, 1].map((k) => reference.pieces.find((p) => p.click === k)!.areaM2) as [number, number];

		const first = await editor.call('POST', q('/map/subcatchments/save'), { clicks: [DOWN] });
		expect(first.status, JSON.stringify(first.body)).toBe(201);
		expect(first.body.redrawn).toEqual([]);
		const down = first.body.features.find((f: { name: string }) => f.name === 'Sub-catchment 1');
		near(down.areaM2, refDown + refUp, 0.01);
		expect(pointInGeometry(ABOVE, down.geometry)).toBe(true);
		expect((await pieces(pid)).find((r) => r.id === down.id)!.properties.subcatchment).toEqual({ outlet: expect.any(Array) });

		// The preview already shows it split, named after it, with the new click numbered on from it.
		const preview = await editor.call('POST', q('/map/subcatchments'), { clicks: [UP] });
		expect(preview.status, JSON.stringify(preview.body)).toBe(200);
		expect(preview.body.firstNumber).toBe(2);
		expect(preview.body.pieces.map((p: { name: string; feature: { id: string } | null }) => [p.name, p.feature !== null])).toEqual([
			['Sub-catchment 1', true],
			['Sub-catchment at the outlet', true],
			['Sub-catchment 2', false]
		]);

		const second = await editor.call('POST', q('/map/subcatchments/save'), { clicks: [UP] });
		expect(second.status, JSON.stringify(second.body)).toBe(201);
		expect(second.body.features.map((f: { name: string }) => f.name)).toEqual(['Sub-catchment 2']);
		expect(second.body.redrawn.map((f: { id: string }) => f.id)).toEqual([down.id]);
		expect(second.body.summary).toMatch(/^1 sub-catchment, [\d.]+ km² in all; Sub-catchment 1 redrawn \([\d.]+ km² → [\d.]+ km²\)$/);
		const rows = await pieces(pid);
		expect(rows.map((r) => r.name)).toEqual(['Sub-catchment 1', 'Sub-catchment 2', 'Sub-catchment at the outlet']);
		const [d2, u2, o2] = rows as [Row, Row, Row];
		near(d2.area_m2, refDown, 0.01);
		near(u2.area_m2, refUp, 0.01);
		expect(pointInGeometry(ABOVE, d2.geometry)).toBe(false);
		expect(pointInGeometry(ABOVE, u2.geometry)).toBe(true);
		// No land counted twice: the three tile the delineated catchment.
		near(d2.area_m2 + u2.area_m2 + o2.area_m2, areaM2, 0.02);
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.subcatchments_saved' ORDER BY created_at DESC LIMIT 1`, [pid]);
		expect(audit[0]!.subject).toMatchObject({ pieces: 1, redrawn: [{ featureId: down.id }] });
	});

	it('upstream first, downstream second: the new downstream piece stops at the saved one, which is left as it was', async () => {
		const { pid, q, areaM2 } = await delineated('Clicks, up then down');
		const first = await editor.call('POST', q('/map/subcatchments/save'), { clicks: [UP] });
		expect(first.status, JSON.stringify(first.body)).toBe(201);
		const up = first.body.features.find((f: { name: string }) => f.name === 'Sub-catchment 1');
		const second = await editor.call('POST', q('/map/subcatchments/save'), { clicks: [DOWN] });
		expect(second.status, JSON.stringify(second.body)).toBe(201);
		expect(second.body.features.map((f: { name: string }) => f.name)).toEqual(['Sub-catchment 2']);
		// The outlet's piece gave up the land between the dam and DOWN: it is redrawn; the upstream piece isn't.
		expect(second.body.redrawn.map((f: { name: string }) => f.name)).toEqual(['Sub-catchment at the outlet']);
		const rows = await pieces(pid);
		const u = rows.find((r) => r.id === up.id)!;
		const d = rows.find((r) => r.name === 'Sub-catchment 2')!;
		expect(u.area_m2).toBe(up.areaM2);
		expect(pointInGeometry(ABOVE, d.geometry)).toBe(false);
		near(rows.reduce((s, r) => s + r.area_m2, 0), areaM2, 0.02);
	});

	it('leaves pieces alone without a catchment boundary (positive control: the same clicks there save afresh)', async () => {
		const pid = (await editor.call('POST', '/projects', { name: 'Clicks, no boundary' })).body.project.id as string;
		const q = (p: string) => `/projects/${pid}${p}`;
		expect((await editor.call('POST', q('/map/subcatchments/save'), { clicks: [DOWN, OUTLET] })).status).toBe(201);
		const again = await editor.call('POST', q('/map/subcatchments'), { clicks: [UP, OUTLET] });
		expect(again.status, JSON.stringify(again.body)).toBe(200);
		expect(again.body.pieces.every((p: { feature: unknown }) => p.feature === null)).toBe(true);
		expect(again.body.firstNumber).toBe(1);
	});
});

