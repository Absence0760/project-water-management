// The pans' cross-check against the river network and the dams (the
// follow-up "Cross-check a pan against the river network"; panReference.ts,
// pans.ts onRiverBy, 196_river_endorheic), end to end against Postgres and
// the committed synthetic DEM, whose pan on the eastern flank spills down a
// 6 % slope (a drop past its floor within a cell, as below a dam's wall):
//  - loadPanReference reads only the reaches that reach the sea (endorheic
//    false; true and not given are left out), the register's dams in the
//    boxes, and the project's drawn rivers and dams (not a reach copied
//    from the network, nor another project's features);
//  - a click proposes the pan as a pan with only reaches it can't use (an
//    endorheic one; one that reaches the sea, out of a hollow draining
//    under 10 km²), and as storage on a river once the catchment's own
//    drawn river runs through it and out, or the register has a dam on it
//    (delineate-12); the stored proposal keeps the report.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { fixtureLonLat, OUTLET_CELL, PAN } from './fixture.js';
import { loadPanReference } from './panReference.js';

type User = Awaited<ReturnType<typeof signUp>>;
const DATASET = 'pan-check-test';
const REGISTER = 'pan-check-register';
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
/** In from the flank above the pan, through it, and out down the flank to the valley's river. */
const THROUGH = [at(PAN.x + 12, PAN.y - 2), at(PAN.x, PAN.y), at(OUTLET_CELL.x, PAN.y + 8)];
const [w, s] = at(PAN.x - 20, PAN.y + 20);
const [e, n] = at(PAN.x + 20, PAN.y - 20);
const BOX: [number, number, number, number] = [w, s, e, n];
let editor: User;
let projectId: string;
let otherProjectId: string;

async function plantReach(id: number, endorheic: boolean | null, line: [number, number][] = THROUGH) {
	const lons = line.map((p) => p[0]);
	const lats = line.map((p) => p[1]);
	await asOwner(
		`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source, endorheic)
		 VALUES ($1, $2, 2, 30, $3, $4, $5, $6, $7, 'test reach through the synthetic pan', $8)`,
		[DATASET, id, JSON.stringify({ type: 'LineString', coordinates: line }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), endorheic]
	);
}

const clear = () => asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);

beforeAll(async () => {
	process.env.DEM_URL = FIXTURE;
	editor = await signUp('Paneditor');
	projectId = (await editor.call('POST', '/projects', { name: 'Pan check' })).body.project.id;
	otherProjectId = (await editor.call('POST', '/projects', { name: 'Pan check elsewhere' })).body.project.id;
}, 60_000);

afterAll(async () => {
	await clear();
	await asOwner('DELETE FROM dam_register_reference WHERE dataset = $1', [REGISTER]);
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('loadPanReference', () => {
	it('reads the reaches that reach the sea, the register’s dams in the boxes and the project’s own drawn rivers and dams', async () => {
		await clear();
		await plantReach(98000001, false);
		await plantReach(98000002, true);
		await plantReach(98000003, null);
		// Beyond every box: not read.
		await plantReach(98000004, false, [at(PAN.x - 200, PAN.y - 200), at(PAN.x - 190, PAN.y - 200)]);
		await asOwner('DELETE FROM dam_register_reference WHERE dataset = $1', [REGISTER]);
		await asOwner(
			`INSERT INTO dam_register_reference (register_no, dataset, name, lon, lat, source) VALUES
			 ('ZPC1', $1, 'In the box', $2, $3, 'test'), ('ZPC2', $1, 'Far off', $4, $5, 'test')`,
			[REGISTER, ...at(PAN.x, PAN.y), ...at(PAN.x - 200, PAN.y - 200)]
		);
		const drawn = [at(PAN.x, PAN.y - 5), at(PAN.x, PAN.y + 5)];
		const add = (pid: string, body: Record<string, unknown>) => editor.call('POST', `/projects/${pid}/map/features`, body);
		expect((await add(projectId, { kind: 'river', name: 'Drawn spruit', geometry: { type: 'LineString', coordinates: drawn } })).status).toBe(201);
		expect((await add(projectId, { kind: 'dam', name: 'Drawn dam', geometry: { type: 'Point', coordinates: at(PAN.x + 1, PAN.y) } })).status).toBe(201);
		expect((await add(otherProjectId, { kind: 'dam', name: 'Not this project’s', geometry: { type: 'Point', coordinates: at(PAN.x + 2, PAN.y) } })).status).toBe(201);
		// A reach added from the network: the reference's own row decides for it, so the copy isn't read twice.
		await asOwner(
			`INSERT INTO map_feature (project_id, kind, name, geometry, properties, created_by)
			 VALUES ($1, 'river', 'From the network', $2, $3, $4)`,
			[projectId, JSON.stringify({ type: 'LineString', coordinates: THROUGH }), JSON.stringify({ ref: `river-network:${DATASET}:98000002` }), editor.id]
		);
		const ref = await withUser(editor.id, (db) => loadPanReference(db, projectId, [BOX]));
		const ours = ref.rivers.filter((r) => r.directed);
		expect(ours.map((r) => r.line)).toContainEqual(THROUGH);
		// Only the one that reaches the sea, of the three planted through the pan (the dev database may hold other datasets elsewhere).
		expect(ours.filter((r) => JSON.stringify(r.line) === JSON.stringify(THROUGH))).toHaveLength(1);
		expect(ref.rivers.filter((r) => !r.directed).map((r) => r.line)).toEqual([drawn]);
		expect(ref.dams).toContainEqual([at(PAN.x, PAN.y)]);
		expect(ref.dams).toContainEqual([at(PAN.x + 1, PAN.y)]);
		expect(ref.dams).not.toContainEqual([at(PAN.x + 2, PAN.y)]);
		expect(ref.dams).not.toContainEqual([at(PAN.x - 200, PAN.y - 200)]);
		expect(await withUser(editor.id, (db) => loadPanReference(db, projectId, []))).toEqual({ rivers: [], dams: [] });
	});
});

describe('a click with the cross-check (delineate-12)', () => {
	const click = () => {
		const [lon, lat] = at(OUTLET_CELL.x, OUTLET_CELL.y);
		return editor.call('POST', `/projects/${otherProjectId}/map/delineation`, { lon, lat, from: 'outlet' });
	};

	it('keeps the pan with only reaches it can’t use (positive control), and lists it as storage on a river once the catchment’s own river runs through it and out', async () => {
		// The fixture's pan drains about 8 km²: under the 10 km² a network reach needs (pans.ts ON_RIVER_MIN_DRAINS_M2), so even the
		// reach that reaches the sea is left out; a river drawn on the map is not held to it.
		await clear();
		await asOwner('DELETE FROM dam_register_reference WHERE dataset = $1', [REGISTER]);
		await asOwner(`DELETE FROM map_feature WHERE project_id = $1 AND kind IN ('dam', 'river')`, [otherProjectId]);
		await plantReach(98000001, false);
		await plantReach(98000002, true);
		const pan = await click();
		expect(pan.status, JSON.stringify(pan.body)).toBe(201);
		expect(pan.body.proposal.methodVersion).toBe('delineate-12');
		expect(pan.body.proposal.pans).toMatchObject({ count: 1, onRiver: { count: 0, largest: [] } });
		expect(pan.body.proposal.pans.nonContributingM2).toBeLessThan(10e6);

		const drawn = await editor.call('POST', `/projects/${otherProjectId}/map/features`, { kind: 'river', name: 'Flank spruit', geometry: { type: 'LineString', coordinates: THROUGH } });
		expect(drawn.status).toBe(201);
		const river = await click();
		expect(river.status, JSON.stringify(river.body)).toBe(201);
		const p = river.body.proposal;
		expect(p.pans).toMatchObject({ count: 0, nonContributingM2: 0, onRiver: { count: 1, largest: [{ by: 'river' }] } });
		expect(p.pans.method).toMatch(/storage on a river: listed apart, not counted\.$/);
		const stored = (await asOwner('SELECT pans FROM delineation_proposal WHERE id = $1', [p.id])) as { pans: unknown }[];
		expect(stored[0]!.pans).toEqual(p.pans);
	}, 60_000);

	it('lists it as a dam’s when the register has a dam on it', async () => {
		await clear();
		await asOwner(`DELETE FROM map_feature WHERE project_id = $1 AND kind IN ('dam', 'river')`, [otherProjectId]);
		await asOwner('DELETE FROM dam_register_reference WHERE dataset = $1', [REGISTER]);
		await asOwner(`INSERT INTO dam_register_reference (register_no, dataset, name, lon, lat, source) VALUES ('ZPC3', $1, 'On the pan', $2, $3, 'test')`, [REGISTER, ...at(PAN.x, PAN.y)]);
		const r = await click();
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal.pans).toMatchObject({ count: 0, onRiver: { count: 1, largest: [{ by: 'dam' }] } });
	}, 60_000);
});
