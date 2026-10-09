// Each unit's MAP from the MAP grid (geo/unitMapRoutes.ts, geo/unitMap.ts):
// GET/POST /projects/:id/map/unit-map over two invented grids loaded here, a
// fine one (0.01°) and a coarse one (0.1°), far from the committed synthetic
// grid's region Z so only these two can cover the units. An editor sees the
// proposal (the positive control), a viewer is refused and a stranger meets
// 404; the finest grid covering every unit is chosen, else the one covering
// the most, with the units it misses listed and never filled from the other;
// an apply writes mapMm and mapSource as one model revision (History),
// refuses an uncovered or unknown unit, an unknown grid, and an apply that
// would leave units on two grids. The synthetic grid (region Z) is proposed
// only when no real grid covers any unit. Synthetic geometry and values only.
//
// The MAP grids are global: rainMap.db.test.ts's 0.25° 'coarse-test' grid,
// left loaded after that file, covers region Z, so this file removes it
// first (its own beforeAll loads it again) and removes its own grids after.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticMapGrid } from '../../scripts/import-map-grid.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { replaceRainMapDataset, type RainMapGrid } from './rainMap.js';

type User = Awaited<ReturnType<typeof signUp>>;

const FINE = 'um-fine-test';
const COARSE = 'um-coarse-test';
const REAL_Z = 'um-real-z-test';

/** 0.01° cells over 25.00–25.20 E, 30.20–30.00 S: MAP rising 10 mm a column eastwards, 405 … 595 mm. */
function fineGrid(): RainMapGrid {
	const cells: RainMapGrid['cells'] = [];
	for (let row = -3020; row < -3000; row++) for (let col = 2500; col < 2520; col++) cells.push({ row, col, mapMm: 405 + (col - 2500) * 10 });
	return { cellDeg: 0.01, originLon: 0, originLat: 0, cells };
}
/** 0.1° cells over 25.0–25.3 E, 30.2–30.0 S: 700, 800 and 900 mm by column. */
function coarseGrid(): RainMapGrid {
	const cells: RainMapGrid['cells'] = [];
	for (let row = -302; row < -300; row++) for (let col = 250; col < 253; col++) cells.push({ row, col, mapMm: 700 + (col - 250) * 100 });
	return { cellDeg: 0.1, originLon: 0, originLat: 0, cells };
}

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
/** Inside both grids: 4 × 4 fine cells (425, 435, 445, 455 mm by column), one coarse cell (700 mm). */
const PARCEL_A = { type: 'Polygon', coordinates: [ring(25.02, -30.1, 25.06, -30.06)] };
/** Past the fine grid's east edge, inside the coarse grid's third column (900 mm). */
const PARCEL_B = { type: 'Polygon', coordinates: [ring(25.22, -30.1, 25.26, -30.06)] };
/** Outside both grids. */
const PARCEL_C = { type: 'Polygon', coordinates: [ring(26.02, -30.1, 26.06, -30.06)] };
/** Beside unit A, inside both grids too: 4 × 4 fine cells (465 … 495 mm), the same coarse cell. */
const PARCEL_A2 = { type: 'Polygon', coordinates: [ring(25.06, -30.1, 25.1, -30.06)] };
/** In the synthetic grid's region Z; the first inside the real 0.05° test grid there too, the second not. */
const PARCEL_Z1 = { type: 'Polygon', coordinates: [ring(21.31, -33.69, 21.33, -33.67)] };
const PARCEL_Z2 = { type: 'Polygon', coordinates: [ring(21.45, -33.69, 21.47, -33.67)] };

/** A real (not synthetic) 0.05° grid over 21.30–21.35 E, 33.70–33.65 S only: one cell, 650 mm. */
const REAL_Z_GRID: RainMapGrid = { cellDeg: 0.05, originLon: 0, originLat: 0, cells: [{ row: -674, col: 426, mapMm: 650 }] };

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['UMowner', 'UMeditor', 'UMviewer', 'UMstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await replaceRainMapDataset(client, { dataset: FINE, source: 'Invented fine MAP grid', version: '1', attribution: 'test' }, fineGrid());
		await replaceRainMapDataset(client, { dataset: COARSE, source: 'Invented coarse MAP grid', version: '2', attribution: 'test' }, coarseGrid());
		await replaceRainMapDataset(client, { dataset: REAL_Z, source: 'Invented real-labelled grid over region Z', version: '1', attribution: 'test' }, REAL_Z_GRID);
		await client.query(`DELETE FROM rain_map_dataset WHERE dataset = 'coarse-test'`);
	} finally {
		await client.end();
	}
	await loadSyntheticMapGrid(process.env.TEST_MIGRATION_DATABASE_URL!);
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM rain_map_dataset WHERE dataset = ANY($1::text[])', [[FINE, COARSE, REAL_Z]]);
});

/** A project with an outlet, a water user, and the land units named, each with its parcel (null: none). */
async function project(name: string, parcels: Record<string, unknown | null>) {
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
	}
	const outlet = node('Outlet', null);
	const units = Object.keys(parcels).map((n) => node(n, outlet.id));
	const town = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: Array(12).fill(100) });
	expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [outlet, ...units, town], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [i, g] of Object.values(parcels).entries()) {
		if (!g) continue;
		const r = await editor.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: `P${i}`, nodeId: units[i]!.id, geometry: g });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	}
	// The water user's parcel never makes it a land unit.
	expect((await editor.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: 'Town', nodeId: town.id, geometry: PARCEL_A })).status).toBe(201);
	const id = Object.fromEntries(units.map((u) => [u.name, u.id])) as Record<string, string>;
	return { pid, id };
}
const at = (pid: string, dataset?: string) => `/projects/${pid}/map/unit-map${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ''}`;
const mine = (cs: { label: string; covered: number }[]) => cs.filter((c) => c.label === FINE || c.label === COARSE);
const revisions = async (pid: string) => asOwner('SELECT source, reason FROM model_revision WHERE project_id = $1 ORDER BY created_at, id', [pid]);

describe('GET /projects/:id/map/unit-map', () => {
	it('gives an editor the finest grid that covers every unit; a viewer is refused and a stranger meets 404', async () => {
		const { pid, id } = await project('Unit MAP fine', { 'Unit A': PARCEL_A, 'Unit N': null });
		expect((await viewer.call('GET', at(pid))).status).toBe(403);
		expect((await stranger.call('GET', at(pid))).status).toBe(404);
		expect((await stranger.call('POST', at(pid), { dataset: FINE })).status).toBe(404);
		expect((await viewer.call('POST', at(pid), { dataset: FINE })).status).toBe(403);

		// Positive control: an editor sees it. Both grids cover unit A; the finer is chosen.
		const res = await editor.call('GET', at(pid));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const p = res.body;
		expect(p.dataset).toMatchObject({ label: FINE, version: '1', source: 'Invented fine MAP grid', cellDeg: 0.01, synthetic: false });
		expect(p.coversAll).toBe(true);
		expect(p.units).toHaveLength(1);
		// Four equal columns of 425, 435, 445, 455 mm: 440 mm over 16 cells.
		expect(p.units[0]).toMatchObject({ nodeId: id['Unit A'], name: 'Unit A', mapMm: 440, cells: 16, current: { mapMm: null, mapSource: null }, same: false });
		expect(p.units[0].coveredShare).toBeCloseTo(1, 6);
		expect(p.uncovered).toEqual([]);
		expect(p.withoutPolygon).toEqual([{ nodeId: id['Unit N'], name: 'Unit N' }]);
		expect(p.refused).toEqual([]);
		expect(mine(p.candidates)).toEqual([
			{ label: FINE, version: '1', cellDeg: 0.01, synthetic: false, covered: 1, missing: [] },
			{ label: COARSE, version: '2', cellDeg: 0.1, synthetic: false, covered: 1, missing: [] }
		]);
	});

	it('takes a coarser grid when only it covers every unit, never mixing the two', async () => {
		const { pid, id } = await project('Unit MAP coarse', { 'Unit A': PARCEL_A, 'Unit B': PARCEL_B });
		const p = (await editor.call('GET', at(pid))).body;
		expect(p.dataset.label).toBe(COARSE);
		expect(p.coversAll).toBe(true);
		// Unit A from the coarse grid too (700 mm), though the fine grid covers it.
		expect(p.units.map((u: { name: string; mapMm: number; cells: number }) => [u.name, u.mapMm, u.cells])).toEqual([
			['Unit A', 700, 1],
			['Unit B', 900, 1]
		]);
		expect(mine(p.candidates)[0]).toMatchObject({ label: FINE, covered: 1, missing: [{ nodeId: id['Unit B'], name: 'Unit B' }] });
	});

	it('with no grid covering every unit, proposes the one covering the most and lists the units it misses; another grid can be asked for', async () => {
		const { pid, id } = await project('Unit MAP partial', { 'Unit A': PARCEL_A, 'Unit B': PARCEL_B, 'Unit C': PARCEL_C });
		const p = (await editor.call('GET', at(pid))).body;
		expect(p.dataset.label).toBe(COARSE);
		expect(p.coversAll).toBe(false);
		expect(p.units.map((u: { name: string }) => u.name)).toEqual(['Unit A', 'Unit B']);
		expect(p.uncovered).toEqual([{ nodeId: id['Unit C'], name: 'Unit C', coveredShare: 0, reason: 'the grid has no value inside the unit’s parcel' }]);
		expect(mine(p.candidates).map((c: { label: string; covered: number }) => [c.label, c.covered])).toEqual([
			[FINE, 1],
			[COARSE, 2]
		]);

		const fine = (await editor.call('GET', at(pid, FINE))).body;
		expect(fine.dataset.label).toBe(FINE);
		expect(fine.units.map((u: { name: string }) => u.name)).toEqual(['Unit A']);
		expect(fine.uncovered.map((u: { name: string }) => u.name)).toEqual(['Unit B', 'Unit C']);

		const unknown = await editor.call('GET', at(pid, 'no-such-grid'));
		expect(unknown.status).toBe(400);
		expect(unknown.body.details).toEqual({ code: 'dataset_unknown' });
	});

	it('never proposes the synthetic grid over a real one by covering more: it only stands in when no real grid covers any unit', async () => {
		const { pid, id } = await project('Unit MAP real over synthetic', { 'Unit Z1': PARCEL_Z1, 'Unit Z2': PARCEL_Z2 });
		const p = (await editor.call('GET', at(pid))).body;
		// The synthetic grid covers both units, the real one only Z1: the real one is proposed, Z2 listed, never filled.
		expect(p.candidates.find((c: { label: string }) => c.label === 'synthetic')).toMatchObject({ synthetic: true, covered: 2 });
		expect(p.dataset).toMatchObject({ label: REAL_Z, synthetic: false });
		expect(p.units.map((u: { name: string; mapMm: number }) => [u.name, u.mapMm])).toEqual([['Unit Z1', 650]]);
		expect(p.uncovered.map((u: { nodeId: string }) => u.nodeId)).toEqual([id['Unit Z2']]);

		// With no real grid covering any unit, the synthetic one stands in (the panel marks it).
		const only = await project('Unit MAP synthetic only', { 'Unit Z2': PARCEL_Z2 });
		const q = (await editor.call('GET', at(only.pid))).body;
		expect(q.dataset).toMatchObject({ label: 'synthetic', synthetic: true });
		expect(q.coversAll).toBe(true);
	});

	it('lists a unit only partly inside the grid as uncovered, saying how much it has', async () => {
		// Half of the parcel past the fine grid's east edge (25.20).
		const { pid } = await project('Unit MAP edge', { 'Unit E': { type: 'Polygon', coordinates: [ring(25.18, -30.1, 25.22, -30.06)] } });
		const p = (await editor.call('GET', at(pid, FINE))).body;
		expect(p.units).toEqual([]);
		expect(p.uncovered).toHaveLength(1);
		expect(p.uncovered[0].coveredShare).toBeCloseTo(0.5, 3);
		expect(p.uncovered[0].reason).toMatch(/values for only 50 % of the unit’s parcel \(at least 90 % is needed\)/);
	});
});

describe('POST /projects/:id/map/unit-map', () => {
	it('writes each covered unit’s mapMm and mapSource as one History entry, then has nothing to change', async () => {
		const { pid, id } = await project('Unit MAP apply', { 'Unit A': PARCEL_A, 'Unit B': PARCEL_B, 'Unit C': PARCEL_C });
		const before = (await revisions(pid)).length;

		// Refusals first: nothing written.
		const uncovered = await editor.call('POST', at(pid), { dataset: COARSE, nodeIds: [id['Unit C']] });
		expect(uncovered.status).toBe(409);
		expect(uncovered.body.details).toMatchObject({ code: 'unit_uncovered', units: [{ nodeId: id['Unit C'], name: 'Unit C' }] });
		const unknownUnit = await editor.call('POST', at(pid), { dataset: COARSE, nodeIds: [crypto.randomUUID()] });
		expect(unknownUnit.status).toBe(400);
		expect(unknownUnit.body.details).toEqual({ code: 'unit_unknown' });
		const unknownGrid = await editor.call('POST', at(pid), { dataset: 'no-such-grid' });
		expect(unknownGrid.status).toBe(400);
		expect(unknownGrid.body.details).toEqual({ code: 'dataset_unknown' });
		expect((await editor.call('POST', at(pid), { dataset: COARSE, extra: 1 })).status).toBe(400);
		expect((await revisions(pid)).length).toBe(before);

		const r = await editor.call('POST', at(pid), { dataset: COARSE });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const sourceOf = 'um-coarse-test 2, area-weighted mean over the unit’s parcel, 1 cell';
		expect(r.body).toMatchObject({
			dataset: COARSE,
			changed: 2,
			units: [
				{ nodeId: id['Unit A'], mapMm: 700, mapSource: sourceOf },
				{ nodeId: id['Unit B'], mapMm: 900, mapSource: sourceOf }
			],
			revisionId: expect.any(String)
		});
		const model = (await owner.call('GET', `/projects/${pid}/model`)).body;
		const byName = Object.fromEntries(model.nodes.map((n: { name: string; mapMm: number | null; mapSource: string | null }) => [n.name, [n.mapMm, n.mapSource ?? null]]));
		expect(byName['Unit A']).toEqual([700, sourceOf]);
		expect(byName['Unit B']).toEqual([900, sourceOf]);
		// Unit C, uncovered, is left as it was: never filled from the fine grid (which doesn't cover it either) or any other.
		expect(byName['Unit C']).toEqual([null, null]);

		// One revision, citing the grid, with a line for each unit's MAP.
		const revs = await revisions(pid);
		expect(revs.length).toBe(before + 1);
		expect(revs.at(-1)).toMatchObject({ source: 'model_put', reason: expect.stringMatching(/^MAP of 2 units from the MAP grid um-coarse-test 2 \(0\.1° cells\), area-weighted mean over the unit’s parcel; Invented coarse MAP grid$/) });
		const history = await editor.call('GET', `/projects/${pid}/history`);
		expect(history.status).toBe(200);
		expect(JSON.stringify(history.body)).toContain('MAP of 2 units from the MAP grid');

		// The proposal now says so; applying again changes nothing and records nothing.
		const after = (await editor.call('GET', at(pid))).body;
		expect(after.units.every((u: { same: boolean }) => u.same)).toBe(true);
		const again = await editor.call('POST', at(pid), { dataset: COARSE });
		expect(again.body).toMatchObject({ changed: 0, revisionId: null });
		expect((await revisions(pid)).length).toBe(before + 1);
	});

	it('refuses a named unit without a parcel or with several, and a grid that covers none of the units', async () => {
		const { pid, id } = await project('Unit MAP blocked', { 'Unit A': PARCEL_A, 'Unit N': null, 'Unit T': PARCEL_B });
		// Unit T gets a second parcel, and neither is its area: refused.
		expect((await editor.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: 'T2', nodeId: id['Unit T'], geometry: PARCEL_A2 })).status).toBe(201);
		const p = (await editor.call('GET', at(pid))).body;
		expect(p.refused).toEqual([{ nodeId: id['Unit T'], name: 'Unit T', reason: expect.stringMatching(/several parcels on the map and none is its area/) }]);
		const r = await editor.call('POST', at(pid), { dataset: FINE, nodeIds: [id['Unit N'], id['Unit T']] });
		expect(r.status).toBe(409);
		expect(r.body.details.code).toBe('unit_uncovered');
		expect(r.body.details.units).toEqual([
			{ nodeId: id['Unit T'], name: 'Unit T', reason: expect.stringMatching(/several parcels/) },
			{ nodeId: id['Unit N'], name: 'Unit N', reason: 'the unit has no polygon on the map' }
		]);
		// A unit named twice is written once.
		const twice = await editor.call('POST', at(pid), { dataset: FINE, nodeIds: [id['Unit A'], id['Unit A']] });
		expect(twice.status, JSON.stringify(twice.body)).toBe(200);
		expect(twice.body.units).toHaveLength(1);

		const none = await project('Unit MAP none covered', { 'Unit C': PARCEL_C });
		const n = await editor.call('POST', at(none.pid), { dataset: FINE });
		expect(n.status).toBe(400);
		expect(n.body.details).toEqual({ code: 'nothing_covered' });
	});

	it('refuses applying one grid to some units while another covered unit keeps another grid’s MAP', async () => {
		const { pid, id } = await project('Unit MAP mixed by nodeIds', { 'Unit A': PARCEL_A, 'Unit A2': PARCEL_A2 });
		expect((await editor.call('POST', at(pid), { dataset: COARSE })).status).toBe(200);
		// The fine grid covers both; only A is named, so A2 would keep the coarse grid's MAP.
		const r = await editor.call('POST', at(pid), { dataset: FINE, nodeIds: [id['Unit A']] });
		expect(r.status).toBe(409);
		expect(r.body.details).toMatchObject({ code: 'grid_mixed', units: [{ nodeId: id['Unit A2'], name: 'Unit A2' }] });
		// Both together are fine: the project moves to the fine grid whole.
		const both = await editor.call('POST', at(pid), { dataset: FINE });
		expect(both.status, JSON.stringify(both.body)).toBe(200);
		expect(both.body.units.map((u: { mapMm: number }) => u.mapMm)).toEqual([440, 480]);
	});

	it('refuses an apply that would leave units on two grids, and takes one unit by nodeIds', async () => {
		const { pid, id } = await project('Unit MAP mixed', { 'Unit A': PARCEL_A, 'Unit B': PARCEL_B });
		expect((await editor.call('POST', at(pid), { dataset: COARSE })).status).toBe(200);
		// The fine grid covers unit A only: unit B would keep the coarse grid's MAP.
		const fine = (await editor.call('GET', at(pid, FINE))).body;
		expect(fine.otherGrid).toEqual([{ nodeId: id['Unit B'], name: 'Unit B', mapSource: 'um-coarse-test 2, area-weighted mean over the unit’s parcel, 1 cell' }]);
		const mixed = await editor.call('POST', at(pid), { dataset: FINE });
		expect(mixed.status).toBe(409);
		expect(mixed.body.details).toMatchObject({ code: 'grid_mixed', units: [{ nodeId: id['Unit B'], name: 'Unit B' }] });
		expect(mixed.body.error).toMatch(/one project never mixes two/);

		// A MAP typed in by hand isn't a grid's: clearing B by hand (a PUT /model) lets the fine grid take A.
		const model = (await owner.call('GET', `/projects/${pid}/model`)).body;
		for (const n of model.nodes) if (n.id === id['Unit B']) Object.assign(n, { mapMm: 812, mapSource: 'the farm’s own gauge, 1995–2020' });
		expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
		const one = await editor.call('POST', at(pid), { dataset: FINE, nodeIds: [id['Unit A']] });
		expect(one.status, JSON.stringify(one.body)).toBe(200);
		expect(one.body.units).toEqual([{ nodeId: id['Unit A'], mapMm: 440, mapSource: 'um-fine-test 1, area-weighted mean over the unit’s parcel, 16 cells' }]);
		expect((await revisions(pid)).at(-1)!.reason).toMatch(/^MAP of “Unit A” from the MAP grid um-fine-test 1/);
	});
});
