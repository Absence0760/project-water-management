// Planted areas proposed from land cover (issue #326 B-landcover;
// 173_cropland_reference.sql, 174_crop_area_land_cover.sql,
// geo/croplandRoutes.ts), end to end against Postgres with the committed
// synthetic grid loaded (every cell 0.5 inside 21.30–21.35° E, 33.65–33.70° S):
//  - a viewer reads a unit's proposals: each linked parcel's area and
//    cultivated area (half of it here), the unit's sum, the catchment
//    boundary's, the dataset with its version and method, marked synthetic,
//    and the project's crops with what the unit holds now;
//  - an editor accepts the unit's sum, then one parcel's, each as one crop's
//    planted area, each a model revision whose reason names the dataset,
//    version and method, and a provenance row that stops being current once
//    the area is typed over; a viewer can't;
//  - refusals: a parcel not linked to the unit, a unit with no parcel, a
//    parcel with no cropland, an unknown dataset, a gauge (400); another
//    project's crop or feature, a stranger (404);
//  - a farmer of the unit gets 403 on both routes (the provenance is the modeller's);
//  - the loader writes the grid and its dataset row, and a reload replaces them;
//  - the grid is read-only to the app role (control: it reads it); the
//    provenance can't name another project's crop, nor a parcel basis without
//    its parcel.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticLandCover } from '../../scripts/import-land-cover.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { geometryAreaM2 } from './area.js';
import type { Position } from './geojson.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let farmer: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
const farmC = node('Farm C', outlet.id);
const monthly = (v: number) => Array.from({ length: 12 }, () => v);
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const rect = (w: number, s: number, e: number, n: number): Position[][] => [
	[
		[w, s],
		[e, s],
		[e, n],
		[w, n],
		[w, s]
	]
];
/** Inside the synthetic grid's 0.5 block: two parcels of Farm A, and Farm C's far outside any cropland. */
const PARCEL_1 = rect(21.31, -33.69, 21.32, -33.68);
const PARCEL_2 = rect(21.325, -33.665, 21.33, -33.66);
const PARCEL_C = rect(21.6, -33.95, 21.61, -33.94);
const BOUNDARY = rect(21.305, -33.695, 21.345, -33.655);
const m2 = (r: Position[][]) => geometryAreaM2({ type: 'Polygon', coordinates: r })!;

const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const proposals = (u: User, nodeId: string, q = '') => u.call('GET', at(`/nodes/${nodeId}/cropland-proposals${q}`));
const accept = (u: User, nodeId: string, body: Record<string, unknown>) => u.call('POST', at(`/nodes/${nodeId}/crop-area-from-land-cover`), body);
const lastReason = async () => (await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]))[0]!.reason as string;
const cropArea = async (nodeId: string, cropId: string) =>
	(await editor.call('GET', at('/model'))).body.cropAreas.find((a: { nodeId: string; cropId: string }) => a.nodeId === nodeId && a.cropId === cropId)?.areaM2 as number | undefined;

let parcel1: string;
let parcel2: string;
let boundaryId: string;

beforeAll(async () => {
	[owner, editor, viewer, stranger, farmer] = (await Promise.all(['Lowner', 'Leditor', 'Lviewer', 'Lstranger', 'Lfarmer'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Planted areas from land cover' })).body.project.id;
	const put = await owner.call('PUT', at('/model'), {
		nodes: [outlet, farmA, farmB, farmC],
		crops: [lucerne, citrus],
		cropAreas: [{ nodeId: farmA.id, cropId: citrus.id, areaM2: 12_345 }],
		transfers: []
	});
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere land cover' })).body.project.id;
	await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!);
	const place = async (body: Record<string, unknown>) => {
		const res = await editor.call('POST', at('/map/features'), body);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.feature.id as string;
	};
	parcel1 = await place({ kind: 'farm_parcel', name: 'Lower lands', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: PARCEL_1 } });
	parcel2 = await place({ kind: 'farm_parcel', name: 'Top camp', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: PARCEL_2 } });
	await place({ kind: 'farm_parcel', name: 'Veld', nodeId: farmC.id, geometry: { type: 'Polygon', coordinates: PARCEL_C } });
	boundaryId = await place({ kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: BOUNDARY } });
}, 60_000);

describe('the proposals', () => {
	it('gives a viewer each parcel’s cultivated area, the unit’s sum, the catchment’s, the dataset cited and the crops', async () => {
		const res = await proposals(viewer, farmA.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const b = res.body;
		expect(b).toMatchObject({ nodeId: farmA.id, nodeName: 'Farm A' });
		expect(b.dataset).toMatchObject({ dataset: 'synthetic', version: 'synthetic 1', cellDeg: 0.005, classes: [40], synthetic: true, source: expect.stringMatching(/^SYNTHETIC/) });
		expect(b.dataset.method).toMatch(/^Pre-summarised at import: each 0.005° grid cell's share of pixels in class 40/);
		expect(b.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', version: 'synthetic 1', synthetic: true }]));
		expect(b.parcels.map((p: { featureId: string; name: string }) => [p.featureId, p.name])).toEqual([
			[parcel1, 'Lower lands'],
			[parcel2, 'Top camp']
		]);
		for (const [p, ring] of [
			[b.parcels[0], PARCEL_1],
			[b.parcels[1], PARCEL_2]
		] as const) {
			expect(p.areaM2).toBe(Math.round(m2(ring)));
			expect(p.cultivatedM2 / p.areaM2).toBeCloseTo(0.5, 3);
		}
		expect(b.unit).toEqual({ areaM2: b.parcels[0].areaM2 + b.parcels[1].areaM2, cultivatedM2: b.parcels[0].cultivatedM2 + b.parcels[1].cultivatedM2 });
		expect(b.catchment).toMatchObject({ featureId: boundaryId, name: 'Catchment', areaM2: Math.round(m2(BOUNDARY)) });
		expect(b.catchment.cultivatedM2 / b.catchment.areaM2).toBeCloseTo(0.5, 3);
		expect(b.crops).toEqual([
			{ cropId: citrus.id, name: 'Citrus', areaM2: 12_345, accepted: null },
			{ cropId: lucerne.id, name: 'Lucerne', areaM2: 0, accepted: null }
		]);
	});

	it('gives a unit with no parcel no sum, and is 400 for a gauge or an unknown dataset, 404 for a stranger or another project’s node', async () => {
		const b = (await proposals(viewer, farmB.id)).body;
		expect(b).toMatchObject({ parcels: [], unit: null });
		expect((await proposals(viewer, outlet.id)).status).toBe(400);
		expect((await proposals(viewer, farmA.id, '?dataset=nope')).status).toBe(400);
		expect((await proposals(stranger, farmA.id)).status).toBe(404);
		// A farmer of Farm A (control: they read their farm view elsewhere) gets neither route.
		expect((await proposals(farmer, farmA.id)).status).toBe(403);
		expect((await accept(farmer, farmA.id, { cropId: lucerne.id, dataset: 'synthetic' })).status).toBe(403);
		const theirs = node('Their farm', null);
		expect((await stranger.call('PUT', at('/model', otherProjectId), { nodes: [theirs], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await proposals(viewer, theirs.id)).status).toBe(404);
	});
});

describe('accepting a cultivated area as a crop’s planted area', () => {
	it('sets the crop’s area on the unit to the parcels’ sum, cites the dataset in the revision and the provenance; a viewer can’t', async () => {
		expect((await accept(viewer, farmA.id, { cropId: lucerne.id, dataset: 'synthetic' })).status).toBe(403);
		const unit = (await proposals(viewer, farmA.id)).body.unit;
		const res = await accept(editor, farmA.id, { cropId: lucerne.id, dataset: 'synthetic' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ nodeId: farmA.id, cropId: lucerne.id, areaM2: unit.cultivatedM2, dataset: 'synthetic', revisionId: expect.any(String) });
		expect(await cropArea(farmA.id, lucerne.id)).toBe(unit.cultivatedM2);
		// Citrus is untouched: the crop is the modeller's choice.
		expect(await cropArea(farmA.id, citrus.id)).toBe(12_345);
		expect(await lastReason()).toMatch(
			/^Planted area of Lucerne on Farm A from land cover: \d+\.\d\d ha cultivated in its 2 parcels; SYNTHETIC .* \(synthetic 1; dataset “synthetic”\)\. Pre-summarised at import/
		);
		const crops = (await proposals(viewer, farmA.id)).body.crops;
		expect(crops.find((c: { cropId: string }) => c.cropId === lucerne.id).accepted).toMatchObject({
			areaM2: unit.cultivatedM2,
			dataset: 'synthetic',
			version: 'synthetic 1',
			basis: 'unit',
			featureName: null,
			current: true
		});
	});

	it('takes one parcel’s area as another crop’s, and the provenance stops being current once the area is typed over', async () => {
		const p2 = (await proposals(viewer, farmA.id)).body.parcels[1];
		const res = await accept(editor, farmA.id, { cropId: citrus.id, dataset: 'synthetic', featureId: parcel2 });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.areaM2).toBe(p2.cultivatedM2);
		expect(await lastReason()).toMatch(/^Planted area of Citrus on Farm A from land cover: \d+\.\d\d ha cultivated in the parcel “Top camp”;/);
		const model = (await editor.call('GET', at('/model'))).body;
		model.cropAreas = model.cropAreas.map((a: { nodeId: string; cropId: string; areaM2: number }) => (a.cropId === citrus.id ? { ...a, areaM2: 5_000 } : a));
		expect((await editor.call('PUT', at('/model'), model)).status).toBe(200);
		const crops = (await proposals(viewer, farmA.id)).body.crops;
		expect(crops.find((c: { cropId: string }) => c.cropId === citrus.id)).toMatchObject({ areaM2: 5_000, accepted: { basis: 'parcel', featureName: 'Top camp', current: false } });
		expect(crops.find((c: { cropId: string }) => c.cropId === lucerne.id).accepted.current).toBe(true);
	});

	it('refuses what it can’t re-derive; nothing changes', async () => {
		const before = await cropArea(farmA.id, lucerne.id);
		const err = async (nodeId: string, body: Record<string, unknown>, status = 400) => {
			const res = await accept(editor, nodeId, body);
			expect(res.status, JSON.stringify(res.body)).toBe(status);
			return res.body.error as string;
		};
		expect(await err(farmA.id, { cropId: lucerne.id, dataset: 'synthetic', featureId: boundaryId })).toMatch(/isn’t a farm parcel linked to Farm A/);
		expect(await err(farmB.id, { cropId: lucerne.id, dataset: 'synthetic' })).toMatch(/^No farm parcel on the map is linked to Farm B/);
		expect(await err(farmC.id, { cropId: lucerne.id, dataset: 'synthetic' })).toMatch(/maps no cropland in its parcel “Veld”/);
		expect(await err(farmA.id, { cropId: lucerne.id, dataset: 'nope' })).toMatch(/No land-cover dataset “nope”/);
		expect(await err(outlet.id, { cropId: lucerne.id, dataset: 'synthetic' })).toMatch(/Only a hydrological unit/);
		expect(await err(farmA.id, { cropId: lucerne.id, dataset: 'synthetic', extra: 1 })).toBeTruthy();
		const theirCrop = { id: crypto.randomUUID(), name: 'Theirs', cropFactor: monthly(1) };
		const theirs = node('Their outlet', null);
		expect((await stranger.call('PUT', at('/model', otherProjectId), { nodes: [theirs], crops: [theirCrop], cropAreas: [], transfers: [] })).status).toBe(200);
		await err(farmA.id, { cropId: theirCrop.id, dataset: 'synthetic' }, 404);
		const theirFeature = await stranger.call('POST', at('/map/features', otherProjectId), { kind: 'farm_parcel', geometry: { type: 'Polygon', coordinates: PARCEL_1 } });
		expect(theirFeature.status).toBe(201);
		await err(farmA.id, { cropId: lucerne.id, dataset: 'synthetic', featureId: theirFeature.body.feature.id }, 404);
		expect((await stranger.call('POST', at(`/nodes/${farmA.id}/crop-area-from-land-cover`), { cropId: lucerne.id, dataset: 'synthetic' })).status).toBe(404);
		expect(await cropArea(farmA.id, lucerne.id)).toBe(before);
	});

	it('keeps the unit’s and its demand objects’ water sources (engine 1.65.0, migration 170) through the revision it saves', async () => {
		const model = (await editor.call('GET', at('/model'))).body;
		const town = { id: crypto.randomUUID(), nodeId: farmA.id, name: 'Village', category: 'municipal', sizing: 'monthly', monthlyM3Day: monthly(40), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, waterSource: 'river', riverPumpM3Day: 480.5, riverPoolM3: 3000, note: '' };
		const nodes = model.nodes.map((n: { id: string }) => (n.id === farmA.id ? { ...n, cropWaterSource: 'river', cropRiverPumpM3Day: 1500.25, cropRiverPoolM3: null } : n));
		const put = await editor.call('PUT', at('/model'), { ...model, nodes, demandObjects: [town] });
		expect(put.status, JSON.stringify(put.body)).toBe(200);
		const res = await accept(editor, farmA.id, { cropId: lucerne.id, dataset: 'synthetic' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const after = (await editor.call('GET', at('/model'))).body;
		expect(after.nodes.find((n: { id: string }) => n.id === farmA.id)).toMatchObject({ cropWaterSource: 'river', cropRiverPumpM3Day: 1500.25, cropRiverPoolM3: null });
		expect(after.demandObjects).toEqual([{ ...town, rank: null, schedule: null, population: null, source: null }]);
	});
});

describe('the grid and the provenance', () => {
	it('the loader writes the dataset row and only the cells with cropland, and a reload replaces them', async () => {
		const count = async () => (await asOwner(`SELECT count(*)::integer AS n FROM cropland_cell_reference WHERE dataset = 'synthetic'`))[0]!.n as number;
		const n = await count();
		// The fixture's cells (backend/fixtures/geo/land-cover.synthetic.json), none with a share of 0.
		expect(n).toBe(1159);
		const [d] = await asOwner(`SELECT cell_deg, classes, version FROM cropland_dataset WHERE dataset = 'synthetic'`);
		expect(d).toEqual({ cell_deg: 0.005, classes: [40], version: 'synthetic 1' });
		await asOwner(`UPDATE cropland_cell_reference SET fraction = 1 WHERE dataset = 'synthetic' AND row_idx = -6736 AND col_idx = 4262`);
		expect(await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!)).toEqual({ written: 1159, problems: [] });
		expect(await count()).toBe(1159);
		const [cell] = await asOwner(`SELECT fraction FROM cropland_cell_reference WHERE dataset = 'synthetic' AND row_idx = -6736 AND col_idx = 4262`);
		expect(cell!.fraction).toBe(0.5);
	});

	it('the provenance names only its own project’s crop, and a parcel basis names its parcel', async () => {
		const otherCrop = await asOwner('SELECT id FROM crop WHERE project_id = $1 LIMIT 1', [otherProjectId]);
		expect(otherCrop).toHaveLength(1);
		const insert = (cropId: string, basis: string, featureName: string | null) =>
			withUser(editor.id, (db) =>
				db.query(
					`INSERT INTO crop_area_land_cover (project_id, node_id, crop_id, area_m2, dataset, source, version, method, basis, feature_name)
					 VALUES ($1, $2, $3, 1, 'synthetic', 's', 'v', 'm', $4, $5)`,
					[projectId, farmB.id, cropId, basis, featureName]
				)
			);
		await expect(insert(otherCrop[0]!.id as string, 'unit', null)).rejects.toThrow(/belongs to a different project/);
		await expect(insert(lucerne.id, 'parcel', null)).rejects.toThrow(/check constraint/);
		// Control: a well-formed row goes in (and out again).
		await insert(lucerne.id, 'unit', null);
		await withUser(editor.id, (db) => db.query('DELETE FROM crop_area_land_cover WHERE node_id = $1', [farmB.id]));
	});

	it('the grid is read-only to the app role (control: it reads it)', async () => {
		const read = await withUser(viewer.id, (db) => db.query(`SELECT version FROM cropland_dataset WHERE dataset = 'synthetic'`));
		expect(read.rows).toEqual([{ version: 'synthetic 1' }]);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE cropland_cell_reference SET fraction = 1 WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query(`DELETE FROM cropland_dataset WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
	});

	it('a project’s provenance is its members’ only (control: a viewer reads it)', async () => {
		const q = 'SELECT count(*)::integer AS n FROM crop_area_land_cover WHERE project_id = $1';
		expect((await withUser(viewer.id, (db) => db.query(q, [projectId]))).rows[0].n).toBe(2);
		expect((await withUser(stranger.id, (db) => db.query(q, [projectId]))).rows[0].n).toBe(0);
		await expect(
			withUser(viewer.id, (db) => db.query(`UPDATE crop_area_land_cover SET area_m2 = 1 WHERE project_id = $1 RETURNING 1`, [projectId]).then((r) => r.rowCount))
		).resolves.toBe(0);
	});
});
