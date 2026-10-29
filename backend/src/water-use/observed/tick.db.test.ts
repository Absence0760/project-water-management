// The worker's observed ET tick end to end (issue #623 step 4; tick.ts,
// 277_et_observation.sql, 281_et_units.sql): two units with farm parcels in a
// project, the committed synthetic land cover loaded (cropland under one of
// them), the tick writing the wanted list with each unit's parcels and its
// cropland, the WaPOR pass reading the synthetic dekads (no network), and the
// next tick loading them into et_observation with their load marks. Then: a
// rewritten upstream file revises a row; a redrawn parcel drops the unit's
// rows, its old file is refused, and the pass's new one loads; a fresh
// process loads nothing it already loaded; the loads per tick are capped;
// and runTick runs it from the process env.
//
// Under a skewed TZ (CLAUDE.md rule 7): the dekads and the pass's today are
// UTC days whatever the server's zone.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyntheticLandCover } from '../../../scripts/import-land-cover.js';
import { asOwner, node, retirePendingJobs, signUp } from '../../__tests__/helpers.js';
import { withoutUser, withUser } from '../../db/tx.js';
import { utcToday } from '../../feeds/fetch.js';
import { fixtureHttp } from '../../feeds/fixtures.js';
import { runTick } from '../../jobs/runner.js';
import { openStore } from '../../mirror/store.js';
import { readEtFile, readStatus, readWanted, writeEtFile, writeStatus } from './handover.js';
import { runWaporPass } from './pass.js';
import { resetEtTick, runEtTick } from './tick.js';
import { dekadOf, previousDekad } from './wapor.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;
const outlet = node('Weir', null);
// Farm A inside the synthetic land cover's cropland (every cell 0.5 inside 21.30–21.35° E, 33.65–33.70° S); Farm B outside any.
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);
let parcelB: string;
let dir: string;
let url: string;
const env = () => ({ ET_OBSERVATIONS: 'on', MIRROR_URL: url });
const store = () => openStore(url);
const zone = process.env.TZ;
const square = (w: number, s: number, size = 0.01) => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[w + size, s],
			[w + size, s + size],
			[w, s + size],
			[w, s]
		]
	]
});
/** Six dekads back: enough to see the pass work, few enough files to make. */
const firstDekad = () => {
	let d = dekadOf(utcToday());
	for (let i = 0; i < 6; i++) d = previousDekad(d);
	return d;
};
const pass = () => runWaporPass({ store: store(), http: fixtureHttp(), today: utcToday(), intervalMs: 0, firstDekad: firstDekad() });
const held = async (nodeId: string) =>
	(
		await withUser(owner.id, async (db) =>
			(await db.query<{ dekad: string; eta_mm_day: number; valid_share: number; mask: string; revision: number; upstream_etag: string | null }>(
				`SELECT to_char(dekad, 'YYYY-MM-DD') AS dekad, eta_mm_day, valid_share, mask, revision, upstream_etag FROM et_observation WHERE node_id = $1 ORDER BY dekad`,
				[nodeId]
			)).rows
		)
	);

beforeAll(async () => {
	process.env.TZ = 'Pacific/Kiritimati';
	owner = await signUp('Ettick');
	projectId = (await owner.call('POST', '/projects', { name: 'Observed ET tick' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [nodeId, geometry] of [
		[farmA.id, square(21.31, -33.69)],
		[farmB.id, square(21.6, -33.6)]
	] as const) {
		const res = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'farm_parcel', name: 'Parcel', nodeId, geometry });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		if (nodeId === farmB.id) parcelB = res.body.feature.id;
	}
	await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!);
}, 60_000);
beforeEach(() => {
	resetEtTick();
	dir = mkdtempSync(join(tmpdir(), 'wm-et-tick-'));
	url = pathToFileURL(`${dir}/`).href;
});
afterEach(async () => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	await asOwner('DELETE FROM et_observation WHERE project_id = $1', [projectId]);
	await asOwner('DELETE FROM et_observation_load_mark WHERE node_id = ANY($1::uuid[])', [[farmA.id, farmB.id]]);
});
afterAll(async () => {
	process.env.TZ = zone;
	if (projectId) {
		await retirePendingJobs(projectId);
		await asOwner('DELETE FROM project WHERE id = $1', [projectId]);
	}
});

describe('the ET tick', () => {
	it('is off unless ET_OBSERVATIONS=on, and needs a bucket of its own', async () => {
		expect(await runEtTick({ env: { MIRROR_URL: url } })).toBeNull();
		expect(await runEtTick({ env: { ET_OBSERVATIONS: 'off', MIRROR_URL: url } })).toBeNull();
		expect(await runEtTick({ env: { ET_OBSERVATIONS: 'maybe', MIRROR_URL: url } })).toBeNull();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await runEtTick({ env: { ET_OBSERVATIONS: 'on' } })).toMatchObject({ units: 0, published: false });
		vi.restoreAllMocks();
	});

	it('hands the pass each unit’s parcels and cropland, then loads what it read, with its load marks', async () => {
		const first = (await runEtTick({ env: env(), store: store() }))!;
		expect(first).toMatchObject({ published: true, loaded: 0, failed: 0 });
		expect(first.units).toBeGreaterThanOrEqual(2);
		const wanted = (await readWanted(store()))!;
		const a = wanted.units.find((u) => u.unitKey === farmA.id)!;
		const b = wanted.units.find((u) => u.unitKey === farmB.id)!;
		expect(a.parcels).toEqual({ type: 'MultiPolygon', coordinates: [square(21.31, -33.69).coordinates] });
		expect(a.cropland).toMatchObject({ dataset: 'synthetic', cellDeg: 0.005 });
		expect(a.cropland!.cells.length).toBeGreaterThan(0);
		expect(b.cropland).toBeUndefined();
		// Only geometry and ids cross the bucket: no name, project or person.
		const text = JSON.stringify(wanted);
		for (const word of ['Farm A', 'Weir', projectId, owner.id]) expect(text).not.toContain(word);

		const r = await pass();
		expect(r).toMatchObject({ stopped: 'done', failures: [] });
		expect(r.written).toEqual(expect.arrayContaining([farmA.id, farmB.id]));

		const second = (await runEtTick({ env: env(), store: store() }))!;
		expect(second).toMatchObject({ published: false, failed: 0, refused: 0 });
		expect(second.loaded).toBeGreaterThanOrEqual(2);
		const rowsA = await held(farmA.id);
		const rowsB = await held(farmB.id);
		expect(rowsA.length).toBeGreaterThan(0);
		expect(rowsA.map((x) => x.dekad)).toEqual((await readEtFile(store(), 'wapor', farmA.id))!.rows.map((x) => x.dekad));
		expect(rowsA.map((x) => [x.mask, x.revision, /^"fx-/.test(x.upstream_etag ?? '')])).toEqual(rowsA.map(() => ['cropland', 1, true]));
		// A dekad the synthetic cloud covered the parcel in has no valid pixel (and so a mean of 0 that says nothing); every other has ET.
		expect(rowsA.every((x) => x.valid_share === 0 || x.eta_mm_day > 0)).toBe(true);
		expect(rowsA.some((x) => x.valid_share > 0)).toBe(true);
		expect(rowsB.every((x) => x.mask === 'parcel')).toBe(true);
		const marks = await withoutUser(async (db) => (await db.query<{ node_id: string; last_good: Date; fetched_at: Date }>('SELECT node_id, last_good, fetched_at FROM app_et_load_marks()')).rows);
		expect(marks.filter((m) => m.node_id === farmA.id || m.node_id === farmB.id).every((m) => m.last_good && m.fetched_at)).toBe(true);

		// Nothing new: nothing loaded, and a fresh process repeats nothing either (the marks are in the database).
		expect(await runEtTick({ env: env(), store: store() })).toMatchObject({ loaded: 0, unchanged: 0, published: false });
		resetEtTick();
		expect(await runEtTick({ env: env(), store: store() })).toMatchObject({ loaded: 0, unchanged: 0 });

		// FAO rewrote a dekad (another value and ETag), so the pass wrote the file again: the row is revised.
		const f = (await readEtFile(store(), 'wapor', farmA.id))!;
		const changed = { ...f, fetchedAt: new Date().toISOString(), rows: f.rows.map((x, i) => (i === 0 ? { ...x, etaMmDay: x.etaMmDay + 1, etag: '"fx-rewritten"' } : x)) };
		await writeEtFile(store(), changed);
		const status = (await readStatus(store(), 'wapor'))!;
		await writeStatus(store(), { ...status, perKey: { ...status.perKey, [farmA.id]: { ...status.perKey[farmA.id], lastGood: changed.fetchedAt } } });
		expect(await runEtTick({ env: env(), store: store() })).toMatchObject({ loaded: 1, rows: 1, revised: 1 });
		expect((await held(farmA.id))[0]).toMatchObject({ revision: 2, upstream_etag: '"fx-rewritten"' });
	}, 60_000);

	it('a redrawn parcel drops the unit’s rows; its old file is refused, and the pass’s new one loads', async () => {
		await runEtTick({ env: env(), store: store() });
		await pass();
		await runEtTick({ env: env(), store: store() });
		expect((await held(farmB.id)).length).toBeGreaterThan(0);

		const res = await owner.call('PATCH', `/projects/${projectId}/map/features/${parcelB}`, { geometry: square(21.62, -33.6, 0.02) });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(await held(farmB.id)).toEqual([]);
		// The tick publishes the new parcels and finds the unit due (the trigger cleared its mark), but its file is from the old parcels.
		const t = (await runEtTick({ env: env(), store: store() }))!;
		expect(t).toMatchObject({ published: true, refused: 1, failed: 0 });
		expect((await readWanted(store()))!.units.find((u) => u.unitKey === farmB.id)!.changedAt).toBeTruthy();
		expect(await held(farmB.id)).toEqual([]);
		// The pass starts the unit again over its new parcels; the next tick loads it.
		await pass();
		// Farm A's file was relabelled from the new list too (parcelsAt), so it loads again, writing nothing.
		const after = (await runEtTick({ env: env(), store: store() }))!;
		expect(after).toMatchObject({ refused: 0, failed: 0 });
		expect(after.loaded).toBeGreaterThanOrEqual(1);
		const rows = await held(farmB.id);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((x) => x.revision === 1)).toBe(true);
	}, 60_000);

	it('loads at most loadsPerTick files a tick, oldest first, the rest the next tick', async () => {
		await runEtTick({ env: env(), store: store() });
		await pass();
		const r1 = (await runEtTick({ env: env(), store: store(), loadsPerTick: 1 }))!;
		expect(r1.loaded).toBe(1);
		expect(r1.deferred).toBeGreaterThanOrEqual(1);
		const r2 = (await runEtTick({ env: env(), store: store() }))!;
		expect(r2.loaded).toBe(r1.deferred);
		expect(r2.deferred).toBe(0);
	}, 60_000);
});

// The worker's tick (jobs/runner.ts runTick) runs it beside the dams tick, from the process env.
describe('runTick', () => {
	afterEach(() => vi.unstubAllEnvs());
	const tick = (feeds = true) => runTick({ feeds, reports: false, alerts: false });

	it('reports the ET tick in result.et with ET_OBSERVATIONS=on, null with it off, and leaves it out with feeds off', async () => {
		vi.stubEnv('ET_OBSERVATIONS', 'on');
		vi.stubEnv('MIRROR_URL', url);
		expect((await tick()).et).toMatchObject({ published: true, failed: 0 });
		vi.stubEnv('ET_OBSERVATIONS', 'off');
		expect((await tick()).et).toBeNull();
		expect('et' in (await tick(false))).toBe(false);
	});
});
