// The registered irrigated area (244_allocation_irrigated_area.sql,
// docs/allocations.md § What is stored): a take's hectares, from a WARMS
// extract or typed in, never a model input.
//  - a WARMS extract's area lands on its 21(a) rows, its dam capacity on the
//    21(b) rows, and an area on a 21(b) row is refused;
//  - typed in and changed through the API, refused on a storage-only row,
//    and 244's CHECK refuses one written past the API;
//  - changing it leaves the latest run current (not a run input);
//  - the export writes it and reads back;
//  - RLS: a viewer reads it only with each volume (positive control: on).
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { allocationsForRun } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let projectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id, { damCapacityM3: 150_000 });

const EXTRACT = [
	'Registration Number,Farm Name,Registered User,Resource Type,Water Use,Registered Volume,Unit,Dam Capacity (m3),Irrigated Area (ha)',
	'IA-1,Farm A,Invented Holder,Surface,21(a),"60,000",m3/a,,"42.5"',
	'IA-1,Farm A,Invented Holder,Surface,21(b),,m3,"100,000",',
	'IA-2,Farm A,Invented Holder,Surface,21(b),,m3,"20,000",3'
].join('\n');

const updatedAt = async () => (await asOwner(`SELECT updated_at::text AS u FROM project WHERE id = $1`, [projectId]))[0]!.u as string;

beforeAll(async () => {
	[owner, viewer] = (await Promise.all(['IAowner', 'IAviewer'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Irrigated area' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
}, 60_000);

describe('importing a WARMS extract with irrigated areas', () => {
	const body = { kind: 'warms_extract', fileName: 'areas.csv', text: EXTRACT, reference: 'synthetic' };

	it('previews the area on the take and the dam capacity on the storage row; refuses an area on a 21(b) row', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import`, body);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.columns).toMatchObject({ irrigatedAreaHa: 'Irrigated Area (ha)', storageM3: 'Dam Capacity (m3)' });
		const by = (line: number) => res.body.rows.find((r: { line: number }) => r.line === line);
		expect(by(2)).toMatchObject({ waterUse: '21a', volumeM3PerYear: 60_000, irrigatedAreaHa: 42.5, errors: [] });
		expect(by(3)).toMatchObject({ waterUse: '21b', storageM3: 100_000, irrigatedAreaHa: null, errors: [] });
		expect(by(4).errors).toContain('a 21(b) storage row registers no irrigated area: give it on the 21(a) take row');
	});

	it('stores the area with the take', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import/commit`, body);
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const list = await owner.call('GET', `/projects/${projectId}/allocations`);
		const take = list.body.allocations.find((a: { registrationNo: string; waterUse: string }) => a.registrationNo === 'IA-1' && a.waterUse === '21a');
		const dam = list.body.allocations.find((a: { registrationNo: string; waterUse: string }) => a.registrationNo === 'IA-1' && a.waterUse === '21b');
		expect(take).toMatchObject({ irrigatedAreaHa: 42.5, nodeId: farmA.id });
		expect(dam).toMatchObject({ irrigatedAreaHa: null, storageM3: 100_000 });
		expect(list.body.allocations.some((a: { registrationNo: string }) => a.registrationNo === 'IA-2')).toBe(false);
	});
});

describe('an area typed in or changed', () => {
	let id: string;

	it('is stored on a take, and refused on a storage-only row', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: farmA.id,
			authorisation: 'licence',
			waterSource: 'surface',
			volumeM3PerYear: 9_000,
			irrigatedAreaHa: 12.75
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.allocation.irrigatedAreaHa).toBe(12.75);
		id = res.body.allocation.id;
		const dam = await owner.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: farmA.id,
			authorisation: 'licence',
			waterSource: 'surface',
			waterUse: '21b',
			volumeM3PerYear: 0,
			storageM3: 5_000,
			irrigatedAreaHa: 4
		});
		expect(dam.status).toBe(400);
		expect(JSON.stringify(dam.body)).toMatch(/registers no irrigated area/);
		for (const bad of [-1, 1e7]) expect((await owner.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmA.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1, irrigatedAreaHa: bad })).status, String(bad)).toBe(400);
	});

	it('a change leaves the latest run current: the model never reads it', async () => {
		const before = await updatedAt();
		const res = await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, { irrigatedAreaHa: 20 });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.allocation.irrigatedAreaHa).toBe(20);
		expect(await updatedAt()).toBe(before);
		const forRun = await withUser(owner.id, (db) => allocationsForRun(db, projectId));
		for (const a of forRun) expect(Object.hasOwn(a, 'irrigatedAreaHa')).toBe(false);
		// Clearing it is a change too.
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, { irrigatedAreaHa: null })).body.allocation.irrigatedAreaHa).toBeNull();
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, { irrigatedAreaHa: 20 })).status).toBe(200);
	});

	it('making a take with an area storage-only is refused until the area is cleared', async () => {
		const toDam = { waterUse: '21b', volumeM3PerYear: 0, storageM3: 1_000 };
		const res = await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, toDam);
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/registers no irrigated area/);
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, { ...toDam, irrigatedAreaHa: null })).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${id}`, { waterUse: '21a', volumeM3PerYear: 9_000, irrigatedAreaHa: 20 })).status).toBe(200);
	});

	it('244’s CHECK refuses one written past the API', async () => {
		await expect(
			asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year, storage_m3, water_use, irrigated_area_ha) VALUES ($1, 'licence', 'surface', 0, 5, '21b', 3)`, [projectId])
		).rejects.toThrow(/allocation_irrigated_area_take_check/);
		await expect(asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year, irrigated_area_ha) VALUES ($1, 'licence', 'surface', 1, -1)`, [projectId])).rejects.toThrow(
			/allocation_irrigated_area_ha_check/
		);
	});
});

describe('the export', () => {
	it('writes irrigated_area_ha, and the file reads back with it', async () => {
		const r = await app.request(`/projects/${projectId}/allocations/export.csv`, { headers: { cookie: owner.cookie, origin: 'http://localhost:7777' } });
		const text = await r.text();
		expect(text.split('\r\n')[0]!.split(',')).toContain('irrigated_area_ha');
		const back = await owner.call('POST', `/projects/${projectId}/allocations/import`, { kind: 'csv', fileName: 'back.csv', text, reference: '' });
		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(back.body.summary.invalid).toBe(0);
		const areas = back.body.rows.map((x: { irrigatedAreaHa: number | null }) => x.irrigatedAreaHa).filter((a: number | null) => a !== null);
		expect(areas.sort()).toEqual([20, 42.5]);
	});
});

describe('who reads it', () => {
	it('a viewer reads no row while each volume is hidden, and the area with it once it is on', async () => {
		const hidden = await viewer.call('GET', `/projects/${projectId}/allocations`);
		expect(hidden.status).toBe(200);
		expect(hidden.body.allocations).toEqual([]);
		expect((await owner.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true })).status).toBe(200);
		const shown = await viewer.call('GET', `/projects/${projectId}/allocations`);
		expect(shown.body.allocations.map((a: { irrigatedAreaHa: number | null }) => a.irrigatedAreaHa).filter((a: number | null) => a !== null).sort()).toEqual([20, 42.5]);
	});
});
