// Migration 289 (issue #659): engine 1.110.0's calibration locations. Every
// project's object settings without a boolean calibrateAtOutlet gets the shape
// the engine's read-time conversion (normalizeCalibrationLocations) gives it,
// so a project's runs and fits stay as they were: each case here is asserted
// equal to the API's locatedSettings (the engine's conversion, plus the
// regional prior's target) on the same settings, network and records. And
// run_fit_engine_version reads a run's headline fit, which the errata sweep,
// the verify lookup and the specialist's pack now call. This builds a
// throwaway database at the schema before 289, stores settings the old way,
// applies 289 and checks.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locatedSettings, type LocationNode } from '../projects/calibrationSite.js';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const FILE = '289_calibration_locations.sql';
const dbName = `water_test_m289_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// INNER: calibrated at the inner gauge UP, with a fit, rows at, above, below and beside it, and prior starts.
// MESSY: at UP with a reversed window, partial GR4J, no quality flags, no zone list, no record at the outlet.
// BAD: at UP with an X1 out of range. OUTLET / NOREC: the outlet, with and without an outlet record.
// FARM / GONE / AT_OUTLET: a site that is a land unit, no node, or the outlet itself. ODD / LIST: not an object.
// DONE: already in the new shape. NOT_BOOL: calibrateAtOutlet that isn't true or false (read as before).
const [INNER, MESSY, BAD, OUTLET, NOREC, FARM, GONE, AT_OUTLET, ODD, LIST, DONE, NOT_BOOL] = Array.from({ length: 12 }, (_, i) => id(i + 1));
const PROJECTS = [INNER, MESSY, BAD, OUTLET, NOREC, FARM, GONE, AT_OUTLET, ODD, LIST, DONE, NOT_BOOL];
/** Projects stored without an outlet record. */
const NO_RECORD = new Set([MESSY, NOREC]);

// Each project's network, its node ids offset by 100 × its index: the land unit U drains through TOP → UP → MID → O (the
// outlet), V through SIDE → MID, and W straight to O.
const nodeIds = (p: string) => {
	const base = 100 * (PROJECTS.indexOf(p) + 1);
	return { O: id(base + 1), MID: id(base + 2), UP: id(base + 3), TOP: id(base + 4), SIDE: id(base + 5), U: id(base + 6), V: id(base + 7), W: id(base + 8) };
};
const FIT = { model: 'gr4j', fittedAt: '2026-10-01T00:00:00.000Z', engineVersion: '1.108.0', params: { x1: 512, x2: 0, x3: 80, x4: 2.1 }, free: ['x1', 'x3', 'x4'] };
const row = (nodeId: string, enabled: boolean, extra: Record<string, unknown> = {}) => ({
	nodeId,
	enabled,
	calibrationStart: null,
	calibrationEnd: null,
	calibrationFlowKind: null,
	calibrationExclusions: [],
	qualityFlags: null,
	gr4j: null,
	fitRecord: null,
	...extra
});
const prior = (zoneNodeId: string | null) => ({ appliedAt: '2026-10-02T00:00:00.000Z', params: { x1: 400, x2: 0, x3: 90, x4: 1.7 }, provenance: { target: { zoneNodeId, units: null } } });

function settingsOf(p: string): unknown {
	const n = nodeIds(p);
	const other = { lakeEvapFactor: 0.7, flowGapFill: { flow_observed_m3s: null } };
	switch (p) {
		case INNER:
			return {
				...other,
				calibrationSiteNodeId: n.UP,
				calibrationStart: '2001-10-01',
				calibrationEnd: '2010-09-30',
				calibrationFlowKind: 'flow_logger_m3s',
				calibrationExclusions: [{ waterYear: 2004, reason: 'weir rebuilt' }],
				qualityFlags: { suspect: 'include', zeroFlowMonths: [3, 1], aboveRating: 'censor', ratings: {} },
				gr4j: { x1: 512, x2: -1, x3: 80, x4: 2.1, warmupDays: 365 },
				fitRecord: FIT,
				calibrationZones: [
					row(n.UP, false, { gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }),
					row(n.MID, true, { gr4j: { x1: 700, x2: 0, x3: 100, x4: 2 } }),
					row(n.TOP, true),
					row(n.SIDE, true, { calibrationStart: '2003-10-01' })
				],
				gr4jPrior: [prior(null), prior(n.SIDE)]
			};
		case MESSY:
			return { calibrationSiteNodeId: n.UP, calibrationStart: '2010-09-30', calibrationEnd: '2001-10-01', gr4j: { x1: 500 } };
		case BAD:
			return { calibrationSiteNodeId: n.UP, calibrationStart: '2020-13-01', calibrationEnd: '2010-09-30', gr4j: { x1: 5000, x2: 0, x3: 80, x4: 2.1 }, calibrationZones: [] };
		case OUTLET:
			return { ...other, calibrationSiteNodeId: null, gr4j: { x1: 512, x2: 0, x3: 80, x4: 2.1 }, fitRecord: FIT, calibrationZones: [row(n.SIDE, true)], gr4jPrior: [prior(null)] };
		case NOREC:
			return { ...other, calibrationZones: [row(n.UP, true)] };
		case FARM:
			return { calibrationSiteNodeId: n.U, fitRecord: FIT };
		case GONE:
			return { calibrationSiteNodeId: id(99_999), calibrationZones: [] };
		case AT_OUTLET:
			return { calibrationSiteNodeId: n.O };
		case ODD:
			return 'not settings';
		case LIST:
			return [1, 2];
		case DONE:
			return { calibrateAtOutlet: false, calibrationRest: 'nearest', calibrationSiteNodeId: n.UP, fitRecord: FIT };
		case NOT_BOOL:
			return { calibrateAtOutlet: 'yes', calibrationSiteNodeId: n.TOP };
	}
	throw new Error(p);
}

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '289')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	for (const [i, p] of PROJECTS.entries()) {
		await db.query(`INSERT INTO project (id, name, created_by, settings) VALUES ($1, $2, $3, $4)`, [p, `P${i}`, user, JSON.stringify(settingsOf(p))]);
		const n = nodeIds(p);
		const node = (nid: string, name: string, kind: string, down: string | null, area = 0) =>
			db.query(`INSERT INTO node (id, project_id, name, kind, downstream_node_id, area_km2) VALUES ($1, $2, $3, $4, $5, $6)`, [nid, p, name, kind, down, area]);
		await node(n.O, 'Outlet', 'gauge', null);
		await node(n.MID, 'Middle weir', 'gauge', n.O);
		await node(n.UP, 'Upper weir', 'gauge', n.MID);
		await node(n.TOP, 'Top weir', 'gauge', n.UP);
		await node(n.SIDE, 'Side weir', 'gauge', n.MID);
		await node(n.U, 'Unit U', 'farm', n.TOP, 2);
		await node(n.V, 'Unit V', 'farm', n.SIDE, 3);
		await node(n.W, 'Unit W', 'farm', n.O, 1);
		const series = (kind: string, site: string | null) =>
			db.query(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", site_node_id) VALUES ($1, $2, $3, 'm³/s', '2001-01-01', '{1,2}', $4)`, [
				p,
				kind,
				site ?? '',
				site
			]);
		// Every project has a gauge's record (which is no outlet record) and rain; all but NO_RECORD the outlet's.
		await series('flow_logger_m3s', n.UP);
		await db.query(`INSERT INTO time_series (project_id, kind, unit, start_date, "values") VALUES ($1, 'rain_catchment_mm', 'mm', '2001-01-01', '{1,2}')`, [p]);
		if (!NO_RECORD.has(p)) await series('flow_observed_m3s', null);
	}
	await db.query(await readFile(join(DIR, FILE), 'utf8'));
}, 120_000);

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const storedOf = async (p: string) => (await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [p])).rows[0]!.settings;
const nodesOf = async (p: string): Promise<LocationNode[]> =>
	(
		await db.query<{ id: string; name: string; kind: LocationNode['kind']; down: string | null; area: number }>(
			'SELECT id, name, kind, downstream_node_id AS down, area_km2 AS area FROM node WHERE project_id = $1',
			[p]
		)
	).rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, downstreamNodeId: r.down, areaKm2: r.area }));
/** What the engine's read-time conversion (and the API's, locatedSettings) gives the settings as they were stored. */
const expected = async (p: string) => locatedSettings(settingsOf(p), await nodesOf(p), !NO_RECORD.has(p));

describe('migration 289: calibration locations', () => {
	it('moves an inner site into its ticked row, with its fit, unticking the rows at or below it, as the engine reads it', async () => {
		const n = nodeIds(INNER);
		const s = (await storedOf(INNER)) as Record<string, unknown>;
		expect(s).toEqual(await expected(INNER));
		// What that is, spelled out (positive control: the comparison isn't of two no-ops).
		expect(s).toMatchObject({ calibrateAtOutlet: false, calibrationRest: 'headline', calibrationSiteNodeId: n.UP, fitRecord: null });
		expect(s.calibrationZones).toEqual([
			row(n.MID, false, { gr4j: { x1: 700, x2: 0, x3: 100, x4: 2 } }),
			row(n.TOP, true),
			row(n.SIDE, true, { calibrationStart: '2003-10-01' }),
			{
				nodeId: n.UP,
				enabled: true,
				calibrationStart: '2001-10-01',
				calibrationEnd: '2010-09-30',
				calibrationFlowKind: 'flow_logger_m3s',
				calibrationExclusions: [{ waterYear: 2004, reason: 'weir rebuilt' }],
				qualityFlags: { suspect: 'include', zeroFlowMonths: [1, 3] },
				gr4j: { x1: 512, x2: -1, x3: 80, x4: 2.1 },
				fitRecord: FIT
			}
		]);
		// The outlet record's settings stay on the top level.
		expect(s).toMatchObject({ calibrationStart: '2001-10-01', calibrationFlowKind: 'flow_logger_m3s', lakeEvapFactor: 0.7 });
		// The site zone's prior start is the gauge's now; another location's is left.
		expect(s.gr4jPrior).toEqual([prior(n.UP), prior(n.SIDE)]);
	});

	it('reads the site’s values as the engine does: a reversed window is the whole record, a day that can’t be none, GR4J over its defaults, out of range none', async () => {
		const messy = (await storedOf(MESSY)) as { calibrationZones: unknown[] };
		expect(messy).toEqual(await expected(MESSY));
		expect(messy.calibrationZones).toEqual([
			row(nodeIds(MESSY).UP, true, { qualityFlags: { suspect: 'exclude' }, gr4j: { x1: 500, x2: 0, x3: 90, x4: 1.7 } })
		]);
		const bad = (await storedOf(BAD)) as { calibrationZones: unknown[] };
		expect(bad).toEqual(await expected(BAD));
		expect(bad.calibrationZones).toEqual([row(nodeIds(BAD).UP, true, { calibrationEnd: '2010-09-30', qualityFlags: { suspect: 'exclude' } })]);
	});

	it('ticks the outlet when it has a record, and gives the leftover units the catchment parameters when it has none', async () => {
		const outlet = await storedOf(OUTLET);
		expect(outlet).toEqual(await expected(OUTLET));
		expect(outlet).toMatchObject({ calibrateAtOutlet: true, calibrationRest: 'headline', calibrationSiteNodeId: null, fitRecord: FIT });
		const norec = await storedOf(NOREC);
		expect(norec).toEqual(await expected(NOREC));
		expect(norec).toMatchObject({ calibrateAtOutlet: false, calibrationRest: 'default', calibrationSiteNodeId: null });
	});

	it('reads a site that is a land unit, no node or the outlet as the outlet, as engines before scored it', async () => {
		for (const p of [FARM, GONE, AT_OUTLET]) {
			const s = await storedOf(p);
			expect(s, p).toEqual(await expected(p));
			expect(s, p).toMatchObject({ calibrateAtOutlet: true, calibrationRest: 'headline', calibrationSiteNodeId: null });
		}
		expect(await storedOf(FARM)).toMatchObject({ fitRecord: FIT });
	});

	it('converts calibrateAtOutlet that is not true or false, and leaves the new shape and non-objects alone', async () => {
		expect(await storedOf(NOT_BOOL)).toEqual(await expected(NOT_BOOL));
		expect(await storedOf(NOT_BOOL)).toMatchObject({ calibrateAtOutlet: false, calibrationSiteNodeId: nodeIds(NOT_BOOL).TOP });
		expect(await storedOf(DONE)).toEqual(settingsOf(DONE));
		expect(await storedOf(ODD)).toEqual(settingsOf(ODD));
		expect(await storedOf(LIST)).toEqual(settingsOf(LIST));
	});

	it('is idempotent: a second run changes nothing', async () => {
		const before = (await db.query('SELECT id, settings FROM project ORDER BY id')).rows;
		await db.query(await readFile(join(DIR, FILE), 'utf8').then((sql) => sql.split('-- 2. The engine of the fit')[0]!));
		expect((await db.query('SELECT id, settings FROM project ORDER BY id')).rows).toEqual(before);
	});
});

describe('run_fit_engine_version: the engine of the fit a run’s headline parameters came from', () => {
	const fit = async (inputs: unknown, summary: unknown) =>
		(await db.query<{ v: string | null }>('SELECT run_fit_engine_version($1::jsonb, $2::jsonb) AS v', [JSON.stringify(inputs), JSON.stringify(summary)])).rows[0]!.v;
	const G = id(7);
	const settings = { fitRecord: { engineVersion: '1.100.0' }, calibrationZones: [{ nodeId: G, fitRecord: { engineVersion: '1.109.0' } }] };
	const zones = (kind: 'gauge' | 'outlet', nodeId: string | null) => ({ unitRain: { zones: [{ nodeId: G, kind: 'gauge' }, { nodeId, kind, headline: true }] } });

	it('reads a headline gauge’s row, and the top level for the outlet’s location', async () => {
		expect(await fit({ settings }, zones('gauge', G))).toBe('1.109.0');
		expect(await fit({ settings }, zones('outlet', null))).toBe('1.100.0');
	});

	it('reads none for a headline gauge whose row has no fit, though the top level has one', async () => {
		expect(await fit({ settings: { ...settings, calibrationZones: [{ nodeId: G, fitRecord: null }] } }, zones('gauge', G))).toBeNull();
	});

	it('is what the errata sweep, the verify lookup and the specialist’s pack read a run’s fit by', async () => {
		const { rows } = await db.query<{ name: string; src: string }>(
			`SELECT proname AS name, prosrc AS src FROM pg_proc WHERE proname IN ('app_erratum_sweep', 'app_verify_pack', 'app_specialist_pack') ORDER BY proname`
		);
		expect(rows.map((r) => r.name)).toEqual(['app_erratum_sweep', 'app_specialist_pack', 'app_verify_pack']);
		for (const r of rows) {
			expect(r.src, r.name).toContain('run_fit_engine_version(r.inputs, r.summary)');
			expect(r.src, r.name).not.toContain("'fitRecord'");
		}
	});

	it('reads the top level for a run with no gauge location, or from before engine 1.110.0', async () => {
		expect(await fit({ settings }, {})).toBe('1.100.0');
		expect(await fit({ settings }, { unitRain: { zones: [{ nodeId: G, name: 'G', units: [] }] } })).toBe('1.100.0');
		expect(await fit({ settings: {} }, { unitRain: { zones: 'not a list' } })).toBeNull();
		expect(await fit({}, {})).toBeNull();
	});
});
