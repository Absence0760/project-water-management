// Orchards and vines from SANLC in the planted-areas proposals (issue #604
// R5-D; 259_crop_type_reference.sql, geo/cropTypes.ts, geo/croplandRoutes.ts),
// end to end against Postgres with the committed synthetic crop-type grid
// loaded (every cell [orchard 0.2, vine 0.1, new orchard 0.05, new vine 0]
// inside 21.30–21.35° E, 33.65–33.70° S):
//  - a viewer reads each linked parcel's orchards, vines and new plantings,
//    the unit's sums, and the dataset cited with its baseline edition;
//  - an editor uses the orchards (or one parcel's vines) as one crop's
//    planted area: a model revision citing the dataset and the class, and a
//    provenance row; a viewer can't; a layer with none, or an unknown
//    crop-type dataset, is a 400 and changes nothing;
//  - with no crop-type dataset loaded (production, until SANLC's terms are
//    recorded) the proposals carry `cropTypes: null` and a layer is refused;
//  - the loader writes the grid, and a reload replaces it; the grid is
//    read-only to the app role (control: it reads it) and unreadable with no user.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticCropTypes } from '../../scripts/import-crop-types.js';
import { loadSyntheticLandCover } from '../../scripts/import-land-cover.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { geometryAreaM2 } from './area.js';
import type { Position } from './geojson.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let projectId: string;
const outlet = node('Weir', null);
const farmA = node('Orchard farm', outlet.id);
const farmC = node('Veld farm', outlet.id);
const monthly = (v: number) => Array.from({ length: 12 }, () => v);
const apples = { id: crypto.randomUUID(), name: 'Apples', cropFactor: monthly(0.8) };
const grapes = { id: crypto.randomUUID(), name: 'Wine grapes', cropFactor: monthly(0.6) };
const rect = (w: number, s: number, e: number, n: number): Position[][] => [
	[
		[w, s],
		[e, s],
		[e, n],
		[w, n],
		[w, s]
	]
];
/** Inside the synthetic grid's uniform block: two parcels of the orchard farm; the veld farm's far outside the grid. */
const PARCEL_1 = rect(21.31, -33.69, 21.32, -33.68);
const PARCEL_2 = rect(21.325, -33.665, 21.33, -33.66);
const PARCEL_C = rect(21.6, -33.95, 21.61, -33.94);
const m2 = (r: Position[][]) => geometryAreaM2({ type: 'Polygon', coordinates: r })!;

const at = (p: string) => `/projects/${projectId}${p}`;
const proposals = (u: User, nodeId: string) => u.call('GET', at(`/nodes/${nodeId}/cropland-proposals`));
const accept = (u: User, nodeId: string, body: Record<string, unknown>) => u.call('POST', at(`/nodes/${nodeId}/crop-area-from-land-cover`), body);
const lastReason = async () => (await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]))[0]!.reason as string;
const cropArea = async (nodeId: string, cropId: string) =>
	(await editor.call('GET', at('/model'))).body.cropAreas.find((a: { nodeId: string; cropId: string }) => a.nodeId === nodeId && a.cropId === cropId)?.areaM2 as number | undefined;
const url = () => process.env.TEST_MIGRATION_DATABASE_URL!;

let parcel2: string;

beforeAll(async () => {
	[owner, editor, viewer] = (await Promise.all(['Cowner', 'Ceditor', 'Cviewer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Orchards and vines' })).body.project.id;
	const put = await owner.call('PUT', at('/model'), { nodes: [outlet, farmA, farmC], crops: [apples, grapes], cropAreas: [], transfers: [] });
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	await loadSyntheticLandCover(url());
	await loadSyntheticCropTypes(url());
	const place = async (body: Record<string, unknown>) => {
		const res = await editor.call('POST', at('/map/features'), body);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.feature.id as string;
	};
	await place({ kind: 'farm_parcel', name: 'Lower block', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: PARCEL_1 } });
	parcel2 = await place({ kind: 'farm_parcel', name: 'Top block', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: PARCEL_2 } });
	await place({ kind: 'farm_parcel', name: 'Veld', nodeId: farmC.id, geometry: { type: 'Polygon', coordinates: PARCEL_C } });
}, 60_000);

// Leave the synthetic grid loaded for whatever runs next (the e2e and dev setups load it too).
afterAll(async () => {
	await loadSyntheticCropTypes(url());
});

describe('the proposals', () => {
	it('give a viewer each parcel’s orchards, vines and new plantings, the unit’s sums, and the dataset cited', async () => {
		const res = await proposals(viewer, farmA.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const t = res.body.cropTypes;
		expect(t.dataset).toMatchObject({
			dataset: 'synthetic',
			version: 'synthetic 2022',
			baselineVersion: 'synthetic 2018',
			cellDeg: 0.005,
			orchardClasses: [32],
			vineClasses: [33],
			synthetic: true
		});
		expect(t.dataset.method).toMatch(/class 32 \(permanent orchards\) and in class 33 \(permanent vines\).*new plantings .* synthetic 2018 edition/);
		for (const [p, ring] of [
			[t.parcels[0], PARCEL_1],
			[t.parcels[1], PARCEL_2]
		] as const) {
			expect(p.areaM2).toBe(Math.round(m2(ring)));
			expect(p.orchardM2 / p.areaM2).toBeCloseTo(0.2, 3);
			expect(p.vineM2 / p.areaM2).toBeCloseTo(0.1, 3);
			expect(p.newOrchardM2 / p.areaM2).toBeCloseTo(0.05, 3);
			expect(p.newVineM2).toBe(0);
		}
		expect(t.parcels.map((p: { featureId: string }) => p.featureId)).toEqual(res.body.parcels.map((p: { featureId: string }) => p.featureId));
		expect(t.unit).toEqual({
			areaM2: t.parcels[0].areaM2 + t.parcels[1].areaM2,
			orchardM2: t.parcels[0].orchardM2 + t.parcels[1].orchardM2,
			vineM2: t.parcels[0].vineM2 + t.parcels[1].vineM2,
			newOrchardM2: t.parcels[0].newOrchardM2 + t.parcels[1].newOrchardM2,
			newVineM2: 0
		});
		// The land cover's proposals stand beside them, unchanged.
		expect(res.body.dataset).toMatchObject({ dataset: 'synthetic', classes: [40] });
	});
});

describe('using orchards or vines as a crop’s planted area', () => {
	it('sets the crop’s area to the unit’s orchards and cites the dataset and class; a viewer can’t', async () => {
		expect((await accept(viewer, farmA.id, { cropId: apples.id, dataset: 'synthetic', layer: 'orchard' })).status).toBe(403);
		const unit = (await proposals(viewer, farmA.id)).body.cropTypes.unit;
		const res = await accept(editor, farmA.id, { cropId: apples.id, dataset: 'synthetic', layer: 'orchard' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ areaM2: unit.orchardM2, dataset: 'synthetic', layer: 'orchard', revisionId: expect.any(String) });
		expect(await cropArea(farmA.id, apples.id)).toBe(unit.orchardM2);
		expect(await lastReason()).toMatch(/^Planted area of Apples on Orchard farm from crop types: \d+\.\d\d ha of permanent orchards in its 2 parcels; Synthetic crop-type grid .*\(synthetic 2022; dataset “synthetic”\)\. Permanent orchards \(class 32\)\. Pre-summarised/);
		const crop = (await proposals(viewer, farmA.id)).body.crops.find((c: { cropId: string }) => c.cropId === apples.id);
		expect(crop.accepted).toMatchObject({ areaM2: unit.orchardM2, dataset: 'synthetic', version: 'synthetic 2022', basis: 'unit', layer: 'orchard', current: true, method: expect.stringMatching(/^Permanent orchards \(class 32\)\./) });
	});

	it('takes one parcel’s vines as another crop’s', async () => {
		const p2 = (await proposals(viewer, farmA.id)).body.cropTypes.parcels[1];
		const res = await accept(editor, farmA.id, { cropId: grapes.id, dataset: 'synthetic', layer: 'vine', featureId: parcel2 });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.areaM2).toBe(p2.vineM2);
		expect(await lastReason()).toMatch(/^Planted area of Wine grapes on Orchard farm from crop types: \d+\.\d\d ha of permanent vines in the parcel “Top block”;/);
	});

	it('refuses a layer with none, an unknown dataset or layer; nothing changes', async () => {
		const before = await cropArea(farmA.id, apples.id);
		const err = async (nodeId: string, body: Record<string, unknown>) => {
			const res = await accept(editor, nodeId, body);
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			return res.body.error as string;
		};
		expect(await err(farmC.id, { cropId: apples.id, dataset: 'synthetic', layer: 'orchard' })).toMatch(/maps no permanent orchards in its parcel “Veld”/);
		expect(await err(farmA.id, { cropId: apples.id, dataset: 'SANLC-2022', layer: 'orchard' })).toMatch(/No crop-type dataset “SANLC-2022” is loaded/);
		expect(await err(farmA.id, { cropId: apples.id, dataset: 'synthetic', layer: 'pivot' })).toBeTruthy();
		expect(await cropArea(farmA.id, apples.id)).toBe(before);
	});
});

describe('with no crop-type dataset (production until SANLC’s terms are recorded)', () => {
	it('the proposals carry no crop types and a layer is refused; the land cover still proposes', async () => {
		await asOwner(`DELETE FROM crop_type_dataset WHERE dataset = 'synthetic'`);
		try {
			const b = (await proposals(viewer, farmA.id)).body;
			expect(b.cropTypes).toBeNull();
			expect(b.unit.cultivatedM2).toBeGreaterThan(0);
			expect((await accept(editor, farmA.id, { cropId: apples.id, dataset: 'synthetic', layer: 'orchard' })).status).toBe(400);
		} finally {
			await loadSyntheticCropTypes(url());
		}
	});
});

describe('the grid', () => {
	it('the loader writes the dataset row and only the cells with an orchard or a vine, and a reload replaces them', async () => {
		const count = async () => (await asOwner(`SELECT count(*)::integer AS n FROM crop_type_cell_reference WHERE dataset = 'synthetic'`))[0]!.n as number;
		// The fixture's cells (backend/fixtures/geo/crop-types.synthetic.json).
		expect(await count()).toBe(524);
		const [d] = await asOwner(`SELECT cell_deg, orchard_classes, vine_classes, version, baseline_version FROM crop_type_dataset WHERE dataset = 'synthetic'`);
		expect(d).toEqual({ cell_deg: 0.005, orchard_classes: [32], vine_classes: [33], version: 'synthetic 2022', baseline_version: 'synthetic 2018' });
		await asOwner(`UPDATE crop_type_cell_reference SET orchard = 1, vine = 0, new_orchard = 0 WHERE dataset = 'synthetic' AND row_idx = -6736 AND col_idx = 4262`);
		expect(await loadSyntheticCropTypes(url())).toEqual({ written: 524, problems: [] });
		expect(await count()).toBe(524);
		const [cell] = await asOwner(`SELECT orchard, vine, new_orchard, new_vine FROM crop_type_cell_reference WHERE dataset = 'synthetic' AND row_idx = -6736 AND col_idx = 4262`);
		expect(cell).toEqual({ orchard: 0.2, vine: 0.1, new_orchard: 0.05, new_vine: 0 });
	});

	it('refuses a new-planting share larger than its layer’s', async () => {
		await expect(asOwner(`UPDATE crop_type_cell_reference SET new_vine = 0.5 WHERE dataset = 'synthetic' AND row_idx = -6736 AND col_idx = 4262`)).rejects.toThrow(/check constraint/);
	});

	it('is unreadable with no signed-in user (control: a viewer reads it, below)', async () => {
		const rows = await withoutUser((db) =>
			db.query(`SELECT (SELECT count(*)::integer FROM crop_type_dataset) AS datasets, (SELECT count(*)::integer FROM crop_type_cell_reference) AS cells`)
		);
		expect(rows.rows).toEqual([{ datasets: 0, cells: 0 }]);
	});

	it('is read-only to the app role (control: it reads it)', async () => {
		const read = await withUser(viewer.id, (db) => db.query(`SELECT version FROM crop_type_dataset WHERE dataset = 'synthetic'`));
		expect(read.rows).toEqual([{ version: 'synthetic 2022' }]);
		const cells = await withUser(viewer.id, (db) => db.query(`SELECT count(*)::integer AS n FROM crop_type_cell_reference WHERE dataset = 'synthetic'`));
		expect(cells.rows).toEqual([{ n: 524 }]);
		await expect(
			withUser(editor.id, (db) => db.query(`INSERT INTO crop_type_dataset (dataset, source, version, method, attribution, cell_deg, orchard_classes, vine_classes) VALUES ('x', 's', 'v', 'm', 'a', 0.01, '{32}', '{33}')`))
		).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE crop_type_cell_reference SET orchard = 1 WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query(`DELETE FROM crop_type_dataset WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
	});
});
