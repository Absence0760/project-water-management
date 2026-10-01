// Dam values proposed from the register of dams and the map (issue #326
// B-dams; 154_dam_register.sql, geo/damRoutes.ts), end to end against
// Postgres with the committed synthetic register loaded:
//  - a viewer reads a unit's proposals: the registered dams within 1 km of
//    its dam on the map, nearest first, marked synthetic, with their source,
//    and the dam polygon's area; a dam further away is never proposed;
//  - an editor accepts a registered capacity and the polygon's area, each
//    one value, each a model revision whose reason names the source; a viewer
//    can't; a dam not proposed for this unit, a point's area, a dam linked to
//    another unit and a unit with no dam capacity are refused;
//  - a gauge is 400, another project's node or feature 404, a stranger 404;
//  - the register is read-only to the app role (control: it reads it).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticDamRegister } from '../../scripts/import-dam-register.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id, { damCapacityM3: 0, damAreaFullM2: null });
/** Round the synthetic register's Z100/07 (21.3247, -33.678): a 200 m square, ~250 m from it. */
const DAM_A = [[[21.321, -33.679], [21.3231, -33.679], [21.3231, -33.6772], [21.321, -33.6772], [21.321, -33.679]]];

const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const proposals = (u: User, nodeId: string, pid = projectId) => u.call('GET', at(`/nodes/${nodeId}/dam-proposals`, pid));
const lastReason = async () => (await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]))[0]!.reason as string;
const modelNode = async (id: string) => (await editor.call('GET', at('/model'))).body.nodes.find((n: { id: string }) => n.id === id);

let damAId: string;
let pointDamId: string;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Downer', 'Deditor', 'Dviewer', 'Dstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Dams from the register' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere dams' })).body.project.id;
	await loadSyntheticDamRegister(process.env.TEST_MIGRATION_DATABASE_URL!);
	const a = await editor.call('POST', at('/map/features'), { kind: 'dam', name: 'Bo-dam outline', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: DAM_A } });
	expect(a.status, JSON.stringify(a.body)).toBe(201);
	damAId = a.body.feature.id;
	// Farm B's dam is a point, far from any registered dam.
	const b = await editor.call('POST', at('/map/features'), { kind: 'dam', name: 'B dam', lon: 21.45, lat: -33.95, nodeId: farmB.id });
	expect(b.status).toBe(201);
	pointDamId = b.body.feature.id;
}, 60_000);

describe('the proposals', () => {
	it('lists the registered dams within 1 km, marked synthetic with their source, and the dam polygon’s area, for a viewer', async () => {
		const res = await proposals(viewer, farmA.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ nodeId: farmA.id, nodeName: 'Farm A', radiusM: 1000, current: { damCapacityM3: 100_000, damAreaFullM2: null } });
		expect(res.body.dam).toMatchObject({ id: damAId, name: 'Bo-dam outline', geometryType: 'Polygon' });
		expect(res.body.register.map((d: { registerNo: string }) => d.registerNo)).toEqual(['Z100/07']);
		const [d] = res.body.register;
		expect(d).toMatchObject({ name: 'Bo-dam', capacityM3: 140_000, wallHeightM: 6.5, dataset: 'synthetic', synthetic: true, source: expect.stringMatching(/^SYNTHETIC .*Z100\/07$/) });
		expect(d.distanceM).toBeGreaterThan(200);
		expect(d.distanceM).toBeLessThan(400);
		expect(res.body.area).toMatchObject({ featureId: damAId, featureName: 'Bo-dam outline' });
		expect(res.body.area.areaM2).toBeGreaterThan(30_000);
		expect(res.body.area.areaM2).toBeLessThan(50_000);
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 8 }]));
	});

	it('proposes no registered dam far from the dam, and no area for a point', async () => {
		const res = await proposals(viewer, farmB.id);
		expect(res.status).toBe(200);
		expect(res.body.dam).toMatchObject({ id: pointDamId, geometryType: 'Point', areaM2: null });
		expect(res.body.register).toEqual([]);
		expect(res.body.area).toBeNull();
	});

	it('says there is no dam on the map for a unit without one', async () => {
		expect((await editor.call('PATCH', at(`/map/features/${pointDamId}`), { nodeId: null })).status).toBe(200);
		const res = await proposals(viewer, farmB.id);
		expect(res.body).toMatchObject({ dam: null, register: [], area: null });
		expect((await editor.call('PATCH', at(`/map/features/${pointDamId}`), { nodeId: farmB.id })).status).toBe(200);
	});

	it('is 400 for a gauge, 404 for another project’s node, a bad id and a stranger', async () => {
		expect((await proposals(viewer, outlet.id)).status).toBe(400);
		const theirs = node('Their farm', null);
		expect((await stranger.call('PUT', at('/model', otherProjectId), { nodes: [theirs], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await proposals(viewer, theirs.id)).status).toBe(404);
		expect((await proposals(viewer, 'not-a-uuid')).status).toBe(404);
		expect((await proposals(stranger, farmA.id)).status).toBe(404);
	});
});

describe('accepting a capacity from the register', () => {
	const accept = (u: User, nodeId: string, registerNo: string) => u.call('POST', at(`/nodes/${nodeId}/dam-capacity-from-register`), { registerNo });

	it('sets the dam’s capacity and records a revision naming the registered dam and its source; a viewer can’t', async () => {
		expect((await accept(viewer, farmA.id, 'Z100/07')).status).toBe(403);
		expect((await modelNode(farmA.id)).damCapacityM3).toBe(100_000);
		const res = await accept(editor, farmA.id, 'z100/07');
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ nodeId: farmA.id, damCapacityM3: 140_000, registerNo: 'Z100/07', revisionId: expect.any(String) });
		expect((await modelNode(farmA.id)).damCapacityM3).toBe(140_000);
		expect(await lastReason()).toMatch(/^Dam capacity of Farm A from the register of dams: Bo-dam \(Z100\/07, 140000 m³, \d+ m from “Bo-dam outline”; SYNTHETIC .*Z100\/07\)$/);
	});

	it('refuses a registered dam not proposed for this unit, and a unit with no dam on the map; the capacity stays', async () => {
		for (const no of ['Z100/08', 'Z999/99']) {
			const res = await accept(editor, farmA.id, no);
			expect(res.status).toBe(400);
			expect(res.body.error).toMatch(/is not within 1 km of “Bo-dam outline”/);
		}
		expect((await editor.call('PATCH', at(`/map/features/${pointDamId}`), { nodeId: null })).status).toBe(200);
		expect((await accept(editor, farmB.id, 'Z100/07')).body.error).toMatch(/^No dam on the map is linked to Farm B/);
		expect((await editor.call('PATCH', at(`/map/features/${pointDamId}`), { nodeId: farmB.id })).status).toBe(200);
		expect((await accept(editor, outlet.id, 'Z100/07')).status).toBe(400);
		expect((await modelNode(farmA.id)).damCapacityM3).toBe(140_000);
	});
});

describe('accepting a full-supply area from the dam polygon', () => {
	const accept = (u: User, nodeId: string, featureId: string) => u.call('POST', at(`/nodes/${nodeId}/dam-area-from-map`), { featureId });

	it('sets the dam’s full-supply area to the polygon’s and records a revision naming the dam; a viewer can’t', async () => {
		expect((await accept(viewer, farmA.id, damAId)).status).toBe(403);
		const area = (await proposals(viewer, farmA.id)).body.area.areaM2 as number;
		const res = await accept(editor, farmA.id, damAId);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ nodeId: farmA.id, areaFeatureId: damAId, revisionId: expect.any(String) });
		expect(res.body.damAreaFullM2).toBeCloseTo(area, 6);
		expect((await modelNode(farmA.id)).damAreaFullM2).toBeCloseTo(area, 6);
		expect(await lastReason()).toMatch(/^Dam full-supply area of Farm A from the map: “Bo-dam outline” \(\d+ m², computed from its polygon\)$/);
	});

	it('refuses a point, a dam linked to another unit, a unit with no dam capacity, a parcel and another project’s feature', async () => {
		expect((await accept(editor, farmB.id, pointDamId)).body.error).toMatch(/is a point on the map/);
		expect((await accept(editor, farmB.id, damAId)).body.error).toMatch(/isn’t linked to Farm B/);
		const bPoly = await editor.call('POST', at('/map/features'), { kind: 'dam', name: 'B outline', nodeId: farmB.id, geometry: { type: 'Polygon', coordinates: [[[21.45, -33.95], [21.451, -33.95], [21.451, -33.949], [21.45, -33.949], [21.45, -33.95]]] } });
		expect(bPoly.status).toBe(201);
		const noCap = await accept(editor, farmB.id, bPoly.body.feature.id);
		expect(noCap.status).toBe(400);
		expect(noCap.body.error).toMatch(/has no dam capacity yet/);
		const parcel = await editor.call('POST', at('/map/features'), { kind: 'farm_parcel', name: 'A parcel', nodeId: farmA.id, geometry: { type: 'Polygon', coordinates: DAM_A } });
		expect((await accept(editor, farmA.id, parcel.body.feature.id)).body.error).toMatch(/Only a dam’s polygon/);
		const theirs = await stranger.call('POST', at('/map/features', otherProjectId), { kind: 'dam', geometry: { type: 'Polygon', coordinates: DAM_A } });
		expect(theirs.status).toBe(201);
		expect((await accept(editor, farmA.id, theirs.body.feature.id)).status).toBe(404);
		expect((await modelNode(farmB.id)).damAreaFullM2).toBeNull();
	});
});

describe('the register', () => {
	it('is read-only to the app role (control: it reads it)', async () => {
		const read = await withUser(viewer.id, (db) => db.query('SELECT name FROM dam_register_reference WHERE register_no = $1', ['Z100/07']));
		expect(read.rows).toEqual([{ name: 'Bo-dam' }]);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE dam_register_reference SET capacity_m3 = 1 WHERE register_no = 'Z100/07'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query('DELETE FROM dam_register_reference'))).rejects.toThrow(/permission denied/);
	});
});
