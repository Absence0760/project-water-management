// Field history (GET /projects/:id/history/fields, docs/api.md § Field
// history): per-field change counts from the project's revisions, who may
// read them, and that RLS keeps them to the project's members. Every "cannot
// see" has its positive control. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { fieldHistory } from './fields.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProject: string;

const outlet = node('Weir', null);
const farm = node('Hilltop', outlet.id, { damCapacityM3: 100_000 });
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const model = (o: { name?: string; dam?: number; areaM2?: number } = {}) => ({
	nodes: [outlet, { ...farm, name: o.name ?? farm.name, damCapacityM3: o.dam ?? 100_000 }],
	crops: [crop],
	cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: o.areaM2 ?? 100_000 }],
	transfers: []
});

// Node ids are unique across projects.
const weir2 = node('Weir', null);
const farm2 = node('Hilltop', weir2.id);
const elsewhere = (dam: number) => ({ nodes: [weir2, { ...farm2, damCapacityM3: dam }], crops: [], cropAreas: [], transfers: [] });

const fields = (u: User, pid = projectId) => u.call('GET', `/projects/${pid}/history/fields`);

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Fowner', 'Ann', 'Fviewer', 'Ffarmer', 'Fstranger'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Field history' })).body.project.id;
	for (const [u, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	const put = async (m: ReturnType<typeof model>) => expect((await editor.call('PUT', `/projects/${projectId}/model`, m)).status).toBe(200);
	await put(model());
	await put(model({ dam: 150_000 }));
	// A rename in the same save: the field keeps one count, keyed by the node's id.
	await put(model({ name: 'Hilltop East', dam: 200_000, areaM2: 120_000 }));
	for (const lakeEvapFactor of [0.8, 0.7]) {
		expect((await editor.call('PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactor } })).status).toBe(200);
	}
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);

	// Someone else's project, with its own changes: never counted here.
	otherProject = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
	for (const dam of [100_000, 300_000]) {
		expect((await stranger.call('PUT', `/projects/${otherProject}/model`, elsewhere(dam))).status).toBe(200);
	}
}, 60_000);

describe('GET /projects/:id/history/fields', () => {
	it('counts each field’s changes, with the last one’s values, author and filter words', async () => {
		const res = await fields(viewer);
		expect(res.status).toBe(200);
		const f = res.body.fields;
		expect(f[`node:${farm.id}:damCapacityM3`]).toMatchObject({
			count: 2,
			lastBy: 'Ann',
			change: '150\u202f000 m³ → 200\u202f000 m³',
			filter: 'Hilltop East: dam capacity'
		});
		expect(f[`crop:${farm.id}:${crop.id}`]).toMatchObject({ count: 1, change: '10 ha → 12 ha', filter: '"Lucerne" Hilltop East' });
		expect(f['settings:lakeEvapFactor']).toMatchObject({ count: 2, lastBy: 'Ann', change: '0.8 → 0.7', filter: 'Dam evaporation factor (× A-pan)' });
		expect(new Date(f['settings:lakeEvapFactor'].lastAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
		// What was only ever added (the first save) or never changed isn't listed.
		expect(f[`node:${farm.id}:areaKm2`]).toBeUndefined();
		expect(f[`node:${outlet.id}:damCapacityM3`]).toBeUndefined();
	});

	it('counts a planted area added or removed, as 0 ha', async () => {
		const pid = (await editor.call('POST', '/projects', { name: 'Areas' })).body.project.id;
		const w = node('Weir', null);
		const f3 = node('Kloof', w.id);
		const c3 = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(0.9) };
		const put = async (areaM2: number) =>
			expect(
				(
					await editor.call('PUT', `/projects/${pid}/model`, {
						nodes: [w, f3],
						crops: [c3],
						cropAreas: areaM2 ? [{ nodeId: f3.id, cropId: c3.id, areaM2 }] : [],
						transfers: []
					})
				).status
			).toBe(200);
		const key = `crop:${f3.id}:${c3.id}`;
		await put(0);
		await put(50_000);
		expect((await fields(editor, pid)).body.fields[key]).toMatchObject({ count: 1, change: '0 ha → 5 ha', filter: '"Maize" Kloof' });
		await put(0);
		expect((await fields(editor, pid)).body.fields[key]).toMatchObject({ count: 2, change: '5 ha → 0 ha' });
	});

	it('keys the supply rule, the river pump and the operating rules (engine 1.31.0), the monthly rows included', async () => {
		const pid = (await editor.call('POST', '/projects', { name: 'Operating rules' })).body.project.id;
		const w = node('Weir', null);
		const f4 = node('Vlei', w.id, { damCapacityM3: 50_000, divertCapacityM3Day: 400 });
		const put = async (o: Record<string, unknown>) =>
			expect((await editor.call('PUT', `/projects/${pid}/model`, { nodes: [w, { ...f4, ...o }], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const winter = [0, 0, 0, 0, 0, 0, 0, 800, 800, 800, 800, 800];
		await put({});
		await put({ supplyRule: 'riverFirst', pumpCapacityM3Day: 1200, handsOffM3Day: monthly(300), handsOffEwr: true, divertMonthlyM3Day: winter });
		const f = (await fields(editor, pid)).body.fields;
		const key = (k: string) => `node:${f4.id}:${k}`;
		expect(f[key('supplyRule')]).toMatchObject({ count: 1, change: 'dam only → river first', filter: 'Vlei: supply rule' });
		expect(f[key('pumpCapacityM3Day')]).toMatchObject({ count: 1, change: 'no limit → 1\u202f200 m³/day' });
		expect(f[key('handsOffEwr')]).toMatchObject({ count: 1, change: 'no → yes', filter: 'Vlei: hands-off keeps the EWR' });
		// The monthly rows are keyed by their own labels, never as the one River to dam value (diversion capacity).
		expect(f[key('handsOffM3Day')]).toMatchObject({ count: 1, change: `none → ${new Array(12).fill('300').join(', ')} m³/day (Oct–Sep)`, filter: 'Vlei: hands-off flow' });
		expect(f[key('divertMonthlyM3Day')]).toMatchObject({
			count: 1,
			change: `the one diversion capacity → ${winter.join(', ')} m³/day (Oct–Sep)`,
			filter: 'Vlei: River to dam by month'
		});
		expect(f[key('divertCapacityM3Day')]).toBeUndefined();
	});

	it('is for members who see History: a farmer is refused, a stranger finds nothing', async () => {
		expect((await fields(owner)).status).toBe(200);
		expect((await fields(farmer)).status).toBe(403);
		expect((await fields(stranger)).status).toBe(404);
		// The stranger's own project answers them (positive control), with only its own fields.
		const own = await fields(stranger, otherProject);
		expect(own.status).toBe(200);
		expect(own.body.fields[`node:${farm2.id}:damCapacityM3`]).toMatchObject({ count: 1, change: '100\u202f000 m³ → 300\u202f000 m³' });
		expect(own.body.fields[`node:${farm.id}:damCapacityM3`]).toBeUndefined();
		expect((await fields(viewer)).body.fields[`node:${farm2.id}:damCapacityM3`]).toBeUndefined();
	});

	it('reads only what RLS shows the caller', async () => {
		expect(Object.keys(await withUser(viewer.id, (db) => fieldHistory(db, projectId))).length).toBeGreaterThan(0);
		expect(await withUser(farmer.id, (db) => fieldHistory(db, projectId))).toEqual({});
		expect(await withUser(stranger.id, (db) => fieldHistory(db, projectId))).toEqual({});
	});
});

describe('GET /projects/:id/history?q= (the link from a field)', () => {
	it('keeps only revisions with a change line holding every word, however old', async () => {
		const page = async (q: string) => (await viewer.call('GET', `/projects/${projectId}/history?kind=revision&limit=1&q=${encodeURIComponent(q)}`)).body;
		// limit=1: the older match is on the next page, not lost behind unrelated changes.
		const first = await page('HILLTOP dam capacity');
		expect(first.items.map((i: { changes: { text: string }[] }) => i.changes.map((c) => c.text))).toEqual([
			['Hilltop East: renamed from "Hilltop"', 'Hilltop East: dam capacity 150\u202f000 m³ → 200\u202f000 m³', 'Hilltop East: "Lucerne" area 10 ha → 12 ha']
		]);
		const next = (await viewer.call('GET', `/projects/${projectId}/history?kind=revision&limit=1&q=${encodeURIComponent('dam capacity')}&before=${encodeURIComponent(first.next)}`)).body;
		expect(next.items[0].changes.map((c: { text: string }) => c.text)).toEqual(['Hilltop: dam capacity 100\u202f000 m³ → 150\u202f000 m³']);
		expect(next.next).toBeNull();
		expect((await page('dam capacity nowhere')).items).toEqual([]);
		// Without words, every revision (positive control).
		expect((await viewer.call('GET', `/projects/${projectId}/history?kind=revision`)).body.items.length).toBeGreaterThan(3);
	});
});
