// The worker's dams tick end to end (issue #604 R5): the synthetic
// Waterbodies set loaded as the operator would, the Sandspruit example's dams
// traced in a project, the tick matching them and writing the wanted list,
// the Waterbodies pass reading the synthetic series (no network), and the
// next tick loading them; plus a WOfS file loaded by the same path, and a
// reload of the reference set matching every dam again.
//
// DB test files run one at a time; this one removes the reference rows and its project after.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildExamples } from '../../../scripts/examples/catchments.js';
import { sandspruitMap } from '../../../scripts/examples/map.js';
import { importWaterbodies, parseArgs } from '../../../scripts/import-waterbodies.js';
import { caseOf } from '../../../scripts/waterbodies-fixture.js';
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { withUser } from '../../db/tx.js';
import { openStore } from '../../mirror/store.js';
import { readWanted, writeObservationFile, writeStatus } from './handover.js';
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

beforeAll(async () => {
	owner = await signUp('Dtick');
	projectId = (await owner.call('POST', '/projects', { name: 'Observed Sandspruit' })).body.project.id;
	const sandspruit = buildExamples().find((e) => e.name.includes('Sandspruit'))!;
	for (const f of sandspruitMap(sandspruit.model).filter((x) => x.kind === 'dam')) {
		const res = await owner.call('POST', `/projects/${projectId}/map/features`, { kind: 'dam', name: f.name, geometry: f.geometry });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		dams.set(f.name, res.body.feature.id);
	}
	expect((await importWaterbodies(OWNER_URL(), parseArgs([]) as Exclude<ReturnType<typeof parseArgs>, string>)).written).toBeGreaterThan(0);
}, 60_000);
beforeEach(() => {
	resetDamsTick();
	dir = mkdtempSync(join(tmpdir(), 'wm-dams-tick-'));
	url = pathToFileURL(`${dir}/`).href;
});
afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	await asOwner('DELETE FROM project WHERE id = $1', [projectId]);
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

	it('matches every dam again after the reference set is reloaded', async () => {
		await runDamsTick({ env: env(), store: store() });
		expect((await runDamsTick({ env: env(), store: store() }))!.matched).toBe(0);
		await importWaterbodies(OWNER_URL(), parseArgs([]) as Exclude<ReturnType<typeof parseArgs>, string>);
		expect((await runDamsTick({ env: env(), store: store() }))!.matched).toBeGreaterThanOrEqual(dams.size);
	});
});
