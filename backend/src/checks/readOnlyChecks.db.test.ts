// The read-only production checks against real Postgres (the migrate
// Lambda's `{ check }` event, docs/deployment.md § Read-only production
// checks): each finds the rows planted for it and none of the near misses,
// answers with ids, versions, modes, dates and flags only, and runs in a
// transaction that refuses a write. The test database is shared with other
// files, so each assertion looks at this file's project only. Synthetic data:
// a run's engine version, settings and allocation mode are written as owner.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, plantCompleteOutlook, signUp } from '../__tests__/helpers.js';
import { OWNER_URL } from '../__tests__/test-db.js';
import { withUser } from '../db/tx.js';
import { CHECKS, runCheck, type CheckResult, type ReadOnlyCheck } from './readOnlyChecks.js';

let client: pg.Client;
let owner: Awaited<ReturnType<typeof signUp>>;
let projectId: string;

/** A stored run of this project with these inputs, summary and engine version (as owner: no run of the model). */
async function plantRun(engineVersion: string, inputs: unknown = {}, summary: unknown = {}): Promise<string> {
	const rows = await asOwner(
		`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, summary)
		 VALUES ($1, $2, $3, '2000-10-01', '2001-09-30', $4, $5) RETURNING id`,
		[projectId, owner.id, engineVersion, JSON.stringify(inputs), JSON.stringify(summary)]
	);
	return rows[0]!.id as string;
}

const unitRain = (unitRain: unknown) => ({ settings: { unitRain } });
const mode = (m: string) => ({ allocations: { mode: m, tolerance: 0.1, used: 1, notMatched: 0, nodes: [] } });
const mine = (r: CheckResult) => r.rows.filter((row) => row.project_id === projectId);

beforeAll(async () => {
	owner = await signUp('Checks');
	projectId = (await owner.call('POST', '/projects', { name: 'Read-only checks' })).body.project.id as string;
	client = new pg.Client({ connectionString: OWNER_URL });
	await client.connect();
});
afterAll(async () => {
	await client?.end();
});

describe('unit-rain-reference-runs (issue #500)', () => {
	let hit: string;
	const misses: string[] = [];

	beforeAll(async () => {
		const perUnitRef = { mode: 'perUnit', reference: { gauge: 'catchment', unitId: 'u1' } };
		hit = await plantRun('1.82.0', unitRain(perUnitRef));
		misses.push(
			await plantRun('1.85.0', unitRain(perUnitRef)), // the fixed engine
			await plantRun('1.79.0', unitRain(perUnitRef)), // before the formula
			await plantRun('1.82.0', unitRain({ mode: 'perUnit' })), // no reference gauge
			await plantRun('1.82.0', unitRain({ mode: 'perUnit', reference: null })),
			await plantRun('1.82.0', unitRain({ mode: 'catchment', reference: { gauge: 'catchment' } })),
			await plantRun('1.82.0')
		);
	});

	it('finds the 1.80–1.84 per-unit run with a reference object, and none of the near misses', async () => {
		const r = await runCheck(client, 'unit-rain-reference-runs');
		expect(r.check).toBe('unit-rain-reference-runs');
		expect(mine(r).map((row) => row.run_id)).toEqual([hit]);
		expect(mine(r).some((row) => misses.includes(row.run_id as string))).toBe(false);
		expect(r.count).toBe(r.rows.length);
		expect(r.truncated).toBe(false);
	});

	it('answers with its id, project, engine and date only', async () => {
		const row = mine(await runCheck(client, 'unit-rain-reference-runs'))[0]!;
		expect(Object.keys(row)).toEqual(['run_id', 'project_id', 'engine_version', 'created_at']);
		expect(row).toMatchObject({ run_id: hit, project_id: projectId, engine_version: '1.82.0' });
		expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
	});
});

describe('pre-213-cap-runs (issue #523 finding I)', () => {
	let capRun: string;
	let fullRun: string;
	let capQuiet: string;
	let noneRun: string;
	let capPub: string;
	let nonePub: string;
	let outlook: string;
	let outlookPub: string;

	beforeAll(async () => {
		capRun = await plantRun('1.70.0', {}, mode('cap'));
		fullRun = await plantRun('1.70.0', {}, mode('fullAllocation'));
		capQuiet = await plantRun('1.70.0', {}, mode('cap')); // neither published nor an outlook's base
		noneRun = await plantRun('1.70.0', {}, mode('none'));
		// The compare-only run's publication, superseded; the cap run's, current.
		nonePub = (await asOwner(`INSERT INTO run_publication (project_id, run_id, superseded_at) VALUES ($1, $2, now()) RETURNING id`, [projectId, noneRun]))[0]!.id;
		capPub = (await asOwner(`INSERT INTO run_publication (project_id, run_id) VALUES ($1, $2) RETURNING id`, [projectId, capRun]))[0]!.id;
		// An outlook on the full-allocation run, published to farmers; one on the compare-only run, published and ended.
		outlook = await plantCompleteOutlook(owner.id, projectId, fullRun, []);
		const noneOutlook = await plantCompleteOutlook(owner.id, projectId, noneRun, []);
		await withUser(owner.id, async (db) => {
			const ins = `INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version)
				VALUES ($1, $2, '0', '85 %', '2099-10-01', '2100-04-30', 'x') RETURNING id`;
			const ended = (await db.query<{ id: string }>(ins, [projectId, noneOutlook])).rows[0]!.id;
			await db.query(`UPDATE outlook_publication SET ended_at = now() WHERE id = $1`, [ended]);
			outlookPub = (await db.query<{ id: string }>(ins, [projectId, outlook])).rows[0]!.id;
		});
	});

	it('finds the cap run’s publication, the full-allocation outlook and its publication, each current; nothing on a compare-only run or an unused cap run', async () => {
		const r = await runCheck(client, 'pre-213-cap-runs');
		const rows = mine(r);
		expect(rows.map((row) => [row.kind, row.id, row.run_id, row.mode, row.current]).sort()).toEqual(
			[
				['outlook_publication', outlookPub, fullRun, 'fullAllocation', true],
				['run_publication', capPub, capRun, 'cap', true],
				['seasonal_outlook', outlook, fullRun, 'fullAllocation', true]
			].sort()
		);
		const ids = rows.flatMap((row) => [row.id, row.run_id]);
		for (const miss of [capQuiet, noneRun, nonePub]) expect(ids).not.toContain(miss);
		expect(Object.keys(rows[0]!)).toEqual(['kind', 'id', 'project_id', 'run_id', 'mode', 'engine_version', 'run_created_at', 'at', 'current']);
	});

	it('a superseded publication still shows, as not current', async () => {
		await asOwner(`UPDATE run_publication SET superseded_at = now() WHERE id = $1`, [capPub]);
		const row = mine(await runCheck(client, 'pre-213-cap-runs')).find((x) => x.id === capPub);
		expect(row?.current).toBe(false);
	});
});

describe('series-pick-moves (issue #523)', () => {
	/** A series of this project (as owner: only its kind, name and site matter here). */
	const plantSeries = (kind: string, name: string, site: string | null = null) =>
		asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", site_node_id) VALUES ($1, $2, $3, 'mm', '2024-01-01', '{1}', $4)`, [
			projectId,
			kind,
			name,
			site
		]);

	beforeAll(async () => {
		// Moves: linguistic order puts 'a gauge' first, byte order 'B gauge' (B is 0x42, a 0x61).
		await plantSeries('rain_mm', 'a gauge');
		await plantSeries('rain_mm', 'B gauge');
		// Near misses: the same first name in both orders; a kind with one series.
		await plantSeries('evap_mm', 'a pan');
		await plantSeries('evap_mm', 'b pan');
		await plantSeries('temp_c', 'B only');
	});

	const hit = { project_id: '', kind: 'rain_mm', site_node_id: null, was: ['a gauge', 'B gauge'], will: ['B gauge', 'a gauge'] };

	it('finds the kind whose first series differs between linguistic and byte order, with its names in each, and none of the near misses', async () => {
		// "was" is the database's default order, which is linguistic on production (glibc's en_US.UTF-8) but
		// bytewise on the alpine (musl) test database. The same SQL with ICU's linguistic order spelled out
		// stands in for production's default here.
		const sql = CHECKS['series-pick-moves'].sql;
		const linguistic = sql.replaceAll('ORDER BY name)', 'ORDER BY name COLLATE "und-x-icu")');
		expect(linguistic.split('und-x-icu').length - 1).toBe(2);
		const asProduction = { 'series-pick-moves': { ...CHECKS['series-pick-moves'], sql: linguistic } } satisfies Record<string, ReadOnlyCheck>;
		const r = await runCheck(client, 'series-pick-moves', asProduction);
		expect(mine(r)).toEqual([{ ...hit, project_id: projectId }]);
		expect(r.truncated).toBe(false);
	});

	it('as registered, it compares the database’s own order: here a pick moves only if this database sorts linguistically', async () => {
		const [{ lingual }] = (await client.query(`SELECT 'a gauge' < 'B gauge' AS lingual`)).rows;
		const rows = mine(await runCheck(client, 'series-pick-moves'));
		expect(rows).toEqual(lingual ? [{ ...hit, project_id: projectId }] : []);
	});
});

describe('authority-grandfathered (issue #523 G5)', () => {
	let delegate: Awaited<ReturnType<typeof signUp>>;
	let other: Awaited<ReturnType<typeof signUp>>;

	beforeAll(async () => {
		delegate = await signUp('Grandfathered');
		other = await signUp('Confirmed');
		const ins = `INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'Owner', $3, $4)`;
		await asOwner(ins, [projectId, owner.id, 'authority.grandfathered', JSON.stringify({ userId: delegate.id, displayName: 'Grandfathered', via: 'grandfathered' })]);
		// Near miss: a delegate the authority confirmed itself.
		await asOwner(ins, [projectId, owner.id, 'authority.confirmed', JSON.stringify({ userId: other.id, displayName: 'Confirmed', via: 'delegate' })]);
	});

	it('finds the grandfathered delegate by id, not the confirmed one, and answers with no name or email', async () => {
		const rows = mine(await runCheck(client, 'authority-grandfathered'));
		expect(rows.map((row) => row.user_id)).toEqual([delegate.id]);
		expect(Object.keys(rows[0]!)).toEqual(['project_id', 'user_id', 'created_at']);
		expect(rows[0]!.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		expect(JSON.stringify(rows)).not.toMatch(/Grandfathered|@/);
	});
});

describe('runCheck runs read only', () => {
	// A table and a function that writes to it, in a schema of their own (dropped after), to try a write through runCheck.
	beforeAll(() =>
		asOwner(`CREATE SCHEMA IF NOT EXISTS ro_check_test;
			CREATE TABLE IF NOT EXISTS ro_check_test.t (x int);
			CREATE SEQUENCE IF NOT EXISTS ro_check_test.s;
			CREATE OR REPLACE FUNCTION ro_check_test.w() RETURNS int LANGUAGE sql SET search_path = ro_check_test AS 'INSERT INTO t VALUES (1) RETURNING x'`)
	);
	afterAll(() => asOwner('DROP SCHEMA IF EXISTS ro_check_test CASCADE'));
	const writing = (sql: string) => ({ w: { about: 'a write, which must fail', sql, columns: ['id'], orderBy: 'id' } }) satisfies Record<string, ReadOnlyCheck>;
	const rowsInT = async () => (await asOwner('SELECT count(*)::int AS n FROM ro_check_test.t'))[0]!.n as number;

	it('a check whose query writes (through a function) fails with 25006 and writes nothing; the connection is usable afterwards', async () => {
		await expect(runCheck(client, 'w', writing('SELECT ro_check_test.w()::text AS id'))).rejects.toMatchObject({ code: '25006' });
		expect(await rowsInT()).toBe(0);
		expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
	});

	it('nextval is refused too (25006)', async () => {
		await expect(runCheck(client, 'w', writing(`SELECT nextval('ro_check_test.s')::text AS id`))).rejects.toMatchObject({ code: '25006' });
	});

	it('positive control: the same function writes outside a check', async () => {
		await asOwner('SELECT ro_check_test.w()');
		expect(await rowsInT()).toBe(1);
	});

	it('every registered check runs on an empty answer without error (the SQL is valid against the schema)', async () => {
		for (const name of Object.keys(CHECKS) as (keyof typeof CHECKS)[]) {
			const r = await runCheck(client, name);
			expect(r.count).toBeGreaterThanOrEqual(mine(r).length);
		}
	});
});
