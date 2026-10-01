// GET /projects/:id/map/linked-nodes (issue #326): the ids of the nodes a map
// feature is linked to, for the "Show on map" links on the Network,
// Hydrological units and Dams pages. Only ids, never a geometry.
//  - a viewer reads each linked node once, and not an unlinked node or a
//    feature with no node (positive control: the linked node is there);
//  - unlinking a feature drops its node;
//  - another project's member gets 404, and their own project's links never
//    leak in; a farmer gets 403, as from GET /map/features.
import { beforeAll, describe, expect, it } from 'vitest';
import { node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
let otherFarmId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
const farmC = node('Farm C', outlet.id);
const at = (p: string) => `/projects/${p}/map/linked-nodes`;
const place = (u: User, p: string, body: Record<string, unknown>) => u.call('POST', `/projects/${p}/map/features`, { lon: 21.3, lat: -33.6, ...body });

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['LNowner', 'LNviewer', 'LNfarmer', 'LNstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Linked nodes' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB, farmC], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	// Farm A twice (a dam and an "other" point), Farm B once, Farm C never, and a gauge with no node.
	for (const body of [
		{ kind: 'dam', name: 'A dam', nodeId: farmA.id },
		{ kind: 'other', name: 'A pump', nodeId: farmA.id },
		{ kind: 'dam', name: 'B dam', nodeId: farmB.id },
		{ kind: 'gauge', name: 'Loose gauge' }
	])
		expect((await place(owner, projectId, body)).status).toBe(201);

	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere links' })).body.project.id;
	const otherOutlet = node('Their weir', null);
	const otherFarm = node('Their farm', otherOutlet.id);
	otherFarmId = otherFarm.id;
	expect((await stranger.call('PUT', `/projects/${otherProjectId}/model`, { nodes: [otherOutlet, otherFarm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await place(stranger, otherProjectId, { kind: 'dam', name: 'Their dam', nodeId: otherFarm.id })).status).toBe(201);
}, 60_000);

describe('GET /map/linked-nodes', () => {
	it('gives a viewer each linked node once, and no unlinked node', async () => {
		const res = await viewer.call('GET', at(projectId));
		expect(res.status).toBe(200);
		expect(Object.keys(res.body)).toEqual(['nodeIds']);
		expect([...res.body.nodeIds].sort()).toEqual([farmA.id, farmB.id].sort());
		expect(res.body.nodeIds).not.toContain(farmC.id);
		expect(res.body.nodeIds).not.toContain(outlet.id);
	});

	it('drops a node once its last feature is unlinked', async () => {
		const list = await owner.call('GET', `/projects/${projectId}/map/features`);
		const bDam = list.body.features.find((f: { name: string }) => f.name === 'B dam');
		expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${bDam.id}`, { nodeId: null })).status).toBe(200);
		expect((await viewer.call('GET', at(projectId))).body.nodeIds).toEqual([farmA.id]);
	});

	it('is 404 to another project’s member, whose own links stay in their project', async () => {
		expect((await stranger.call('GET', at(projectId))).status).toBe(404);
		// Positive control: the stranger reads their own project's linked node, and only it.
		const own = await stranger.call('GET', at(otherProjectId));
		expect(own.status).toBe(200);
		expect(own.body.nodeIds).toEqual([otherFarmId]);
		expect((await viewer.call('GET', at(otherProjectId))).status).toBe(404);
	});

	it('is 403 to a farmer, as the feature list is', async () => {
		expect((await farmer.call('GET', at(projectId))).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/map/features`)).status).toBe(403);
	});

	it('is empty for a project with no feature, and 404 for an id that isn’t one', async () => {
		const empty = (await owner.call('POST', '/projects', { name: 'No map' })).body.project.id;
		expect((await owner.call('GET', at(empty))).body).toEqual({ nodeIds: [] });
		expect((await owner.call('GET', at('not-a-uuid'))).status).toBe(404);
	});
});
