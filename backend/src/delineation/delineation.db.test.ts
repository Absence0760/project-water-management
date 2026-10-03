// Catchments delineated from a click (issue #326 B-delineate;
// 175_delineation.sql, delineation/routes.ts), end to end against Postgres
// and the committed synthetic DEM (backend/fixtures/dem/):
//  - off (DEM_URL empty): the GET says unavailable and a POST is 409;
//  - an editor's click proposes the valley above the outlet, with the
//    dataset and method recorded; a viewer reads it and can't propose;
//  - a new click supersedes the open proposal; a refusal is 422 with its
//    reason and saves nothing;
//  - accepting as the boundary when there is one is refused without
//    `replaceBoundary` (and with it replaces it); accepting twice is 409;
//    accepting as an area keeps the boundary; rejecting closes it;
//  - deleting the accepted feature keeps the proposal and clears the link;
//  - a stranger gets 404, and another project's proposal can't be decided;
//  - the hourly cap answers 429.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { BASIN_AREA_M2, DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { DELINEATIONS_PER_HOUR } from './routes.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;

const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const point = (x: number, y: number) => {
	const [lon, lat] = fixtureLonLat(x + 0.5, y + 0.5);
	return { lon, lat };
};
const OUTLET = point(OUTLET_CELL.x, OUTLET_CELL.y);
const DAM = point(DAM_CELL.x, DAM_CELL.y + 1);
const SQUARE = [[[20.6, -33.5], [20.61, -33.5], [20.61, -33.49], [20.6, -33.49], [20.6, -33.5]]];

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Lowner', 'Leditor', 'Lviewer', 'Lstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Delineation' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('delineation off', () => {
	it('says unavailable and refuses a click while DEM_URL is empty', async () => {
		process.env.DEM_URL = '';
		const get = await viewer.call('GET', at('/map/delineation'));
		expect(get.status).toBe(200);
		expect(get.body).toEqual({ available: false, dataset: null, proposals: [], request: null });
		const post = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(post.status).toBe(409);
		expect(post.body.error).toMatch(/Delineation is off/);
	});

	it('says unavailable when DEM_URL names a file that is not there', async () => {
		process.env.DEM_URL = '/nonexistent/dem.pmtiles';
		expect((await viewer.call('GET', at('/map/delineation'))).body.available).toBe(false);
	});
});

describe('a DEM that can’t be read', () => {
	it('answers 503 with a sentence (never the decoder’s error text) and saves nothing', async () => {
		const bad = join(mkdtempSync(join(tmpdir(), 'dem-')), 'corrupt.pmtiles');
		writeFileSync(bad, Buffer.alloc(4096, 7));
		process.env.DEM_URL = bad;
		expect((await viewer.call('GET', at('/map/delineation'))).body.available).toBe(false);
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status).toBe(503);
		expect(res.body.error).toMatch(/could not be read just now/);
		expect(JSON.stringify(res.body)).not.toMatch(/PMTiles|pmtiles archive/);
		expect(await asOwner('SELECT 1 FROM delineation_proposal WHERE project_id = $1', [projectId])).toHaveLength(0);
	});
});

describe('with the synthetic DEM', () => {
	let firstId: string;
	let secondId: string;

	beforeAll(() => {
		process.env.DEM_URL = FIXTURE;
	});

	it('proposes the valley above the outlet for an editor, with the dataset and method recorded, and audits it', async () => {
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const p = res.body.proposal;
		expect(p).toMatchObject({ status: 'proposed', from: 'outlet', zoom: 10, methodVersion: 'delineate-12', featureId: null, createdBy: 'Leditor', decidedAt: null });
		expect(Math.abs(p.areaM2 / BASIN_AREA_M2 - 1)).toBeLessThan(0.03);
		expect(p.geometry.type).toBe('Polygon');
		expect(p.dataset).toMatch(/Synthetic DEM/);
		expect(p.datasetFingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(p.method).toMatch(/D8/);
		expect(p.click).toEqual([OUTLET.lon, OUTLET.lat]);
		// What drains into the valley's pan, stored with the proposal and its method (193, delineate-9).
		expect(p.pans).toMatchObject({ count: 1, method: expect.stringMatching(/^Non-contributing \(pans\)/) });
		expect(p.pans.nonContributingM2).toBeGreaterThan(0);
		expect(p.pans.nonContributingM2).toBeLessThan(0.1 * p.areaM2);
		const stored = (await asOwner(`SELECT pans FROM delineation_proposal WHERE id = $1`, [p.id])) as { pans: unknown }[];
		expect(stored[0]!.pans).toEqual(p.pans);
		firstId = p.id;
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.delineation_proposed'`, [projectId]);
		expect(audit[0]!.subject).toMatchObject({ proposalId: firstId, from: 'outlet', methodVersion: 'delineate-12' });
		expect(JSON.stringify(audit[0]!.subject)).not.toMatch(/coordinates/);
	});

	it('lets a viewer read it, never propose', async () => {
		const res = await viewer.call('GET', at('/map/delineation'));
		expect(res.status).toBe(200);
		expect(res.body.available).toBe(true);
		expect(res.body.dataset).toMatchObject({ tileType: 'png', maxZoom: 10, label: expect.stringMatching(/Synthetic DEM/) });
		expect(res.body.proposals.map((p: { id: string }) => p.id)).toEqual([firstId]);
		expect((await viewer.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' })).status).toBe(403);
		expect((await viewer.call('POST', at(`/map/delineation/${firstId}/reject`))).status).toBe(403);
	});

	it('supersedes the open proposal with a new click', async () => {
		const res = await editor.call('POST', at('/map/delineation'), { ...DAM, from: 'dam_wall' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		secondId = res.body.proposal.id;
		expect(res.body.proposal.areaM2).toBeLessThan(0.8 * BASIN_AREA_M2);
		const list = (await viewer.call('GET', at('/map/delineation'))).body.proposals;
		expect(list.map((p: { id: string; status: string }) => [p.id, p.status])).toEqual([
			[secondId, 'proposed'],
			[firstId, 'superseded']
		]);
		expect((await editor.call('POST', at(`/map/delineation/${firstId}/accept`), { as: 'other' })).status).toBe(409);
	});

	it('refuses a click outside the DEM with 422 and its reason, saving nothing', async () => {
		const res = await editor.call('POST', at('/map/delineation'), { lon: 25, lat: -30, from: 'outlet' });
		expect(res.status).toBe(422);
		expect(res.body.details).toEqual({ reason: 'outside' });
		expect(res.body.error).toMatch(/outside the elevation model/);
		expect((await viewer.call('GET', at('/map/delineation'))).body.proposals).toHaveLength(2);
	});

	it('accepts as an area, keeping any boundary, and links the feature', async () => {
		const res = await editor.call('POST', at(`/map/delineation/${secondId}/accept`), { as: 'other' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.proposal).toMatchObject({ status: 'accepted', decidedBy: 'Leditor' });
		expect(res.body.feature).toMatchObject({ kind: 'other', name: 'Catchment above the dam wall (delineated)' });
		expect(res.body.feature.properties.description).toMatch(/Delineated from Synthetic DEM/);
		expect(res.body.proposal.featureId).toBe(res.body.feature.id);
		// What of it drains into the valley's pan goes with the feature (195), for Use this area's effective area.
		expect(res.body.proposal.pans.nonContributingM2).toBeGreaterThan(0);
		expect(res.body.feature.nonContributingM2).toBeCloseTo(res.body.proposal.pans.nonContributingM2, 6);
		expect((await editor.call('POST', at(`/map/delineation/${secondId}/accept`), { as: 'other' })).status).toBe(409);
	});

	it('Use this area takes the accepted catchment gross by default, effective when asked, and records which (195)', async () => {
		const list = (await viewer.call('GET', at('/map/delineation'))).body.proposals;
		const p = list.find((x: { id: string }) => x.id === secondId);
		const nc = p.pans.nonContributingM2 as number;
		const weir = node('Weir', null);
		const unit = node('Dam unit', weir.id, { areaKm2: 1 });
		expect((await owner.call('PUT', at('/model'), { nodes: [weir, unit], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const url = at(`/nodes/${unit.id}/area-from-map`);
		// A viewer can't, whichever area.
		expect((await viewer.call('POST', url, { featureId: p.featureId, basis: 'effective' })).status).toBe(403);
		// No basis: the gross area (the positive control: unchanged by 195).
		const gross = await editor.call('POST', url, { featureId: p.featureId });
		expect(gross.status, JSON.stringify(gross.body)).toBe(200);
		expect(gross.body).toMatchObject({ areaBasis: 'gross', areaSource: 'map', areaFeatureId: p.featureId });
		expect(gross.body.areaKm2).toBeCloseTo(p.areaM2 / 1e6, 9);
		const eff = await editor.call('POST', url, { featureId: p.featureId, basis: 'effective' });
		expect(eff.status, JSON.stringify(eff.body)).toBe(200);
		expect(eff.body.areaBasis).toBe('effective');
		expect(eff.body.areaKm2).toBeCloseTo((p.areaM2 - nc) / 1e6, 9);
		const [n] = await asOwner('SELECT area_km2, area_source, area_basis, area_feature_id FROM node WHERE id = $1', [unit.id]);
		expect(n).toMatchObject({ area_source: 'map', area_basis: 'effective', area_feature_id: p.featureId });
		const reasons = await asOwner(`SELECT reason FROM model_revision WHERE project_id = $1 AND source <> 'baseline' ORDER BY id DESC LIMIT 2`, [projectId]);
		expect(reasons[1]!.reason).toMatch(/^Area of Dam unit from the map: “Catchment above the dam wall \(delineated\)” \([\d.]+ km², the gross area, the [\d.]+ km² draining into pans included, /);
		expect(reasons[0]!.reason).toMatch(/^Area of Dam unit from the map: “Catchment above the dam wall \(delineated\)” \([\d.]+ km², the effective area, without the [\d.]+ km² draining into pans, /);
		// An unknown basis is refused by the schema.
		expect((await editor.call('POST', url, { featureId: p.featureId, basis: 'net' })).status).toBe(400);
	});

	it('never replaces a boundary silently: 409 without the tick, replaced with it', async () => {
		const b = await editor.call('POST', at('/map/features'), { kind: 'catchment_boundary', name: 'Drawn boundary', geometry: { type: 'Polygon', coordinates: SQUARE } });
		expect(b.status).toBe(201);
		const p = (await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' })).body.proposal;
		const refused = await editor.call('POST', at(`/map/delineation/${p.id}/accept`), { as: 'catchment_boundary' });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/already has a boundary “Drawn boundary”/);
		const kept = await editor.call('GET', at('/map/features'));
		expect(kept.body.features.find((f: { kind: string }) => f.kind === 'catchment_boundary').name).toBe('Drawn boundary');
		// A name is one line, as every feature name (issue #385): refused, and the proposal stays open.
		const twoLines = await editor.call('POST', at(`/map/delineation/${p.id}/accept`), { as: 'catchment_boundary', replaceBoundary: true, name: 'Delineated\nvalley' });
		expect(twoLines.status).toBe(400);
		expect(JSON.stringify(twoLines.body)).toMatch(/cannot contain line breaks or control characters/);
		const ok = await editor.call('POST', at(`/map/delineation/${p.id}/accept`), { as: 'catchment_boundary', replaceBoundary: true, name: 'Delineated valley' });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		const after = (await editor.call('GET', at('/map/features'))).body.features.filter((f: { kind: string }) => f.kind === 'catchment_boundary');
		expect(after.map((f: { name: string }) => f.name)).toEqual(['Delineated valley']);
		// Deleting the feature keeps the proposal and clears its link.
		expect((await editor.call('DELETE', at(`/map/features/${ok.body.feature.id}`))).status).toBe(204);
		const list = (await viewer.call('GET', at('/map/delineation'))).body.proposals;
		expect(list.find((x: { id: string }) => x.id === p.id)).toMatchObject({ status: 'accepted', featureId: null });
	});

	it('holds one open proposal a project in the schema too (the partial unique index)', async () => {
		const row = `INSERT INTO delineation_proposal (project_id, click_kind, click_lon, click_lat, outlet_lon, outlet_lat, snap_distance_m, geometry, area_m2, cells,
			cell_size_m, zoom, window_cells, dataset, dataset_fingerprint, method, method_version)
			VALUES ($1, 'outlet', 20.7, -33.5, 20.7, -33.5, 0, '{"type":"Polygon","coordinates":[]}', 1, 1, 128, 10, 1024, 'x', '0000000000000000', 'x', 'x')`;
		expect((await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' })).status).toBe(201);
		// That proposal is open; a second open row is refused (positive control: another project takes one).
		await expect(asOwner(row, [projectId])).rejects.toThrow(/delineation_proposal_one_open_idx/);
		await asOwner(row, [otherProjectId]);
	});

	it('rejects an open proposal once', async () => {
		const p = (await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' })).body.proposal;
		const res = await editor.call('POST', at(`/map/delineation/${p.id}/reject`));
		expect(res.status).toBe(200);
		expect(res.body.proposal).toMatchObject({ status: 'rejected', decidedBy: 'Leditor' });
		expect((await editor.call('POST', at(`/map/delineation/${p.id}/reject`))).status).toBe(409);
		const kinds = await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND kind LIKE 'map.delineation_%' ORDER BY id`, [projectId]);
		expect(new Set(kinds.map((k) => k.kind))).toEqual(new Set(['map.delineation_proposed', 'map.delineation_accepted', 'map.delineation_rejected']));
	});

	it('keeps strangers and other projects out', async () => {
		expect((await stranger.call('GET', at('/map/delineation'))).status).toBe(404);
		expect((await stranger.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' })).status).toBe(404);
		// A proposal of this project, addressed through another: 404.
		expect((await stranger.call('POST', at(`/map/delineation/${firstId}/reject`, otherProjectId))).status).toBe(404);
		expect((await editor.call('POST', at('/map/delineation/not-a-uuid/reject'))).status).toBe(404);
		// Positive control: the editor reads this project's proposals.
		expect((await editor.call('GET', at('/map/delineation'))).body.proposals.length).toBeGreaterThan(0);
	});

	it('caps delineations per project per hour (429)', async () => {
		const { rows } = { rows: await asOwner(`SELECT count(*)::integer AS n FROM delineation_proposal WHERE project_id = $1`, [projectId]) };
		const have = rows[0]!.n as number;
		// Age-in rows straight into the table (as the owner) up to the cap; the next click is refused before any work.
		await asOwner(
			`INSERT INTO delineation_proposal (project_id, status, click_kind, click_lon, click_lat, outlet_lon, outlet_lat, snap_distance_m, geometry, area_m2, cells,
				cell_size_m, zoom, window_cells, dataset, dataset_fingerprint, method, method_version, decided_at)
			 SELECT $1, 'rejected', 'outlet', 20.7, -33.5, 20.7, -33.5, 0, '{"type":"Polygon","coordinates":[]}', 1, 1, 128, 10, 1024, 'x', '0000000000000000', 'x', 'x', now()
			 FROM generate_series(1, $2)`,
			[projectId, DELINEATIONS_PER_HOUR - have]
		);
		const res = await editor.call('POST', at('/map/delineation'), { ...OUTLET, from: 'outlet' });
		expect(res.status).toBe(429);
	});
});
