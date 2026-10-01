// The farm's map (issue #326 A3, decision D-A1/A3; farms/view.ts farmMap,
// docs/api.md § Farm): GET /projects/:id/farm/:nodeId/map answers a farmer
// their own farm's parcels and dams, with the boundary, rivers and gauges for
// orientation, and never a neighbour's parcel or dam:
//  - positive control: the farmer gets their own parcel and dam, and the
//    neighbour farmer, asking for their own farm, gets theirs (so the
//    neighbour's parcel is readable at all, and hiding it is the route's and
//    RLS's doing);
//  - the farmer's answer carries no trace of the neighbour's features, and the
//    neighbour's farm answers 404;
//  - a viewer previewing one farm sees that farm's features only, as its farmer does;
//  - a farm with nothing of its own on the map answers no features.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const MARKER = `nbr${crypto.randomUUID().slice(0, 8)}`;

let owner: User;
let viewer: User;
let farmer: User;
let neighbour: User;
let projectId: string;
const outlet = node('Weir', null);
const home = node('Home farm', outlet.id);
const theirs = node(`Neighbour ${MARKER}`, outlet.id);
const bare = node('Bare farm', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const box = (x: number, y: number, d: number) => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];
const polygon = (x: number, y: number, d: number) => ({ type: 'Polygon', coordinates: [box(x, y, d)] });
const ids: Record<string, string> = {};

async function place(name: string, body: Record<string, unknown>) {
	const r = await owner.call('POST', `/projects/${projectId}/map/features`, { name, ...body });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	ids[name] = r.body.feature.id;
}

/** A signed-in GET keeping the raw text, so a trace anywhere in the answer is caught. */
async function raw(u: User, path: string) {
	const r = await app.request(path, { headers: { cookie: u.cookie, origin: ORIGIN } });
	return { status: r.status, text: await r.text() };
}
const mapOf = (nodeId: string) => `/projects/${projectId}/farm/${nodeId}/map`;
type Feature = { id: string; kind: string; name: string; areaM2: number | null; center: [number, number] };

beforeAll(async () => {
	[owner, viewer, farmer, neighbour] = (await Promise.all(['Fmowner', 'Fmviewer', 'Fmfarmer', 'Fmneighbour'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Farm map' })).body.project.id;
	const model = { nodes: [outlet, home, theirs, bare], crops: [crop], cropAreas: [{ nodeId: home.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [home.id, bare.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: neighbour.email, nodeIds: [theirs.id] })).status).toBe(201);

	await place('Synthetic catchment', { kind: 'catchment_boundary', geometry: polygon(21.3, -33.7, 0.1) });
	await place('Home parcel', { kind: 'farm_parcel', nodeId: home.id, geometry: polygon(21.31, -33.69, 0.02) });
	await place('Home dam', { kind: 'dam', nodeId: home.id, lon: 21.32, lat: -33.68 });
	await place(`Parcel ${MARKER}`, { kind: 'farm_parcel', nodeId: theirs.id, geometry: polygon(21.35, -33.69, 0.02) });
	await place(`Dam ${MARKER}`, { kind: 'dam', nodeId: theirs.id, lon: 21.36, lat: -33.68 });
	await place('Weir gauge', { kind: 'gauge', nodeId: outlet.id, lon: 21.33, lat: -33.61 });
	await place('Sand river', { kind: 'river', geometry: { type: 'LineString', coordinates: [[21.3, -33.6], [21.4, -33.65]] } });
	await place(`Other ${MARKER}`, { kind: 'other', geometry: polygon(21.37, -33.67, 0.01) });
}, 60_000);

describe('GET /projects/:id/farm/:nodeId/map', () => {
	it('answers the farmer their own parcel and dam, own first, with the boundary, river and gauge', async () => {
		const r = await farmer.call('GET', mapOf(home.id));
		expect(r.status).toBe(200);
		const features = r.body.features as Feature[];
		expect(features.map((f) => [f.kind, f.name])).toEqual([
			['farm_parcel', 'Home parcel'],
			['dam', 'Home dam'],
			['gauge', 'Weir gauge'],
			['river', 'Sand river'],
			['catchment_boundary', 'Synthetic catchment']
		]);
		const parcel = features[0]!;
		expect(parcel.id).toBe(ids['Home parcel']);
		expect(parcel.areaM2).toBeGreaterThan(0);
		expect(parcel.center[0]).toBeCloseTo(21.32, 2);
		// Only what the map draws: no node id, no properties, no author.
		expect(Object.keys(parcel).sort()).toEqual(['areaM2', 'center', 'geometry', 'id', 'kind', 'name']);
	});

	it('positive control: the neighbour gets their own parcel and dam', async () => {
		const r = await neighbour.call('GET', mapOf(theirs.id));
		expect(r.status).toBe(200);
		const names = (r.body.features as Feature[]).filter((f) => f.kind === 'farm_parcel' || f.kind === 'dam').map((f) => f.name);
		expect(names).toEqual([`Parcel ${MARKER}`, `Dam ${MARKER}`]);
	});

	it('never carries the neighbour’s parcel, dam or anything else of theirs, and answers the neighbour’s farm 404', async () => {
		const own = await raw(farmer, mapOf(home.id));
		expect(own.status).toBe(200);
		for (const trace of [MARKER, ids[`Parcel ${MARKER}`]!, ids[`Dam ${MARKER}`]!, ids[`Other ${MARKER}`]!, theirs.id]) expect(own.text).not.toContain(trace);
		const other = await raw(farmer, mapOf(theirs.id));
		expect(other.status).toBe(404);
		expect(other.text).not.toContain(MARKER);
		// The workspace's feature list is not a farmer's.
		expect((await farmer.call('GET', `/projects/${projectId}/map/features`)).status).toBe(403);
	});

	it('answers a viewer previewing a farm with that farm’s features only, as its farmer sees them', async () => {
		const r = await viewer.call('GET', mapOf(home.id));
		expect(r.status).toBe(200);
		expect((r.body.features as Feature[]).map((f) => f.name)).toEqual(['Home parcel', 'Home dam', 'Weir gauge', 'Sand river', 'Synthetic catchment']);
		// Positive control: the viewer's own feature list does hold the neighbour's parcel.
		const all = await viewer.call('GET', `/projects/${projectId}/map/features`);
		expect(all.body.features.map((f: Feature) => f.name)).toContain(`Parcel ${MARKER}`);
	});

	it('answers no features for a farm with no parcel or dam of its own on the map', async () => {
		const r = await farmer.call('GET', mapOf(bare.id));
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ features: [] });
	});

	it('is refused to a stranger and to a signed-out request', async () => {
		const stranger = await signUp('Fmstranger');
		expect((await stranger.call('GET', mapOf(home.id))).status).toBe(404);
		expect((await app.request(mapOf(home.id), { headers: { origin: ORIGIN } })).status).toBe(401);
	});
});
