// Assisted drawing on the catchment map (issue #326 C2; geo/routes.ts split
// and traced create, delineation/traceRoutes.ts): the API end to end.
//  - a parcel split in two keeps its id, name and link on the first part, and
//    the second part is a new parcel; the boundary split stays whole and its
//    parts become areas; parts that don't make up the shape, a point, a
//    shape with a hole and a kind for a parcel's parts are refused; one
//    audit event names both parts; a viewer can't split;
//  - tracing a dam proposes the synthetic dam's outline and saves nothing; a
//    viewer reads whether it is on but can't trace; refusals carry a reason;
//  - a traced outline saved records the dataset and method on the feature
//    and in the audit event; one sent as unadjusted that isn't the trace is
//    refused; tracing is off (409) without WATER_URL.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { splitHalves } from '../__tests__/routeSamples.js';
import { DAM_CLICK, DRY_CLICK, WATER_FIXTURE_FILE } from '../delineation/waterFixture.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let strangerProjectId: string;
const at = (p = '') => `/projects/${projectId}/map${p}`;
const square = (w: number, s: number, d: number) => ({ type: 'Polygon', coordinates: [[[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]]] });
const before = process.env.WATER_URL;

beforeAll(async () => {
	[owner, editor, viewer, stranger] = (await Promise.all(['Aowner', 'Aeditor', 'Aviewer', 'Astranger'].map((n) => signUp(n)))) as [User, User, User, User];
	strangerProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
	projectId = (await owner.call('POST', '/projects', { name: 'Assisted drawing' })).body.project.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	process.env.WATER_URL = fileURLToPath(WATER_FIXTURE_FILE);
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.WATER_URL;
	else process.env.WATER_URL = before;
});

describe('splitting a polygon', () => {
	it('splits a parcel: the first part keeps the feature, the second is a new parcel, and one event names both', async () => {
		const made = await editor.call('POST', at('/features'), { kind: 'farm_parcel', name: 'Hill farm', geometry: square(21.3, -33.7, 0.02) });
		expect(made.status).toBe(201);
		const whole = made.body.feature.areaM2 as number;
		expect((await viewer.call('POST', at(`/features/${made.body.feature.id}/split`), { parts: splitHalves(21.3, -33.7, 0.02) })).status).toBe(403);
		const res = await editor.call('POST', at(`/features/${made.body.feature.id}/split`), { parts: splitHalves(21.3, -33.7, 0.02) });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const [a, b] = res.body.features;
		expect(a).toMatchObject({ id: made.body.feature.id, kind: 'farm_parcel', name: 'Hill farm' });
		expect(b).toMatchObject({ kind: 'farm_parcel', name: 'Hill farm (part 2)', nodeId: null, properties: { description: 'Split from “Hill farm” along a drawn line.' } });
		expect(a.areaM2 + b.areaM2).toBeCloseTo(whole, -1);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.feature_split'`, [projectId]);
		expect(ev!.subject).toMatchObject({ featureId: a.id, kind: 'farm_parcel', name: 'Hill farm', into: 'farm_parcel', parts: [a.id, b.id] });
		expect(JSON.stringify(ev!.subject)).not.toMatch(/coordinates/);
	});

	it('splits the boundary into areas and leaves it whole; names given are used', async () => {
		const made = await editor.call('POST', at('/features'), { kind: 'catchment_boundary', name: 'Valley', geometry: square(21.3, -33.7, 0.1) });
		const res = await editor.call('POST', at(`/features/${made.body.feature.id}/split`), { parts: splitHalves(21.3, -33.7, 0.1), names: ['West', 'East'], as: 'other' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.features.map((f: { kind: string; name: string }) => [f.kind, f.name])).toEqual([
			['other', 'West'],
			['other', 'East']
		]);
		const list = (await editor.call('GET', at('/features'))).body.features as { id: string; kind: string }[];
		expect(list.find((f) => f.id === made.body.feature.id)?.kind).toBe('catchment_boundary');
	});

	it('refuses parts that aren’t the shape, a point, a kind for a parcel’s parts, and a shape with a hole', async () => {
		const p = await editor.call('POST', at('/features'), { kind: 'farm_parcel', name: 'Refusals', geometry: square(21.36, -33.66, 0.01) });
		const fid = p.body.feature.id as string;
		const wrong = await editor.call('POST', at(`/features/${fid}/split`), { parts: splitHalves(21.36, -33.66, 0.009) });
		expect(wrong.status).toBe(400);
		expect(wrong.body.error).toMatch(/not this shape cut in two/);
		const asKind = await editor.call('POST', at(`/features/${fid}/split`), { parts: splitHalves(21.36, -33.66, 0.01), as: 'other' });
		expect(asKind.status).toBe(400);
		const pt = await editor.call('POST', at('/features'), { kind: 'gauge', lon: 21.35, lat: -33.65 });
		expect((await editor.call('POST', at(`/features/${pt.body.feature.id}/split`), { parts: splitHalves(21.36, -33.66, 0.01) })).status).toBe(400);
		const holed = { type: 'Polygon', coordinates: [square(21.38, -33.68, 0.01).coordinates[0], [[21.383, -33.677], [21.383, -33.673], [21.387, -33.673], [21.383, -33.677]]] };
		const h = await editor.call('POST', at('/features'), { kind: 'farm_parcel', geometry: holed });
		expect(h.status, JSON.stringify(h.body)).toBe(201);
		const r = await editor.call('POST', at(`/features/${h.body.feature.id}/split`), { parts: splitHalves(21.38, -33.68, 0.01) });
		expect(r.status).toBe(400);
		expect(r.body.error).toMatch(/one outline/);
		// Nothing changed: the refused parcel is still whole.
		const [row] = await asOwner('SELECT area_m2 FROM map_feature WHERE id = $1', [fid]);
		expect(row!.area_m2).toBeCloseTo(p.body.feature.areaM2, 3);
	});
});

describe('who may split, and what (positive control: the editor’s splits above)', () => {
	it('another project’s editor can’t split this project’s parcel, through either project; an unknown feature is 404', async () => {
		const p = await editor.call('POST', at('/features'), { kind: 'farm_parcel', name: 'Guarded', geometry: square(21.33, -33.62, 0.01) });
		const fid = p.body.feature.id as string;
		const body = { parts: splitHalves(21.33, -33.62, 0.01) };
		expect((await stranger.call('POST', at(`/features/${fid}/split`), body)).status).toBe(404);
		// Through the stranger's own project, where they are owner: the feature isn't there.
		expect((await stranger.call('POST', `/projects/${strangerProjectId}/map/features/${fid}/split`, body)).status).toBe(404);
		expect((await editor.call('POST', at(`/features/${crypto.randomUUID()}/split`), body)).status).toBe(404);
		const [row] = await asOwner('SELECT area_m2 FROM map_feature WHERE id = $1', [fid]);
		expect(row!.area_m2).toBeCloseTo(p.body.feature.areaM2, 3);
	});
});

describe('tracing a dam', () => {
	it('is not even visible to a non-member: 404 for the state and the trace', async () => {
		expect((await stranger.call('GET', at('/dam-trace'))).status).toBe(404);
		expect((await stranger.call('POST', at('/dam-trace'), { lon: DAM_CLICK[0], lat: DAM_CLICK[1] })).status).toBe(404);
	});

	it('an unreadable raster is off in the state and a 503 with a fixed sentence for a trace, never its cause', async () => {
		const url = process.env.WATER_URL;
		process.env.WATER_URL = '/nonexistent/water-raster-for-a-test.pmtiles';
		try {
			expect((await viewer.call('GET', at('/dam-trace'))).body).toEqual({ available: false, dataset: null });
			const r = await editor.call('POST', at('/dam-trace'), { lon: DAM_CLICK[0], lat: DAM_CLICK[1] });
			expect(r.status).toBe(503);
			expect(r.body.error).toBe('The water occurrence data could not be read just now. Try again; if it keeps failing, the operator should check WATER_URL.');
			expect(JSON.stringify(r.body)).not.toMatch(/nonexistent|ENOENT/);
		} finally {
			process.env.WATER_URL = url;
		}
	});

	it('says whether it is on, to a viewer too', async () => {
		const res = await viewer.call('GET', at('/dam-trace'));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ available: true, dataset: { label: expect.stringMatching(/Synthetic water occurrence/) } });
	});

	it('proposes the dam’s outline to an editor and saves nothing; a viewer can’t trace', async () => {
		const [lon, lat] = DAM_CLICK;
		expect((await viewer.call('POST', at('/dam-trace'), { lon, lat })).status).toBe(403);
		const [{ n: before }] = await asOwner('SELECT count(*)::int AS n FROM map_feature WHERE project_id = $1', [projectId]);
		const res = await editor.call('POST', at('/dam-trace'), { lon, lat });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.trace).toMatchObject({ minOccurrence: 25, methodVersion: 'trace-dam-1', geometry: { type: 'Polygon' } });
		expect(res.body.trace.areaM2).toBeGreaterThan(20_000);
		const [{ n: after }] = await asOwner('SELECT count(*)::int AS n FROM map_feature WHERE project_id = $1', [projectId]);
		expect(after).toBe(before);
		const dry = await editor.call('POST', at('/dam-trace'), { lon: DRY_CLICK[0], lat: DRY_CLICK[1] });
		expect(dry.status).toBe(422);
		expect(dry.body.details).toEqual({ reason: 'no_water' });
	});

	it('saves a traced outline as a dam with its method; an unadjusted outline must be the trace', async () => {
		const [lon, lat] = DAM_CLICK;
		const trace = (await editor.call('POST', at('/dam-trace'), { lon, lat, minOccurrence: 50 })).body.trace;
		const saved = await editor.call('POST', at('/features'), { kind: 'dam', name: 'Traced dam', geometry: trace.geometry, traced: { lon, lat, minOccurrence: 50, edited: false } });
		expect(saved.status, JSON.stringify(saved.body)).toBe(201);
		expect(saved.body.feature.properties.description).toMatch(/^Traced from Synthetic water occurrence .*\(trace-dam-1\): water in at least 50 % of the observations, clicked at 33\.\d{4}° S, 21\.\d{4}° E\. Check it against the map\.$/);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'map.feature_created' AND subject->>'featureId' = $2`, [projectId, saved.body.feature.id]);
		expect(ev!.subject).toMatchObject({ from: 'dam_trace', minOccurrence: 50, edited: false, dataset: expect.stringMatching(/Synthetic/) });

		// Another outline sent as the unadjusted trace is refused; sent as adjusted, it says so.
		const other = square(21.31, -33.68, 0.002);
		const lie = await editor.call('POST', at('/features'), { kind: 'dam', geometry: other, traced: { lon, lat, minOccurrence: 50, edited: false } });
		expect(lie.status).toBe(400);
		expect(lie.body.error).toMatch(/isn’t the one traced there/);
		const adjusted = await editor.call('POST', at('/features'), { kind: 'dam', geometry: other, traced: { lon, lat, minOccurrence: 50, edited: true } });
		expect(adjusted.status).toBe(201);
		expect(adjusted.body.feature.properties.description).toMatch(/; then adjusted by hand\./);
		// Only a dam or an other area is traced; a point never.
		expect((await editor.call('POST', at('/features'), { kind: 'farm_parcel', geometry: other, traced: { lon, lat, minOccurrence: 50, edited: true } })).status).toBe(400);
	});

	it('is off without WATER_URL: the state says so and a trace is refused', async () => {
		const url = process.env.WATER_URL;
		delete process.env.WATER_URL;
		try {
			expect((await viewer.call('GET', at('/dam-trace'))).body).toEqual({ available: false, dataset: null });
			expect((await editor.call('POST', at('/dam-trace'), { lon: DAM_CLICK[0], lat: DAM_CLICK[1] })).status).toBe(409);
		} finally {
			process.env.WATER_URL = url;
		}
	});
});
