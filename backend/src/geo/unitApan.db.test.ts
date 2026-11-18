// Each unit's monthly A-pan from an A-pan grid (geo/unitApanRoutes.ts,
// geo/unitApan.ts): GET /projects/:id/map/unit-apan over an invented 0.01°
// A-pan grid loaded here (far from the committed grids' region Z). A viewer
// reads it (the positive control) and a stranger meets 404; each unit with a
// parcel the grid covers gets its 12 area-weighted months, its year and its
// difference from the catchment boundary's year; a unit under 90 % covered,
// one without a parcel and one with several parcels are listed with the
// reason, never filled from elsewhere; a grid that isn't loaded, or isn't an
// A-pan grid, answers dataset null. The GET writes nothing; POST (Use, editor)
// saves each covered unit's row as settings.apanUnits with the 'units' basis,
// as one settings revision citing the grid, a viewer refused and a stranger
// 404. Synthetic geometry and values only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { replaceEvaporationDataset } from './evaporationGrid.js';

type User = Awaited<ReturnType<typeof signUp>>;

const GRID = 'ua-apan-test';
const ET0 = 'ua-et0-test';
/** Oct … Sep base row, 2 400 mm a year; a column's cells hold it × (1 + 0.01 × the column past 2500). */
const BASE = [200, 230, 260, 270, 240, 220, 170, 130, 110, 120, 170, 280];

/** 0.01° cells over 25.00–25.20 E, 30.20–30.00 S. */
function cells() {
	const out: { row: number; col: number; monthlyMm: number[] }[] = [];
	for (let row = -3020; row < -3000; row++) for (let col = 2500; col < 2520; col++) out.push({ row, col, monthlyMm: BASE.map((v) => Math.round(v * (1 + 0.01 * (col - 2500)) * 10) / 10) });
	return out;
}

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
const poly = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [ring(w, s, e, n)] });
/** Columns 2502–2505: factors 1.02 … 1.05, mean 1.035. */
const PARCEL_WEST = poly(25.02, -30.1, 25.06, -30.06);
/** Columns 2514–2517: factors 1.14 … 1.17, mean 1.155. */
const PARCEL_EAST = poly(25.14, -30.1, 25.18, -30.06);
/** Half past the grid's east edge: 50 % covered. */
const PARCEL_EDGE = poly(25.18, -30.1, 25.22, -30.06);
/** The boundary over the whole grid: factors 1.00 … 1.19, mean 1.095. */
const BOUNDARY = poly(25.0, -30.2, 25.2, -30.0);

let owner: User;
let viewer: User;
let stranger: User;

beforeAll(async () => {
	[owner, viewer, stranger] = (await Promise.all(['UAowner', 'UAviewer', 'UAstranger'].map((n) => signUp(n)))) as [User, User, User];
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		const grid = { cellDeg: 0.01, originLon: 0, originLat: 0, firstYear: null, lastYear: null, cells: cells(), partial: 0 };
		await replaceEvaporationDataset(client, { dataset: GRID, kind: 'apan', source: 'Invented A-pan grid', version: '1', attribution: 'test', method: 'test' }, grid);
		await replaceEvaporationDataset(client, { dataset: ET0, kind: 'et0', source: 'Invented ET0 grid', version: '1', attribution: 'test', method: 'test' }, { ...grid, firstYear: 1991, lastYear: 2020 });
	} finally {
		await client.end();
	}
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [[GRID, ET0]]);
});

/** A project with an outlet, a water user, a boundary (or none) and the land units named, each with its parcels. */
async function project(name: string, parcels: Record<string, unknown[]>, boundary: unknown | null = BOUNDARY) {
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const outlet = node('Outlet', null);
	const units = Object.keys(parcels).map((n, i) => node(n, outlet.id, { areaKm2: 10 + i }));
	const town = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: Array(12).fill(100) });
	expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [outlet, ...units, town], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [i, gs] of Object.values(parcels).entries()) {
		for (const [k, g] of gs.entries()) {
			const r = await owner.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: `P${i}.${k}`, nodeId: units[i]!.id, geometry: g });
			expect(r.status, JSON.stringify(r.body)).toBe(201);
		}
	}
	// The water user's parcel never makes it a land unit.
	expect((await owner.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name: 'Town', nodeId: town.id, geometry: PARCEL_WEST })).status).toBe(201);
	if (boundary) expect((await owner.call('POST', `/projects/${pid}/map/features`, { kind: 'catchment_boundary', name: 'Catchment', geometry: boundary })).status).toBe(201);
	return { pid, id: Object.fromEntries(units.map((u) => [u.name, u.id])) as Record<string, string> };
}
const at = (pid: string, dataset?: string) => `/projects/${pid}/map/unit-apan${dataset ? `?dataset=${encodeURIComponent(dataset)}` : ''}`;
const scaled = (f: number) => BASE.map((v) => v * f);

describe('GET /projects/:id/map/unit-apan', () => {
	it('gives a viewer each covered unit’s months beside the catchment’s; a stranger meets 404', async () => {
		const { pid, id } = await project('Unit A-pan', {
			West: [PARCEL_WEST],
			East: [PARCEL_EAST],
			Edge: [PARCEL_EDGE],
			None: [],
			Several: [PARCEL_WEST, PARCEL_EAST]
		});
		expect((await stranger.call('GET', at(pid, GRID))).status).toBe(404);
		const revisions = () => asOwner('SELECT count(*)::int AS n FROM model_revision WHERE project_id = $1', [pid]);
		const before = await revisions();
		const res = await viewer.call('GET', at(pid, GRID));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const p = res.body;
		expect(p.dataset).toMatchObject({ label: GRID, version: '1', cellDeg: 0.01, synthetic: false });
		expect(p.boundary).toMatchObject({ name: 'Catchment' });
		// The catchment: the whole grid, mean factor 1.095 (each cell rounded to 0.1 mm first).
		p.catchment.monthlyMm.forEach((v: number, m: number) => expect(v).toBeCloseTo(scaled(1.095)[m]!, 0));
		expect(p.catchment.coverage).toBeCloseTo(1, 6);
		// In the model's order (sort order, then name).
		expect(p.units.map((u: { name: string }) => u.name)).toEqual(['East', 'West']);
		const [east, west] = p.units;
		west.monthlyMm.forEach((v: number, m: number) => expect(v).toBeCloseTo(scaled(1.035)[m]!, 0));
		east.monthlyMm.forEach((v: number, m: number) => expect(v).toBeCloseTo(scaled(1.155)[m]!, 0));
		expect(west).toMatchObject({ nodeId: id.West, areaKm2: 10, cells: 16 });
		expect(east).toMatchObject({ nodeId: id.East, areaKm2: 11, cells: 16 });
		expect(west.coveredShare).toBeCloseTo(1, 6);
		// (1.035 − 1.095) ÷ 1.095 = −5.5 %; (1.155 − 1.095) ÷ 1.095 = +5.5 %.
		expect(west.diffPct).toBeCloseTo(-5.5, 0);
		expect(east.diffPct).toBeCloseTo(5.5, 0);
		expect(west.annualMm).toBeCloseTo(west.monthlyMm.reduce((a: number, b: number) => a + b, 0), 6);
		// Never filled from elsewhere: listed with the reason.
		expect(p.uncovered).toEqual([{ nodeId: id.Edge, name: 'Edge', coveredShare: expect.closeTo(0.5, 2), reason: 'the grid has values for only 50 % of the unit’s parcel (at least 90 % is needed)' }]);
		expect(p.withoutPolygon).toEqual([{ nodeId: id.None, name: 'None' }]);
		expect(p.refused).toEqual([{ nodeId: id.Several, name: 'Several', reason: expect.stringContaining('several parcels') }]);
		// What the model runs every unit on now: the settings' one row.
		expect(p.settingsApanMm).toHaveLength(12);
		// Nothing is written.
		expect(await revisions()).toEqual(before);
	});

	it('without a boundary lists the units with no difference; another project’s units never show', async () => {
		const { pid } = await project('Unit A-pan no boundary', { West: [PARCEL_WEST] }, null);
		const other = await project('Unit A-pan other', { Hidden: [PARCEL_EAST] });
		const p = (await viewer.call('GET', at(pid, GRID))).body;
		expect(p.boundary).toBeNull();
		expect(p.catchment).toBeNull();
		expect(p.units).toEqual([expect.objectContaining({ name: 'West', diffPct: null })]);
		// The viewer of both sees each project's own units only.
		expect((await viewer.call('GET', at(other.pid, GRID))).body.units.map((u: { name: string }) => u.name)).toEqual(['Hidden']);
	});

	it('answers dataset null for a grid that isn’t loaded or isn’t an A-pan grid, and refuses a bad label', async () => {
		const { pid } = await project('Unit A-pan none', { West: [PARCEL_WEST] });
		for (const d of ['Atlas-Apan-2007-not-here', ET0]) {
			const r = await viewer.call('GET', at(pid, d));
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ dataset: null, units: [], catchment: null });
		}
		expect((await viewer.call('GET', at(pid, 'x'.repeat(51)))).status).toBe(400);
	});

	it('Use (editor) saves each covered unit’s row and the units basis as one settings revision; a viewer is refused', async () => {
		const editor = await signUp('UAeditor');
		const { pid, id } = await project('Unit A-pan use', { West: [PARCEL_WEST], East: [PARCEL_EAST], Edge: [PARCEL_EDGE] });
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await viewer.call('POST', at(pid), { dataset: GRID })).status).toBe(403);
		expect((await stranger.call('POST', at(pid), { dataset: GRID })).status).toBe(404);
		expect((await editor.call('POST', at(pid), { dataset: 'not-loaded' })).status).toBe(400);
		expect((await editor.call('POST', at(pid), { dataset: GRID, extra: 1 })).status).toBe(400);
		const shown = (await viewer.call('GET', at(pid, GRID))).body;
		expect(shown.same).toBe(false);
		expect(shown.saved).toEqual({ basis: 'catchment', dataset: null, source: null, units: {} });
		const res = await editor.call('POST', at(pid), { dataset: GRID });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.revisionId).toEqual(expect.any(String));
		const [{ settings }] = await asOwner('SELECT settings FROM project WHERE id = $1', [pid]);
		expect(settings.apanBasis).toBe('units');
		expect(Object.keys(settings.apanUnits.units).sort()).toEqual([id.East, id.West].sort());
		expect(settings.apanUnits.dataset).toBe(GRID);
		expect(settings.apanUnits.source).toMatch(/^Invented A-pan grid \(1, monthly means, no period stated by the source; dataset “ua-apan-test”\); each unit’s 12 monthly means area-weighted/);
		settings.apanUnits.units[id.West!].forEach((v: number, m: number) => expect(v).toBeCloseTo(shown.units.find((u: { nodeId: string }) => u.nodeId === id.West!).monthlyMm[m], 6));
		const [rev] = await asOwner(`SELECT source, reason FROM model_revision WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [pid]);
		expect(rev.source).toBe('settings_patch');
		expect(rev.reason).toMatch(/^A-pan for each hydrological unit \(CCWR A-pan \(Hydrological Unit\)\): 2 units from .*; on the covered units’ area-weighted mean: “Edge”; dataset “ua-apan-test” \(1, monthly means, no period stated by the source; its source and method as the dataset records them, credit at \/data-sources\)$/);
		const after = (await viewer.call('GET', at(pid, GRID))).body;
		expect(after.same).toBe(true);
		expect(after.saved).toMatchObject({ basis: 'units', dataset: GRID });
		// A copy of the project keeps each row on its own copy of the unit.
		const copy = await owner.call('POST', `/projects/${pid}/copy`, { name: 'Unit A-pan copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const cid = copy.body.project.id as string;
		const [{ settings: cs }] = await asOwner('SELECT settings FROM project WHERE id = $1', [cid]);
		const nodes = (await asOwner(`SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' AND area_km2 > 0`, [cid])).map((r: { id: string }) => r.id);
		expect(Object.keys(cs.apanUnits.units)).toHaveLength(2);
		expect(Object.keys(cs.apanUnits.units).every((k) => nodes.includes(k))).toBe(true);
	});

	it('a project whose units the grid doesn’t cover can’t use it', async () => {
		const { pid } = await project('Unit A-pan none covered', { Edge: [PARCEL_EDGE] });
		const r = await owner.call('POST', at(pid), { dataset: GRID });
		expect(r.status).toBe(400);
		expect(r.body.details?.code ?? r.body.code).toBe('nothing_covered');
	});

	it('the settings save takes the basis and the units’ rows, and refuses what the engine can’t use', async () => {
		const { pid, id } = await project('Unit A-pan settings', { West: [PARCEL_WEST] });
		const patch = (settings: object) => owner.call('PATCH', `/projects/${pid}`, { settings });
		expect((await patch({ apanBasis: 'units' })).status).toBe(200);
		expect((await patch({ apanBasis: 'other' })).status).toBe(400);
		expect((await patch({ apanUnits: { dataset: GRID, source: 'typed', units: { [id.West!]: [1, 2] } } })).status).toBe(400);
		expect((await patch({ apanUnits: { dataset: GRID, source: 'typed', units: { [id.West!]: BASE } } })).status).toBe(200);
		expect((await patch({ apanBasis: null })).status).toBe(200);
		const [{ settings }] = await asOwner('SELECT settings FROM project WHERE id = $1', [pid]);
		// Back to the catchment row: the units' rows are kept.
		expect(settings.apanBasis).toBeNull();
		expect(settings.apanUnits.units[id.West!]).toEqual(BASE);
	});
});
