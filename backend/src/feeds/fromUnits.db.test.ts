// Rain for each hydrological unit (issue #482 part B, feeds/fromUnits.ts):
// the proposal (editor) and its apply (owner) as the roles see them, with
// positive controls; the cells of a synthetic parcel, a unit without a
// polygon listed, gauges and water users never listed; create, then nothing
// to do, then an update when the parcel moves or the product changes (the
// series still empty), a refusal once the series holds days; one History
// entry per apply; the unit's series sited at the unit, which a run reads
// under `rain_chirps_mm@<unit>`, and which a feed's fetch fills (and, if the
// series is deleted, creates again at its unit). Synthetic geometry only.
//
// DB test files run one at a time; like fromBoundary.db.test.ts this file
// removes every feed and feed job after each test.
import { unitRainSeriesKey } from '@water-management/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { loadModelInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
/** About 0.06° × 0.05° inside the fixture grid's cover: 2 columns × 2 rows of 0.05° cells. */
const PARCEL_A = { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.27, -33.74)] };

async function setup() {
	const owner = await signUp('UnitsOwner');
	const editor = await signUp('UnitsEditor');
	const viewer = await signUp('UnitsViewer');
	const stranger = await signUp('UnitsStranger');
	const pid = (await owner.call('POST', '/projects', { name: 'Rain for each unit' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
	}
	const outlet = node('Outlet', null);
	const a = node('Unit A', outlet.id);
	const b = node('Unit B', outlet.id);
	const twin = node('Unit C', outlet.id);
	const user = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: Array(12).fill(100) });
	const model = { nodes: [outlet, a, b, twin, user], crops: [], cropAreas: [], transfers: [] };
	expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	return { owner, editor, viewer, stranger, pid, outlet, a, b, twin, user, model };
}
const at = (pid: string) => `/projects/${pid}/feeds/chirps/from-units`;
async function parcel(u: User, pid: string, nodeId: string, geometry: unknown = PARCEL_A, name = 'Parcel') {
	const r = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'farm_parcel', name, nodeId, geometry });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feature as { id: string; updatedAt: string; areaM2: number };
}
const unitSeries = async (pid: string, nodeId: string) =>
	asOwner(`SELECT id, name, site_node_id AS "siteNodeId", cardinality("values") AS n FROM time_series WHERE project_id = $1 AND kind = 'rain_chirps_mm' AND site_node_id = $2`, [pid, nodeId]);

describe('rain for each unit (from-units)', () => {
	it('proposes each land unit’s cells to editors, lists units without a polygon, and owners create one feed per unit, in one History entry', async () => {
		const s = await setup();
		const f = await parcel(s.editor, s.pid, s.a.id);
		// A water user's parcel is no land unit: never listed. Unit C has two parcels and no accepted area: refused.
		await parcel(s.editor, s.pid, s.user.id, { type: 'Polygon', coordinates: [ring(21.3, -33.7, 21.32, -33.68)] });
		await parcel(s.editor, s.pid, s.twin.id, { type: 'Polygon', coordinates: [ring(21.3, -33.7, 21.32, -33.68)] }, 'C1');
		await parcel(s.editor, s.pid, s.twin.id, { type: 'Polygon', coordinates: [ring(21.33, -33.7, 21.35, -33.68)] }, 'C2');

		// Viewers neither see the proposal nor apply it; a stranger meets 404; editors see it but can't apply (feeds are the owner's).
		expect((await s.viewer.call('GET', at(s.pid))).status).toBe(403);
		expect((await s.viewer.call('POST', at(s.pid), {})).status).toBe(403);
		expect((await s.stranger.call('GET', at(s.pid))).status).toBe(404);
		expect((await s.stranger.call('POST', at(s.pid), {})).status).toBe(404);
		const seen = await s.editor.call('GET', at(s.pid));
		expect(seen.status, JSON.stringify(seen.body)).toBe(200);
		expect(seen.body.canApply).toBe(false);
		expect((await s.editor.call('POST', at(s.pid), {})).status).toBe(403);

		// Positive control: the owner.
		const p = (await s.owner.call('GET', at(s.pid))).body;
		expect(p.product).toBe('rnl');
		expect(p.canApply).toBe(true);
		expect(p.units).toHaveLength(1);
		const u = p.units[0];
		expect(u).toMatchObject({ nodeId: s.a.id, name: 'Unit A', featureId: f.id, feedId: null, seriesDays: 0, action: 'create' });
		expect(u.areaKm2).toBeCloseTo(f.areaM2 / 1e6, 2);
		// 21.21–21.27 × −33.79…−33.74 on the 0.05° grid: columns 21.20–21.25, 21.25–21.30; rows −33.80…−33.75, −33.75…−33.70.
		expect(u.cells).toHaveLength(4);
		const byCentre = Object.fromEntries(u.cells.map((c: { lat: number; lon: number; share: number; weight: number }) => [`${c.lat},${c.lon}`, c]));
		expect(byCentre['-33.775,21.225'].share).toBeCloseTo((0.04 * 0.04) / 0.0025, 6);
		expect(byCentre['-33.725,21.275'].share).toBeCloseTo((0.02 * 0.01) / 0.0025, 6);
		expect(byCentre['-33.775,21.225'].weight).toBeCloseTo(0.64 * Math.cos((33.775 * Math.PI) / 180), 6);
		expect(p.withoutPolygon).toEqual([{ nodeId: s.b.id, name: 'Unit B' }]);
		expect(p.refused).toEqual([{ nodeId: s.twin.id, name: 'Unit C', reason: expect.stringMatching(/several parcels on the map and none is its area/) }]);

		const r = await s.owner.call('POST', at(s.pid), {});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body).toMatchObject({ created: 1, updated: 0, feeds: [{ nodeId: s.a.id, feedId: expect.any(String) }] });
		expect(r.body.skipped.map((x: { nodeId: string }) => x.nodeId).sort()).toEqual([s.b.id, s.twin.id].sort());
		const feedId = r.body.feeds[0].feedId as string;
		const feed = (await s.owner.call('GET', `/projects/${s.pid}/feeds`)).body.feeds.find((x: { id: string }) => x.id === feedId);
		expect(feed).toMatchObject({
			source: 'chirps',
			targetKind: 'rain_chirps_mm',
			targetName: 'CHIRPS v3 (rnl) Unit A',
			config: { product: 'rnl', startDate: '1981-01-01', unit: { nodeId: s.a.id, featureId: f.id, updatedAt: f.updatedAt }, cells: u.cells.map(({ lat, lon, weight }: { lat: number; lon: number; weight: number }) => ({ lat, lon, weight })) }
		});
		// Its series exists already, empty, sited at the unit.
		expect(await unitSeries(s.pid, s.a.id)).toEqual([{ id: expect.any(String), name: 'CHIRPS v3 (rnl) Unit A', siteNodeId: s.a.id, n: 0 }]);
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured'`, [s.pid]);
		expect(events).toHaveLength(1);
		expect(events[0].subject).toMatchObject({ action: 'units', source: 'chirps', product: 'rnl', created: 1, updated: 0, units: [{ nodeId: s.a.id, name: 'Unit A', feedId, action: 'created', cells: 4 }] });

		// Applied: nothing to do, and a second apply changes nothing and records nothing.
		const again = (await s.owner.call('GET', at(s.pid))).body.units[0];
		expect(again).toMatchObject({ feedId, action: 'none' });
		expect((await s.owner.call('POST', at(s.pid), {})).body).toMatchObject({ created: 0, updated: 0, feeds: [{ nodeId: s.a.id, feedId }] });
		expect(await asOwner(`SELECT 1 FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured'`, [s.pid])).toHaveLength(1);

		// Unit C's area accepted from one parcel: that one is its polygon now.
		const c1 = (await s.owner.call('GET', `/projects/${s.pid}/map/features`)).body.features.find((x: { name: string }) => x.name === 'C1');
		expect((await s.owner.call('POST', `/projects/${s.pid}/nodes/${s.twin.id}/area-from-map`, { featureId: c1.id })).status).toBe(200);
		expect((await s.owner.call('GET', at(s.pid))).body.units.find((x: { nodeId: string }) => x.nodeId === s.twin.id)).toMatchObject({ featureId: c1.id, action: 'create' });
	});

	it('updates a feed whose series is still empty when the parcel moves or the product changes, and refuses once it holds days', async () => {
		const s = await setup();
		const f = await parcel(s.owner, s.pid, s.a.id);
		const feedId = (await s.owner.call('POST', at(s.pid), { product: 'rnl' })).body.feeds[0].feedId as string;
		const config = async () => (await s.owner.call('GET', `/projects/${s.pid}/feeds`)).body.feeds.find((x: { id: string }) => x.id === feedId);

		// The parcel moves: one cell now.
		const moved = await s.owner.call('PATCH', `/projects/${s.pid}/map/features/${f.id}`, { geometry: { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.24, -33.76)] } });
		expect(moved.status).toBe(200);
		expect((await s.owner.call('GET', at(s.pid))).body.units[0]).toMatchObject({ feedId, action: 'update' });
		const up = await s.owner.call('POST', at(s.pid), {});
		expect(up.body).toMatchObject({ created: 0, updated: 1, feeds: [{ nodeId: s.a.id, feedId }] });
		expect((await config()).config.cells).toHaveLength(1);
		expect((await config()).config.unit.updatedAt).toBe(moved.body.feature.updatedAt);

		// Another product, the series still empty: the feed reads it, and its series is renamed to say so.
		const sat = await s.owner.call('POST', at(s.pid), { product: 'sat' });
		expect(sat.body).toMatchObject({ updated: 1 });
		expect(await config()).toMatchObject({ targetName: 'CHIRPS v3 (sat) Unit A', config: { product: 'sat', startDate: '1998-01-01' } });
		expect(await unitSeries(s.pid, s.a.id)).toEqual([expect.objectContaining({ name: 'CHIRPS v3 (sat) Unit A', siteNodeId: s.a.id })]);
		// The proposal follows the feeds' own product when none is asked for.
		expect((await s.owner.call('GET', at(s.pid))).body).toMatchObject({ product: 'sat', units: [{ action: 'none' }] });
		expect((await s.owner.call('GET', `${at(s.pid)}?product=rnl`)).body.units[0].action).toBe('update');
		expect((await s.owner.call('GET', `${at(s.pid)}?product=daily`)).status).toBe(400);
		// A start before the product's first day is refused.
		expect((await s.owner.call('POST', at(s.pid), { product: 'sat', startDate: '1990-01-01' })).status).toBe(400);

		// Once the series holds days, new cells would splice two areas: refused, and the feed is left as it is.
		const [series] = await unitSeries(s.pid, s.a.id);
		await asOwner(`UPDATE time_series SET start_date = '2024-01-01', "values" = '{1,0,2}' WHERE id = $1`, [series.id]);
		await s.owner.call('PATCH', `/projects/${s.pid}/map/features/${f.id}`, { geometry: PARCEL_A });
		const p = (await s.owner.call('GET', at(s.pid))).body;
		expect(p.units).toEqual([]);
		expect(p.refused).toEqual([{ nodeId: s.a.id, name: 'Unit A', reason: expect.stringMatching(/its parcel changed after its feed began fetching/) }]);
		const named = await s.owner.call('POST', at(s.pid), { nodeIds: [s.a.id] });
		expect(named.status).toBe(409);
		expect(named.body.details).toMatchObject({ code: 'unit_refused', units: [{ nodeId: s.a.id }] });
		expect((await config()).config.cells).toHaveLength(1);
		// Unit B has no polygon: naming it is a 409 too; a node that isn't a land unit, a 400.
		expect((await s.owner.call('POST', at(s.pid), { nodeIds: [s.b.id] })).status).toBe(409);
		expect((await s.owner.call('POST', at(s.pid), { nodeIds: [s.user.id] })).body.details).toMatchObject({ code: 'unit_unknown' });
		// The run reads the unit's days under its key; the catchment has no CHIRPS of its own.
		const input = await withUser(s.owner.id, (db) => loadModelInput(db, s.pid));
		expect(input.series[unitRainSeriesKey('rain_chirps_mm', s.a.id)]).toMatchObject({ startDate: '2024-01-01', values: [1, 0, 2] });
		expect(input.series.rain_chirps_mm).toBeUndefined();
	});

	it('writes into the unit’s own empty CHIRPS series if it has one, and refuses while one with days has no feed', async () => {
		const s = await setup();
		await parcel(s.owner, s.pid, s.a.id);
		const own = (await s.owner.call('PUT', `/projects/${s.pid}/series`, { kind: 'rain_chirps_mm', name: 'A own', unit: 'mm', startDate: '2024-01-01', values: [1, 2] })).body.id as string;
		expect((await s.owner.call('PATCH', `/projects/${s.pid}/series/${own}`, { siteNodeId: s.a.id })).status).toBe(200);
		expect((await s.owner.call('GET', at(s.pid))).body.refused).toEqual([{ nodeId: s.a.id, name: 'Unit A', reason: expect.stringMatching(/already has a CHIRPS series of its own \(“A own”\) that no feed writes/) }]);
		// Emptied: the feed takes that series, so the unit has one CHIRPS series, not two (a run reads the first by name).
		await asOwner(`UPDATE time_series SET "values" = '{}' WHERE id = $1`, [own]);
		const r = await s.owner.call('POST', at(s.pid), {});
		expect(r.body.created).toBe(1);
		expect((await s.owner.call('GET', `/projects/${s.pid}/feeds`)).body.feeds[0].targetName).toBe('A own');
		expect(await unitSeries(s.pid, s.a.id)).toEqual([expect.objectContaining({ id: own, name: 'A own' })]);
	});

	it('never reaches another project’s unit, and the plain feed routes can’t claim a unit mark', async () => {
		const s = await setup();
		const t = await setup();
		await parcel(t.owner, t.pid, t.a.id);
		// s's owner sees only s's units (none with a polygon), never t's.
		const p = (await s.owner.call('GET', at(s.pid))).body;
		expect(p.units).toEqual([]);
		expect(p.withoutPolygon.map((u: { nodeId: string }) => u.nodeId)).not.toContain(t.a.id);
		expect((await s.owner.call('POST', at(s.pid), { nodeIds: [t.a.id] })).status).toBe(400);
		expect(await asOwner('SELECT 1 FROM data_feed WHERE project_id = $1', [t.pid])).toEqual([]);
		const claim = await s.owner.call('POST', `/projects/${s.pid}/feeds`, {
			source: 'chirps',
			config: { cells: [{ lat: -33.775, lon: 21.225 }], unit: { nodeId: s.a.id, featureId: crypto.randomUUID(), updatedAt: new Date().toISOString(), areaKm2: 1 } }
		});
		expect(claim.status).toBe(400);
		expect(claim.body.error).toMatch(/marked as a unit’s only by “Rain for each unit”/);
	});

	it('fetches offline into the unit’s own series, and a deleted series comes back at its unit (209)', async () => {
		const s = await setup();
		await parcel(s.owner, s.pid, s.a.id);
		const r = await s.owner.call('POST', at(s.pid), { product: 'rnl', startDate: '2024-01-01' });
		const feedId = r.body.feeds[0].feedId as string;
		expect((await s.owner.call('POST', `/projects/${s.pid}/feeds/${feedId}/run-now`)).status).toBe(202);
		await runTick({ feeds: false, reports: false, alerts: false });
		const listed = (await s.owner.call('GET', `/projects/${s.pid}/feeds`)).body.feeds[0];
		expect(listed).toMatchObject({ consecutiveFailures: 0, lastError: null });
		const [series] = await unitSeries(s.pid, s.a.id);
		expect(series.n).toBeGreaterThan(50);
		expect((await s.owner.call('GET', at(s.pid))).body.units[0].seriesDays).toBeGreaterThan(50);
		expect((await withUser(s.owner.id, (db) => loadModelInput(db, s.pid))).series[unitRainSeriesKey('rain_chirps_mm', s.a.id)]).toBeDefined();

		// Someone deletes the series; the feed's next write creates it with its feed_id, and the trigger sites it at the unit,
		// so the unit's rain never quietly becomes the catchment's.
		expect((await s.owner.call('DELETE', `/projects/${s.pid}/series/${series.id}`)).status).toBe(204);
		await asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id) VALUES ($1, 'rain_chirps_mm', 'CHIRPS v3 (rnl) Unit A', 'mm', '2024-01-01', '{1}', $2)`, [s.pid, feedId]);
		expect(await unitSeries(s.pid, s.a.id)).toEqual([expect.objectContaining({ siteNodeId: s.a.id, n: 1 })]);
		// Positive control: a series a plain feed creates stays the catchment's.
		const plain = (await s.owner.call('POST', `/projects/${s.pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -33.775, lon: 21.225 }] } })).body.feed.id as string;
		await asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", feed_id) VALUES ($1, 'rain_chirps_mm', '', 'mm', '2024-01-01', '{1}', $2)`, [s.pid, plain]);
		expect((await asOwner(`SELECT site_node_id FROM time_series WHERE project_id = $1 AND kind = 'rain_chirps_mm' AND name = ''`, [s.pid]))[0].site_node_id).toBeNull();
		await asOwner('DELETE FROM data_feed WHERE id = $1', [plain]);

		// The unit leaves the model: the feed's next answer is refused in words of its own, never the database's site check.
		expect((await s.owner.call('PUT', `/projects/${s.pid}/model`, { ...s.model, nodes: s.model.nodes.filter((n) => n.id !== s.a.id) })).status).toBe(200);
		await asOwner(`DELETE FROM time_series WHERE project_id = $1 AND site_node_id = $2`, [s.pid, s.a.id]);
		// 200: the backfill's next window is already queued (from 2024, one window doesn't catch up), and Run now pulls it forward.
		expect((await s.owner.call('POST', `/projects/${s.pid}/feeds/${feedId}/run-now`)).status).toBe(200);
		await runTick({ feeds: false, reports: false, alerts: false });
		const gone = (await s.owner.call('GET', `/projects/${s.pid}/feeds`)).body.feeds.find((x: { id: string }) => x.id === feedId);
		expect(gone.lastError).toBe('this feed’s unit is no longer in the model, so nothing was written: remove the feed, or set the unit’s rain up again (Rain for each unit)');
		expect(gone.consecutiveFailures).toBe(1);
		expect(await unitSeries(s.pid, s.a.id)).toEqual([]);
	});
});
