// A unit's polygon for every per-unit proposal (issue #646 F1,
// geo/unitPolygon.ts): the area feature its area was accepted from, of either
// area kind, else its only linked farm parcel. Before, only farm parcels
// counted, so units whose boundary is an *other* area (as Sub-catchments from
// clicks saves them and Start links them) had no polygon anywhere.
//
// One project, region Z (inside the CHIRPS fixture's cover, the synthetic
// land cover's 0.5 block and the synthetic MAP grid):
//  - Parcel unit: a linked farm parcel, its area typed (the case before, unchanged: the positive control);
//  - Piece unit: an *other* area linked to it, its area accepted from it (as Start leaves it);
//  - Loose unit: an *other* area not linked to it, its area accepted from it;
//  - Typed unit: an *other* area linked to it but its area typed: no area feature, so no polygon (an other area
//    alone is not a unit's outline);
// each read through Rain for each unit, MAP for each unit, the land-cover
// proposal (and its accept) and the reference cell, as an editor under RLS;
// a stranger still meets 404.
import type { UnitRainSettings } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticLandCover } from '../../scripts/import-land-cover.js';
import { loadSyntheticMapGrid } from '../../scripts/import-map-grid.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { referenceCell } from '../runs/referenceCell.js';
import { AREA_KINDS } from './routes.js';
import { UNIT_POLYGONS_SQL } from './unitPolygon.js';

type User = Awaited<ReturnType<typeof signUp>>;

const rect = (w: number, s: number, e: number, n: number) => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});
const PARCEL = rect(21.31, -33.69, 21.315, -33.685);
const PIECE = rect(21.32, -33.69, 21.325, -33.685);
const LOOSE = rect(21.33, -33.69, 21.335, -33.685);
const TYPED = rect(21.34, -33.69, 21.345, -33.685);

let owner: User;
let editor: User;
let stranger: User;
let pid: string;
const outlet = node('Weir', null);
const parcelUnit = node('Parcel unit', outlet.id);
const pieceUnit = node('Piece unit', outlet.id);
const looseUnit = node('Loose unit', outlet.id);
const typedUnit = node('Typed unit', outlet.id);
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: Array(12).fill(0.9) };
const featureOf: Record<string, string> = {};

async function feature(kind: 'farm_parcel' | 'other', name: string, nodeId: string | null, geometry: unknown) {
	const r = await editor.call('POST', `/projects/${pid}/map/features`, { kind, name, nodeId, geometry });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feature.id as string;
}

beforeAll(async () => {
	[owner, editor, stranger] = (await Promise.all(['UPowner', 'UPeditor', 'UPstranger'].map((n) => signUp(n)))) as [User, User, User];
	pid = (await owner.call('POST', '/projects', { name: 'Unit polygons' })).body.project.id;
	expect((await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	const put = await owner.call('PUT', `/projects/${pid}/model`, { nodes: [outlet, parcelUnit, pieceUnit, looseUnit, typedUnit], crops: [lucerne], cropAreas: [], transfers: [] });
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!);
	await loadSyntheticMapGrid(process.env.TEST_MIGRATION_DATABASE_URL!);
	featureOf[parcelUnit.id] = await feature('farm_parcel', 'Parcel', parcelUnit.id, PARCEL);
	featureOf[pieceUnit.id] = await feature('other', 'Piece', pieceUnit.id, PIECE);
	featureOf[looseUnit.id] = await feature('other', 'Loose', null, LOOSE);
	featureOf[typedUnit.id] = await feature('other', 'Typed', typedUnit.id, TYPED);
	for (const n of [pieceUnit, looseUnit]) {
		const r = await editor.call('POST', `/projects/${pid}/nodes/${n.id}/area-from-map`, { featureId: featureOf[n.id] });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
	}
});

const ids = (rows: { nodeId: string }[]) => rows.map((r) => r.nodeId).sort();
const withPolygon = [parcelUnit.id, pieceUnit.id, looseUnit.id].sort();

describe('a unit’s polygon (issue #646 F1)', () => {
	it('names the area kinds the routes accept for a unit’s area', () => {
		for (const k of AREA_KINDS) expect(UNIT_POLYGONS_SQL).toContain(`'${k}'`);
	});

	it('Rain for each unit proposes cells for the parcel unit (unchanged) and for units whose area is an other area; the typed one has none', async () => {
		const r = await editor.call('GET', `/projects/${pid}/feeds/chirps/from-units`);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(ids(r.body.units)).toEqual(withPolygon);
		for (const u of r.body.units) {
			expect(u.featureId).toBe(featureOf[u.nodeId]);
			expect(u.cells.length).toBeGreaterThan(0);
		}
		expect(ids(r.body.withoutPolygon)).toEqual([typedUnit.id]);
		expect(r.body.refused).toEqual([]);
		expect((await stranger.call('GET', `/projects/${pid}/feeds/chirps/from-units`)).status).toBe(404);
	});

	it('MAP for each unit places the same units, and lists the typed one without a polygon', async () => {
		const r = await editor.call('GET', `/projects/${pid}/map/unit-map`);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const placed = [...r.body.units, ...r.body.uncovered] as { nodeId: string; featureId?: string }[];
		expect(ids(placed)).toEqual(withPolygon);
		for (const u of r.body.units as { nodeId: string; featureId: string }[]) expect(u.featureId).toBe(featureOf[u.nodeId]);
		expect(ids(r.body.withoutPolygon)).toEqual([typedUnit.id]);
	});

	it('the land cover sums over the parcel, or over the other area a unit’s area came from, and accepts it', async () => {
		const parcel = (await editor.call('GET', `/projects/${pid}/nodes/${parcelUnit.id}/cropland-proposals`)).body;
		expect(parcel.parcels.map((p: { featureId: string }) => p.featureId)).toEqual([featureOf[parcelUnit.id]]);
		expect(parcel.unit.cultivatedM2).toBeGreaterThan(0);
		const piece = (await editor.call('GET', `/projects/${pid}/nodes/${pieceUnit.id}/cropland-proposals`)).body;
		expect(piece.parcels.map((p: { featureId: string }) => p.featureId)).toEqual([featureOf[pieceUnit.id]]);
		expect(piece.unit.cultivatedM2).toBeGreaterThan(0);
		const typed = (await editor.call('GET', `/projects/${pid}/nodes/${typedUnit.id}/cropland-proposals`)).body;
		expect(typed.parcels).toEqual([]);
		const used = await editor.call('POST', `/projects/${pid}/nodes/${pieceUnit.id}/crop-area-from-land-cover`, { cropId: lucerne.id, dataset: piece.dataset.dataset });
		expect(used.status, JSON.stringify(used.body)).toBe(200);
		expect(used.body.areaM2).toBe(piece.unit.cultivatedM2);
		const [last] = await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [pid]);
		expect(last!.reason).toContain('cultivated in its area “Piece”');
		expect((await editor.call('POST', `/projects/${pid}/nodes/${typedUnit.id}/crop-area-from-land-cover`, { cropId: lucerne.id, dataset: piece.dataset.dataset })).status).toBe(400);
	});

	it('the reference cell sits in the other area a unit’s area came from; none for the typed unit', async () => {
		const ref = (unitId: string) =>
			withUser(editor.id, (db) => referenceCell(db, pid, { reference: { gauge: 'rain_catchment_mm', unitId } } as unknown as UnitRainSettings, {}));
		const piece = await ref(pieceUnit.id);
		expect(piece).toMatchObject({ unitId: pieceUnit.id });
		expect(piece!.lon).toBeCloseTo(21.3225, 4);
		expect(piece!.lat).toBeCloseTo(-33.6875, 4);
		expect((await ref(parcelUnit.id))!.lon).toBeCloseTo(21.3125, 4);
		expect(await ref(typedUnit.id)).toBeNull();
	});
});
