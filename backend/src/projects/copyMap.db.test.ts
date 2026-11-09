// A copied project takes its catchment map with it (POST /projects/:id/copy,
// copyMap.ts): sources and features under new ids, each linked to the copy's
// node; a unit's area from the map linked to the copied parcel; the records
// of what an accepted value was read over pointing at the copied features;
// a linked gauge's link point kept. The original is unchanged, and a viewer
// of the original copies it as well (RLS lets them read it and write their own
// copy); a stranger sees neither.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Feature = { id: string; kind: string; name: string; nodeId: string | null; sourceId: string | null; areaM2: number | null; geometry: { coordinates: unknown }; linkPoint?: unknown };
type MapBody = {
	features: Feature[];
	sources: { id: string; fileName: string; sha256: string; features: number }[];
	nodes: { id: string; name: string; areaSource: string; areaBasis: string | null; areaFeatureId: string | null }[];
	accepted: {
		unitMap: { nodeId: string; polygon: { featureId: string; updatedAt: string; areaM2: number } }[];
		landCover: { nodeId: string; cropId: string; polygons: { featureId: string }[] }[];
		evaporation: { target: string; boundary: { featureId: string } | null }[];
	};
};

/** A box `d` degrees on a side (synthetic coordinates). */
const box = (x: number, y: number, d: number) => [
	[x, y],
	[x + d, y],
	[x + d, y + d],
	[x, y + d],
	[x, y]
];
const parcels = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{ type: 'Feature', properties: { name: 'Farm 1' }, geometry: { type: 'Polygon', coordinates: [box(21.31, -33.69, 0.02)] } },
		{ type: 'Feature', properties: { name: 'Spare' }, geometry: { type: 'Polygon', coordinates: [box(21.35, -33.69, 0.02)] } }
	]
});

async function mappedProject(owner: User) {
	const outlet = node('Weir', null);
	const farm = node('Farm 1', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const { body } = await owner.call('POST', '/projects', { name: 'Mapped' });
	const projectId = body.project.id as string;
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const imported = await owner.call('POST', `/projects/${projectId}/map/import`, { fileName: 'parcels.geojson', kind: 'farm_parcel', text: parcels });
	expect(imported.status, JSON.stringify(imported.body)).toBe(201);
	const parcel = (imported.body.features as Feature[]).find((f) => f.name === 'Farm 1')!;
	expect(parcel.nodeId).toBe(farm.id);
	// A gauge linked where it stood, then moved: its link point stays where it was linked.
	const gauge = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'gauge', name: 'Weir', nodeId: outlet.id, lon: 21.4, lat: -33.6 });
	expect(gauge.status, JSON.stringify(gauge.body)).toBe(201);
	expect((await owner.call('PATCH', `/projects/${projectId}/map/features/${gauge.body.feature.id}`, { lon: 21.41, lat: -33.6 })).status).toBe(200);
	const area = await owner.call('POST', `/projects/${projectId}/nodes/${farm.id}/area-from-map`, { featureId: parcel.id });
	expect(area.status, JSON.stringify(area.body)).toBe(200);
	// What accepted values were read over (273): written as their routes write them, under the owner's RLS.
	const stamp = { featureId: parcel.id, updatedAt: '2026-01-01T00:00:00.000Z', areaM2: parcel.areaM2 };
	await withUser(owner.id, async (db) => {
		await db.query('UPDATE node SET map_mm = 600, map_source = $3, map_polygon = $4::jsonb WHERE id = $1 AND project_id = $2', [farm.id, projectId, 'Synthetic grid', JSON.stringify(stamp)]);
		await db.query(
			`INSERT INTO crop_area_land_cover (project_id, node_id, crop_id, area_m2, dataset, source, version, method, basis, polygons)
			 VALUES ($1, $2, $3, 50000, 'synthetic', 'Synthetic land cover', 'v1', 'cells summed', 'unit', $4::jsonb)`,
			[projectId, farm.id, crop.id, JSON.stringify([stamp, { ...stamp, featureId: crypto.randomUUID() }])]
		);
		await db.query(
			`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage, boundary)
			 VALUES ($1, 'apan', $2, 'synthetic', 'apan', 'Synthetic grid', 'v1', 'mean', 1, $3::jsonb)`,
			[projectId, monthly(150), JSON.stringify(stamp)]
		);
	});
	return { projectId, outlet, farm, crop, parcel, gaugeId: gauge.body.feature.id as string };
}

const mapOf = async (u: User, projectId: string) => {
	const res = await u.call('GET', `/projects/${projectId}/map/features`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body as MapBody;
};

describe('copying a project copies its catchment map', () => {
	it('copies sources and features with new ids, linked to the copy’s nodes, and leaves the original alone', async () => {
		const a = await signUp('CopyMap');
		const stranger = await signUp('CopyMapStranger');
		const { projectId, farm, outlet, parcel, gaugeId } = await mappedProject(a);
		const before = await mapOf(a, projectId);

		const copy = await a.call('POST', `/projects/${projectId}/copy`, { name: 'Mapped copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const copyId = copy.body.project.id as string;
		const dup = await mapOf(a, copyId);
		const dupNode = (name: string) => dup.nodes.find((n) => n.name === name)!;
		const dupFeature = (name: string, kind = 'farm_parcel') => dup.features.find((f) => f.name === name && f.kind === kind)!;

		// Every feature and source, with new ids.
		expect(dup.features.map((f) => `${f.kind}:${f.name}`).sort()).toEqual(before.features.map((f) => `${f.kind}:${f.name}`).sort());
		const oldIds = new Set(before.features.map((f) => f.id));
		expect(dup.features.some((f) => oldIds.has(f.id))).toBe(false);
		expect(dup.sources).toHaveLength(1);
		expect(dup.sources[0]).toMatchObject({ fileName: 'parcels.geojson', sha256: before.sources[0]!.sha256, features: 2 });
		expect(dup.sources[0]!.id).not.toBe(before.sources[0]!.id);
		for (const name of ['Farm 1', 'Spare']) expect(dupFeature(name).sourceId).toBe(dup.sources[0]!.id);
		expect(dupFeature('Farm 1').areaM2).toBe(parcel.areaM2);

		// Linked to the copy's nodes; an unlinked parcel stays unlinked.
		expect(dupNode('Farm 1').id).not.toBe(farm.id);
		expect(dupFeature('Farm 1').nodeId).toBe(dupNode('Farm 1').id);
		expect(dupFeature('Spare').nodeId).toBeNull();
		expect(dupFeature('Weir', 'gauge').nodeId).toBe(dupNode('Weir').id);
		expect(dupNode('Weir').id).not.toBe(outlet.id);

		// The unit's area from the map links to the copied parcel.
		expect(dupNode('Farm 1')).toMatchObject({ areaSource: 'map', areaBasis: 'gross', areaFeatureId: dupFeature('Farm 1').id });
		expect(dupNode('Weir')).toMatchObject({ areaSource: 'typed', areaBasis: null, areaFeatureId: null });

		// The gauge stands where it stands now, and its link point is where it was linked.
		const origGauge = before.features.find((f) => f.id === gaugeId)!;
		expect(dupFeature('Weir', 'gauge').geometry).toEqual(origGauge.geometry);
		const linkPoints = await withUser(a.id, async (db) =>
			(await db.query<{ project_id: string; link_point: unknown }>(`SELECT project_id, link_point FROM map_feature WHERE kind = 'gauge' AND project_id = ANY($1::uuid[])`, [[projectId, copyId]])).rows
		);
		expect(linkPoints).toHaveLength(2);
		expect(linkPoints[0]!.link_point).toEqual({ type: 'Point', coordinates: [21.4, -33.6] });
		expect(linkPoints[1]!.link_point).toEqual(linkPoints[0]!.link_point);

		// What accepted values were read over names the copied parcel; a polygon the copy has no feature for gets an id of neither project.
		const copiedParcel = dupFeature('Farm 1').id;
		expect(dup.accepted.unitMap).toEqual([{ nodeId: dupNode('Farm 1').id, polygon: { featureId: copiedParcel, updatedAt: '2026-01-01T00:00:00.000Z', areaM2: parcel.areaM2 } }]);
		expect(dup.accepted.landCover).toHaveLength(1);
		expect(dup.accepted.landCover[0]!.nodeId).toBe(dupNode('Farm 1').id);
		const [first, gone] = dup.accepted.landCover[0]!.polygons;
		expect(first!.featureId).toBe(copiedParcel);
		expect(gone!.featureId).not.toBe(before.accepted.landCover[0]!.polygons[1]!.featureId);
		expect(dup.features.map((f) => f.id)).not.toContain(gone!.featureId);
		expect(dup.accepted.evaporation).toEqual([{ target: 'apan', boundary: expect.objectContaining({ featureId: copiedParcel }) }]);

		// The original is untouched.
		const after = await mapOf(a, projectId);
		expect(after.features.map((f) => f.id).sort()).toEqual(before.features.map((f) => f.id).sort());
		expect(after.nodes.find((n) => n.id === farm.id)).toMatchObject({ areaSource: 'map', areaFeatureId: parcel.id });
		expect(after.accepted).toEqual(before.accepted);

		// RLS: a stranger reads neither project's map (the owner reading both above is the positive control).
		expect((await stranger.call('GET', `/projects/${copyId}/map/features`)).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${projectId}/map/features`)).status).toBe(404);
	});

	it('copies the map for a viewer of the original, into their own copy', async () => {
		const owner = await signUp('CopyMapOwner');
		const viewer = await signUp('CopyMapViewer');
		const { projectId } = await mappedProject(owner);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		// Positive control: the viewer reads the original's map.
		expect((await mapOf(viewer, projectId)).features).toHaveLength(3);
		const copy = await viewer.call('POST', `/projects/${projectId}/copy`, { name: 'Viewer copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const dup = await mapOf(viewer, copy.body.project.id);
		expect(dup.features).toHaveLength(3);
		expect(dup.nodes.find((n) => n.name === 'Farm 1')).toMatchObject({ areaSource: 'map', areaFeatureId: dup.features.find((f) => f.name === 'Farm 1')!.id });
		// The owner of the original isn't a member of the viewer's copy.
		expect((await owner.call('GET', `/projects/${copy.body.project.id}/map/features`)).status).toBe(404);
	});
});
