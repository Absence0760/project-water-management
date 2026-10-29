// The worker's dams tick end to end (issue #604 R5): the synthetic
// Waterbodies set loaded as the operator would, the Sandspruit example's dams
// traced in a project, the tick matching them and writing the wanted list,
// the Waterbodies pass reading the synthetic series (no network), and the
// next tick loading them; plus a WOfS file loaded by the same path, and a
// reload of the reference set matching every dam again. Then the bounds: a
// dam too large or too complex to compare is recorded 'none' with its reason
// (and another project's dam is matched the same tick), and the loads per
// tick are capped, oldest first, and remembered in the database, so a fresh
// process reads no file it already loaded.
//
// The whole file runs under a skewed TZ (CLAUDE.md rule 7): the observation
// dates, the wanted list's `since` (the day after the newest WOfS row) and the
// pass's today are UTC days whatever the server's zone.
//
// DB test files run one at a time; this one removes the reference rows and its project after.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExamples } from '../../../scripts/examples/catchments.js';
import { sandspruitMap } from '../../../scripts/examples/map.js';
import { importWaterbodies, parseArgs } from '../../../scripts/import-waterbodies.js';
import { caseOf } from '../../../scripts/waterbodies-fixture.js';
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { withoutUser, withUser } from '../../db/tx.js';
import { runTick } from '../../jobs/runner.js';
import { openStore } from '../../mirror/store.js';
import type { MirrorStore } from '../../mirror/store.js';
import { type DamOutlineGeometry, readStatus, readWanted, writeObservationFile, writeStatus } from './handover.js';
import { resetDamsTick, runDamsTick } from './tick.js';
import { fixtureWaterbodiesHttp, runWaterbodiesPass } from './waterbodies.js';

type User = Awaited<ReturnType<typeof signUp>>;
const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;

let owner: User;
let projectId: string;
/** The project's dams by name. */
const dams = new Map<string, string>();
let dir: string;
let url: string;
const env = () => ({ DAM_OBSERVATIONS: 'on', MIRROR_URL: url });
const store = () => openStore(url);
const zone = process.env.TZ;
const withoutUserQuery = (sql: string, params: unknown[]) => withoutUser(async (db) => (await db.query(sql, params)).rows);
const readStatusOf = async (st: MirrorStore) => (await readStatus(st, 'wofs'))!;

beforeAll(async () => {
	// Far east of UTC: a date taken in the server's zone instead would be a day out for half of every day.
	process.env.TZ = 'Pacific/Kiritimati';
	owner = await signUp('Dtick');
	projectId = (await owner.call('POST', '/projects', { name: 'Observed Sandspruit' })).body.project.id;
	// Only its dams' outlines: no GR4J fit, which took ~15 s of this hook (and four times that on a slow runner).
	const sandspruit = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'))!;
	for (const f of sandspruitMap(sandspruit.model).filter((x) => x.kind === 'dam')) {
		const res = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'dam', name: f.name, geometry: f.geometry });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		dams.set(f.name, res.body.feature.id);
	}
	expect((await importWaterbodies(OWNER_URL(), parseArgs([]) as Exclude<ReturnType<typeof parseArgs>, string>)).written).toBeGreaterThan(0);
});
beforeEach(() => {
	resetDamsTick();
	dir = mkdtempSync(join(tmpdir(), 'wm-dams-tick-'));
	url = pathToFileURL(`${dir}/`).href;
});
afterAll(async () => {
	process.env.TZ = zone;
	// Each guarded: a failed beforeAll leaves some unset, and its own error is the one to read.
	if (dir) rmSync(dir, { recursive: true, force: true });
	if (projectId) await asOwner('DELETE FROM project WHERE id = $1', [projectId]);
	await asOwner('DELETE FROM waterbody_reference');
});

const mine = async () =>
	(await withUser(owner.id, async (db) => (await db.query<{ feature_id: string; status: string; uid: string | null }>('SELECT feature_id, status, uid FROM dam_waterbody_match WHERE project_id = $1', [projectId])).rows));
const observed = async (source: string) =>
	(
		await withUser(owner.id, async (db) =>
			(await db.query<{ feature_id: string; n: number; newest: string }>(
				`SELECT feature_id, count(*)::int AS n, to_char(max(obs_date), 'YYYY-MM-DD') AS newest FROM dam_observation WHERE project_id = $1 AND source = $2 GROUP BY feature_id`,
				[projectId, source]
			)).rows
		)
	).reduce((m, r) => m.set(r.feature_id, r), new Map<string, { n: number; newest: string }>());

describe('the dams tick', () => {
	it('is off unless DAM_OBSERVATIONS=on, and refuses the committed synthetic copy as its bucket', async () => {
		expect(await runDamsTick({ env: { MIRROR_URL: url } })).toBeNull();
		expect(await runDamsTick({ env: { DAM_OBSERVATIONS: 'off', MIRROR_URL: url } })).toBeNull();
		expect(await runDamsTick({ env: { DAM_OBSERVATIONS: 'maybe', MIRROR_URL: url } })).toBeNull();
		expect(await runDamsTick({ env: { DAM_OBSERVATIONS: 'on' } })).toMatchObject({ dams: 0, published: false });
	});

	it('matches the dams, hands the matched uids and every outline to the passes, and loads the series the pass fetched', async () => {
		const first = await runDamsTick({ env: env(), store: store() });
		expect(first!.published).toBe(true);
		const matches = new Map((await mine()).map((m) => [m.feature_id, m]));
		for (const [name, id] of dams) expect(matches.get(id)?.status, name).toBe(caseOf(name));

		const wanted = (await readWanted(store()))!;
		const matchedUids = [...matches.values()].filter((m) => m.status === 'matched').map((m) => m.uid!);
		expect(wanted.waterbodies).toEqual(expect.arrayContaining(matchedUids));
		const merged = [...matches.values()].find((m) => m.status === 'merged')!;
		expect(wanted.waterbodies).not.toContain(merged.uid);
		// Every dam's outline, matched or not, from Landsat's start (no WOfS row held yet).
		for (const id of dams.values()) expect(wanted.outlines.find((o) => o.featureId === id)).toMatchObject({ since: '1984-01-01', geometry: { type: 'Polygon' } });

		// The fetcher's pass, then the next tick.
		const pass = await runWaterbodiesPass({ store: store(), http: fixtureWaterbodiesHttp(), today: new Date().toISOString().slice(0, 10), intervalMs: 0 });
		expect(pass.fetched).toEqual(expect.arrayContaining(matchedUids));
		const second = await runDamsTick({ env: env(), store: store() });
		expect(second).toMatchObject({ published: false, failed: 0 });
		expect(second!.rows).toBeGreaterThan(0);
		const obs = await observed('waterbodies');
		for (const [name, id] of dams) {
			if (caseOf(name) === 'matched') expect(obs.get(id), name).toMatchObject({ newest: '2023-09-17' });
			else expect(obs.get(id), name).toBeUndefined();
		}

		// A third tick loads nothing again.
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ loaded: 0, rows: 0, matched: 0 });
	});

	it('loads a WOfS file by the same path, and tells the next WOfS pass to start after the newest row held', async () => {
		const none = dams.get('Klipdrift dam')!;
		await runDamsTick({ env: env(), store: store() });
		const fetchedAt = new Date().toISOString();
		await writeObservationFile(store(), {
			source: 'wofs',
			key: none,
			fetchedAt,
			upstream: [{ url: 'https://example.invalid/stac/item-1', itemId: 'item-1' }],
			rows: [
				{ date: '2026-09-01', wetAreaM2: 1200, pctObserved: 100, upstreamKey: 'item-1' },
				{ date: '2026-09-17', wetAreaM2: 900, pctObserved: 60, upstreamKey: 'item-2' }
			]
		});
		await writeStatus(store(), { source: 'wofs', ranAt: fetchedAt, stopped: false, perKey: { [none]: { lastGood: fetchedAt, newest: '2026-09-17' } } });
		const r = await runDamsTick({ env: env(), store: store() });
		expect(r).toMatchObject({ loaded: 1, failed: 0 });
		expect((await observed('wofs')).get(none)).toEqual({ feature_id: none, n: 2, newest: '2026-09-17' });
		resetDamsTick();
		await runDamsTick({ env: env(), store: store() });
		expect((await readWanted(store()))!.outlines.find((o) => o.featureId === none)!.since).toBe('2026-09-18');
	});

	it('takes a WOfS row dated tomorrow (UTC) late in the UTC day, and its since is the day after', async () => {
		const none = dams.get('Klipdrift dam')!;
		await runDamsTick({ env: env(), store: store() });
		// The server's zone (UTC+14) is already a day ahead of UTC here: tomorrow is UTC's.
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		const fetchedAt = new Date().toISOString();
		await writeObservationFile(store(), {
			source: 'wofs',
			key: none,
			fetchedAt,
			upstream: [{ url: 'https://example.invalid/stac/item-3', itemId: 'item-3' }],
			rows: [{ date: tomorrow, wetAreaM2: 800, pctObserved: 90, upstreamKey: 'item-3' }]
		});
		await writeStatus(store(), { source: 'wofs', ranAt: fetchedAt, stopped: false, perKey: { [none]: { lastGood: fetchedAt, newest: tomorrow } } });
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ loaded: 1, failed: 0 });
		expect((await observed('wofs')).get(none)!.newest).toBe(tomorrow);
		resetDamsTick();
		await runDamsTick({ env: env(), store: store() });
		const after = new Date(Date.parse(`${tomorrow}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
		expect((await readWanted(store()))!.outlines.find((o) => o.featureId === none)!.since).toBe(after);
	});

	it('loads Sentinel-2 and Sentinel-1 files as their own sources, and tells each pass where its own rows end (issue #624, 278)', async () => {
		const id = dams.get('Klipdrift dam')!;
		await runDamsTick({ env: env(), store: store() });
		// Before any Sentinel row: no sinceBy (each pass starts from its own backfill).
		expect((await readWanted(store()))!.outlines.find((o) => o.featureId === id)!.sinceBy).toBeUndefined();
		const fetchedAt = new Date().toISOString();
		for (const [source, newest] of [
			['s2', '2026-09-20'],
			['s1', '2026-09-12']
		] as const) {
			await writeObservationFile(store(), {
				source,
				key: id,
				fetchedAt,
				upstream: [{ url: `https://example.invalid/stac/${source}-item-1`, itemId: `${source}-item-1` }],
				rows: [
					{ date: '2026-09-02', wetAreaM2: 1100, pctObserved: 100, upstreamKey: `${source}-item-1` },
					{ date: newest, wetAreaM2: 950, pctObserved: 95, upstreamKey: `${source}-item-1` }
				]
			});
			await writeStatus(store(), { source, ranAt: fetchedAt, stopped: false, perKey: { [id]: { lastGood: fetchedAt, newest } } });
		}
		const wofsBefore = (await observed('wofs')).get(id);
		const r = await runDamsTick({ env: env(), store: store() });
		expect(r).toMatchObject({ loaded: 2, failed: 0 });
		expect((await observed('s2')).get(id)).toEqual({ feature_id: id, n: 2, newest: '2026-09-20' });
		expect((await observed('s1')).get(id)).toEqual({ feature_id: id, n: 2, newest: '2026-09-12' });
		// Positive control: the dam's WOfS rows are what they were, and so is its WOfS since.
		expect((await observed('wofs')).get(id)).toEqual(wofsBefore);
		resetDamsTick();
		await runDamsTick({ env: env(), store: store() });
		const listed = (await readWanted(store()))!.outlines.find((o) => o.featureId === id)!;
		expect(listed.sinceBy).toEqual({ s2: '2026-09-21', s1: '2026-09-13' });
		expect(listed.since).toBe(wofsBefore ? new Date(Date.parse(`${wofsBefore.newest}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : '1984-01-01');
		// Another dam with no Sentinel row lists none.
		const other = [...dams.values()].find((d) => d !== id)!;
		expect((await readWanted(store()))!.outlines.find((o) => o.featureId === other)!.sinceBy).toBeUndefined();
		// The worker's list itself (278): the newest row per source, the Sentinel ones included.
		const row = await withoutUser(async (db) =>
			(await db.query<{ s2: string; s1: string }>(`SELECT to_char(s2_newest, 'YYYY-MM-DD') AS s2, to_char(s1_newest, 'YYYY-MM-DD') AS s1 FROM app_dam_outlines() WHERE feature_id = $1`, [id])).rows[0]
		);
		expect(row).toEqual({ s2: '2026-09-20', s1: '2026-09-12' });
	});

	it('matches every dam again after the reference set is reloaded', async () => {
		await runDamsTick({ env: env(), store: store() });
		expect((await runDamsTick({ env: env(), store: store() }))!.matched).toBe(0);
		await importWaterbodies(OWNER_URL(), parseArgs([]) as Exclude<ReturnType<typeof parseArgs>, string>);
		expect((await runDamsTick({ env: env(), store: store() }))!.matched).toBeGreaterThanOrEqual(dams.size);
	});
});

/** A store that records the keys read, to see which files a tick GETs. */
function counting(inner: MirrorStore): { store: MirrorStore; gets: string[] } {
	const gets: string[] = [];
	const store = new Proxy(inner, {
		get(t, p) {
			if (p === 'get') return (key: string, opts?: unknown) => (gets.push(key), (t.get as (k: string, o?: unknown) => unknown)(key, opts));
			const v = Reflect.get(t, p, t);
			return typeof v === 'function' ? v.bind(t) : v;
		}
	});
	return { store, gets };
}

/** A square outline, `size` degrees a side (`sizeY` north–south), from its south-west corner. */
const square = (w: number, s: number, size: number, sizeY = size): DamOutlineGeometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[w + size, s],
			[w + size, s + sizeY],
			[w, s + sizeY],
			[w, s]
		]
	]
});

/**
 * A comb: `n` teeth running north–south from a strip along the south edge, their tips at scattered latitudes,
 * so the overlap's slab sweep has ~n slabs each crossed by ~n edges. A 600-tooth dam passes the outline checks;
 * against a 3000-tooth waterbody the overlap spends past GEO_MAX_SWEEP_STEPS.
 */
function comb(w: number, s: number, size: number, n: number, phase = 0): DamOutlineGeometry {
	const e = w + size;
	const base = s + size * 0.02;
	const dx = size / n;
	const ring: [number, number][] = [
		[w, s],
		[e, s],
		[e, base]
	];
	for (let i = n - 1; i >= 0; i--) {
		const xl = w + i * dx;
		const xr = xl + dx / 2;
		const tip = s + size * (0.5 + 0.49 * (((i * 7919 + phase) % n) / n));
		ring.push([xr, base], [xr, tip], [xl, tip], [xl, base]);
	}
	ring.push([w, s]);
	return { type: 'Polygon', coordinates: [ring] };
}

/** A waterbody of the test's own (dataset 'test'), as the operator's load would hold it. */
const addWaterbody = (uid: string, g: DamOutlineGeometry) => {
	const pts = (g.coordinates as [number, number][][]).flat();
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return asOwner(
		`INSERT INTO waterbody_reference (uid, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, source) VALUES ($1, 'test', $2, $3, $4, $5, $6, 1e6, 'test')`,
		[uid, JSON.stringify(g), Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
	);
};

describe('dams the match can’t compare', () => {
	let other: User;
	let projectX: string;
	let projectY: string;
	afterAll(async () => {
		await asOwner('DELETE FROM project WHERE id = ANY($1::uuid[])', [[projectX, projectY].filter(Boolean)]);
		await asOwner(`DELETE FROM waterbody_reference WHERE dataset = 'test'`);
	});
	const addDam = async (u: User, project: string, name: string, geometry: DamOutlineGeometry) => {
		const res = await u.call('POST', `/projects/${project}/map/features`, { kind: 'dam', name, geometry });
		expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
		return res.body.feature.id as string;
	};
	const matchOf = async (id: string) =>
		((await asOwner('SELECT status, uid, reason FROM dam_waterbody_match WHERE feature_id = $1', [id])) as { status: string; uid: string | null; reason: string | null }[])[0];

	it('records a dam too large or too complex as none with its reason, matches another project’s dam the same tick, and still asks WOfS for both', async () => {
		// Project X, traced first: a "dam" over 1° wide (past app_waterbody_candidates' box), and a comb against a comb waterbody.
		projectX = (await owner.call('POST', '/projects', { name: 'Unmatchable dams' })).body.project.id;
		const tooLarge = await addDam(owner, projectX, 'Too large', square(24.0, -30.9, 1.2, 0.01));
		const tooComplex = await addDam(owner, projectX, 'Too complex', comb(25.5, -30.5, 0.01, 600));
		await addWaterbody('zzzzzq0001', comb(25.4995, -30.5005, 0.011, 3000, 3));
		// Project Y, another owner, traced after: a dam its waterbody is.
		other = await signUp('Dtick2');
		projectY = (await other.call('POST', '/projects', { name: 'Matchable dam' })).body.project.id;
		const fine = await addDam(other, projectY, 'Fine', square(26.5, -30.5, 0.01));
		await addWaterbody('zzzzzq0002', square(26.4995, -30.5005, 0.0105));

		resetDamsTick();
		const r = (await runDamsTick({ env: env(), store: store() }))!;
		expect(r.matchFailed).toBe(0);
		expect(await matchOf(tooLarge)).toEqual({ status: 'none', uid: null, reason: 'too_large' });
		expect(await matchOf(tooComplex)).toEqual({ status: 'none', uid: null, reason: 'too_complex' });
		expect(await matchOf(fine)).toEqual({ status: 'matched', uid: 'zzzzzq0002', reason: null });

		// They left the stale list: the next tick matches nothing.
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ matched: 0, matchFailed: 0 });
		// WOfS observes every traced dam, compared or not.
		const outlines = (await readWanted(store()))!.outlines.map((o) => o.featureId);
		expect(outlines).toEqual(expect.arrayContaining([tooLarge, tooComplex, fine]));
	}, 60_000);

	it('refuses a reason on a dam that was compared, or one it doesn’t know (positive control: none with a reason)', async () => {
		const [f] = (await asOwner('SELECT id, updated_at FROM map_feature WHERE project_id = $1 LIMIT 1', [projectY])) as { id: string; updated_at: Date }[];
		const write = (status: string, uid: string | null, reason: string | null) =>
			withoutUserQuery('SELECT applied FROM app_dam_match_write($1, $2, $3, $4, $5, $6, $7)', [f!.id, status, uid, uid ? 0.9 : null, uid ? 0.9 : null, f!.updated_at, reason]);
		await expect(write('matched', 'zzzzzq0002', 'too_large')).rejects.toMatchObject({ code: '23514' });
		await expect(write('none', null, 'something')).rejects.toMatchObject({ code: '23514' });
		expect((await write('none', null, 'too_complex'))[0]).toEqual({ applied: true });
		expect(await matchOf(f!.id)).toEqual({ status: 'none', uid: null, reason: 'too_complex' });
	});
});

describe('the loads per tick', () => {
	/** A WOfS file and its status line for each dam, fetched a second apart (the first oldest). */
	const publish = async (st: MirrorStore, ids: string[], base: number, wet: number) => {
		const perKey: Record<string, { lastGood: string; newest: string }> = {};
		for (const [i, id] of ids.entries()) {
			const fetchedAt = new Date(base + i * 1000).toISOString();
			await writeWofs(st, id, fetchedAt, wet + i);
			perKey[id] = { lastGood: fetchedAt, newest: '2026-08-01' };
		}
		await writeStatus(st, { source: 'wofs', ranAt: new Date(base + ids.length * 1000).toISOString(), stopped: false, perKey });
	};
	const writeWofs = (st: MirrorStore, id: string, fetchedAt: string, wet: number) =>
		writeObservationFile(st, {
			source: 'wofs',
			key: id,
			fetchedAt,
			upstream: [{ url: 'https://example.invalid/stac/item-9', itemId: 'item-9' }],
			rows: [{ date: '2026-08-01', wetAreaM2: wet, pctObserved: 100, upstreamKey: 'item-9' }]
		});
	const wetOn = async (id: string) =>
		((await asOwner(`SELECT wet_area_m2 FROM dam_observation WHERE feature_id = $1 AND source = 'wofs' AND obs_date = '2026-08-01'`, [id])) as { wet_area_m2: number }[])[0]?.wet_area_m2;
	const wofsGets = (gets: string[]) => gets.filter((k) => k.startsWith('/dams/wofs/'));

	it('reads at most the cap a tick, oldest lastGood first, and the rest the next tick', async () => {
		const ids = [...dams.values()].slice(0, 3);
		expect(ids.length).toBe(3);
		await runDamsTick({ env: env(), store: store() });
		// After the dams were traced (a fetch from before is refused) and any fetch an earlier test loaded.
		await publish(store(), ids, Date.now(), 1000);
		const r1 = await runDamsTick({ env: env(), store: store(), loadsPerTick: 2 });
		expect(r1).toMatchObject({ loaded: 2, deferred: 1, failed: 0 });
		expect([await wetOn(ids[0]!), await wetOn(ids[1]!), await wetOn(ids[2]!)]).toEqual([1000, 1001, undefined]);
		expect(await runDamsTick({ env: env(), store: store(), loadsPerTick: 2 })).toMatchObject({ loaded: 1, deferred: 0 });
		expect(await wetOn(ids[2]!)).toBe(1002);
	});

	it('remembers what was loaded across a restart: a fresh process GETs no file it loaded, and loads a newer one', async () => {
		const ids = [...dams.values()].slice(0, 3);
		await runDamsTick({ env: env(), store: store() });
		const base = Date.now();
		await publish(store(), ids, base, 2000);
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ loaded: 3, deferred: 0 });

		// A fresh process: nothing in memory, the marks in the database.
		resetDamsTick();
		const quiet = counting(store());
		expect(await runDamsTick({ env: env(), store: quiet.store })).toMatchObject({ loaded: 0, unchanged: 0, failed: 0 });
		expect(wofsGets(quiet.gets)).toEqual([]);

		// The pass fetched one dam again: a newer fetchedAt and lastGood. Only that file is read and loaded.
		const fetchedAt = new Date(base + 4000).toISOString();
		await writeWofs(store(), ids[1]!, fetchedAt, 2500);
		const status = await readStatusOf(store());
		status.perKey[ids[1]!] = { lastGood: fetchedAt, newest: '2026-08-01' };
		await writeStatus(store(), status);
		resetDamsTick();
		const one = counting(store());
		expect(await runDamsTick({ env: env(), store: one.store })).toMatchObject({ loaded: 1, unchanged: 0 });
		expect(wofsGets(one.gets)).toEqual([`/dams/wofs/${ids[1]}.json`]);
		expect(await wetOn(ids[1]!)).toBe(2500);

		// A week the pass found nothing new: lastGood moves, the file doesn't. One GET, no load, then nothing.
		const s2 = await readStatusOf(store());
		s2.perKey[ids[0]!] = { lastGood: new Date(base + 5000).toISOString(), newest: '2026-08-01' };
		await writeStatus(store(), s2);
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ loaded: 0, unchanged: 1 });
		expect(await runDamsTick({ env: env(), store: store() })).toMatchObject({ loaded: 0, unchanged: 0 });
	});
});

// The worker's tick (jobs/runner.ts runTick) runs the dams tick beside the DWS one, from the process env.
describe('runTick', () => {
	afterEach(() => vi.unstubAllEnvs());
	const tick = (feeds = true) => runTick({ feeds, reports: false, alerts: false });

	it('reports the dams tick in result.dams with DAM_OBSERVATIONS=on', async () => {
		vi.stubEnv('DAM_OBSERVATIONS', 'on');
		vi.stubEnv('MIRROR_URL', url);
		const r = await tick();
		expect(r.dams).toMatchObject({ published: true, failed: 0 });
		expect(r.dams!.dams).toBeGreaterThanOrEqual(dams.size);
		expect((await readWanted(store()))!.outlines.map((o) => o.featureId)).toEqual(expect.arrayContaining([...dams.values()]));
	});

	it('reports null with it off or unset, and leaves it out with feeds off', async () => {
		vi.stubEnv('MIRROR_URL', url);
		vi.stubEnv('DAM_OBSERVATIONS', 'off');
		expect((await tick()).dams).toBeNull();
		vi.stubEnv('DAM_OBSERVATIONS', '');
		expect((await tick()).dams).toBeNull();
		vi.stubEnv('DAM_OBSERVATIONS', 'on');
		expect((await tick(false)).dams).toBeUndefined();
		// Nothing was written while it was off.
		expect(await readWanted(store())).toBeNull();
	});
});
