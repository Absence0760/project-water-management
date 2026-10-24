// 239_rain_stations (issue #553): a rainfall station (a rain_catchment_mm series
// with no site) carries its own MAP, its source and optionally its place, and
// the migration copies each project's settings.unitRain gauge MAP onto the
// station a run reads (the first by the name's bytes among the series with no
// site, runs/execute.ts loadLiveInput). Every refusal has its positive control.
// Needs Postgres (pnpm dev:db:up). Synthetic values only.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

const MIGRATION = readFileSync(new URL('../../migrations/239_rain_stations.sql', import.meta.url), 'utf8');
const MARK = '-- data step:';
/** The migration's data step: the copy from settings onto the station, after its columns and CHECKs. */
const COPY = MIGRATION.slice(MIGRATION.indexOf(MARK));

type User = Awaited<ReturnType<typeof signUp>>;
const VALUES = [1, 0, 2.5];

async function newProject(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}

describe('239_rain_stations', () => {
	let owner: User;
	let pid: string;
	let unitId: string;
	let client: pg.Client;

	const insert = async (cols: Record<string, unknown>, project = pid) => {
		const row = { project_id: project, kind: 'rain_catchment_mm', name: '', unit: 'mm', start_date: '2020-01-01', values: VALUES, ...cols };
		const keys = Object.keys(row);
		const r = await client.query<{ id: string }>(
			`INSERT INTO time_series (${keys.map((k) => (k === 'values' ? '"values"' : k)).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
			Object.values(row)
		);
		return r.rows[0]!.id;
	};
	/** Run `fn` in a savepoint and roll it back, returning the error code it raised (or null). */
	const attempt = async (fn: () => Promise<unknown>): Promise<string | null> => {
		await client.query('SAVEPOINT s');
		try {
			await fn();
			return null;
		} catch (e) {
			return (e as { code?: string; constraint?: string }).constraint ?? (e as { code?: string }).code ?? 'error';
		} finally {
			await client.query('ROLLBACK TO SAVEPOINT s');
		}
	};

	beforeAll(async () => {
		owner = await signUp('Stations');
		pid = await newProject(owner, 'Stations');
		const outlet = node('Outlet', null);
		const unit = node('Unit A', outlet.id);
		unitId = unit.id;
		expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [outlet, unit], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		await client.query('BEGIN');
	});

	afterAll(async () => {
		await client.query('ROLLBACK');
		await client.end();
	});

	it('the data step is the migration’s last statement, after its columns and CHECKs', () => {
		expect(MIGRATION.indexOf(MARK)).toBeGreaterThan(MIGRATION.indexOf('ADD CONSTRAINT time_series_station_only'));
		expect(COPY.trim().startsWith(MARK)).toBe(true);
		expect(COPY.match(/;/g)).toHaveLength(1);
	});

	it('a station takes a MAP with its source, and coordinates', async () => {
		expect(await attempt(() => insert({ name: 'Station full', station_map_mm: 745, station_map_source: 'Gauge record 1990-2020', station_lat: -33.9, station_lon: 19.1 }))).toBeNull();
		expect(await attempt(() => insert({ name: 'Station bounds', station_map_mm: 1, station_map_source: 'x', station_lat: -90, station_lon: 180 }))).toBeNull();
		expect(await attempt(() => insert({ name: 'Station top', station_map_mm: 12000, station_map_source: 's'.repeat(600), station_lat: 90, station_lon: -180 }))).toBeNull();
		// Coordinates without a MAP, and a source without a MAP (as 209's node.map_source), are fine.
		expect(await attempt(() => insert({ name: 'Station place', station_lat: 0, station_lon: 0 }))).toBeNull();
		expect(await attempt(() => insert({ name: 'Station source', station_map_source: 'pending' }))).toBeNull();
		// And none at all: every series before 239.
		expect(await attempt(() => insert({ name: 'Station none' }))).toBeNull();
	});

	it('refuses a MAP out of bounds, a MAP without a usable source, and half a place', async () => {
		expect(await attempt(() => insert({ name: 'm0', station_map_mm: 0.5, station_map_source: 'x' }))).toBe('time_series_station_map_mm_range');
		expect(await attempt(() => insert({ name: 'm1', station_map_mm: 12000.5, station_map_source: 'x' }))).toBe('time_series_station_map_mm_range');
		expect(await attempt(() => insert({ name: 'm2', station_map_mm: 700 }))).toBe('time_series_station_map_needs_source');
		expect(await attempt(() => insert({ name: 'm3', station_map_mm: 700, station_map_source: '   ' }))).toBe('time_series_station_map_source_text');
		expect(await attempt(() => insert({ name: 'm4', station_map_mm: 700, station_map_source: '' }))).toBe('time_series_station_map_source_text');
		expect(await attempt(() => insert({ name: 'm5', station_map_mm: 700, station_map_source: 's'.repeat(601) }))).toBe('time_series_station_map_source_text');
		expect(await attempt(() => insert({ name: 'p0', station_lat: -90.1, station_lon: 0 }))).toBe('time_series_station_lat_range');
		expect(await attempt(() => insert({ name: 'p1', station_lat: 0, station_lon: 180.1 }))).toBe('time_series_station_lon_range');
		expect(await attempt(() => insert({ name: 'p2', station_lat: -33 }))).toBe('time_series_station_lat_lon_together');
		expect(await attempt(() => insert({ name: 'p3', station_lon: 19 }))).toBe('time_series_station_lat_lon_together');
	});

	it('refuses station columns on any series but a catchment rain series with no site', async () => {
		const map = { station_map_mm: 700, station_map_source: 'x' };
		for (const kind of ['rain_chirps_mm', 'flow_observed_m3s', 'evap_apan_mm']) {
			expect(await attempt(() => insert({ name: `k ${kind}`, kind, unit: kind.endsWith('m3s') ? 'm3/s' : 'mm', ...map })), kind).toBe('time_series_station_only');
			expect(await attempt(() => insert({ name: `p ${kind}`, kind, unit: kind.endsWith('m3s') ? 'm3/s' : 'mm', station_lat: 0, station_lon: 0 })), kind).toBe('time_series_station_only');
		}
		// A unit's own gauge (209) has none; the same series with no site may (positive control).
		expect(await attempt(() => insert({ name: 'Unit gauge', site_node_id: unitId, ...map }))).toBe('time_series_station_only');
		expect(await attempt(() => insert({ name: 'Unit gauge', site_node_id: unitId }))).toBeNull();
		expect(await attempt(() => insert({ name: 'Unit gauge', ...map }))).toBeNull();
		// Nor can a station be sited, or change kind, while it keeps its MAP.
		const id = await insert({ name: 'Moving station', ...map });
		expect(await attempt(() => client.query('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [id, unitId]))).toBe('time_series_station_only');
		expect(await attempt(() => client.query(`UPDATE time_series SET kind = 'rain_chirps_mm' WHERE id = $1`, [id]))).toBe('time_series_station_only');
		expect(await attempt(() => client.query('UPDATE time_series SET site_node_id = $2, station_map_mm = NULL, station_map_source = NULL WHERE id = $1', [id, unitId]))).toBeNull();
	});

	it('water_app may write and read the station columns under RLS (001’s table grant, the editor policies)', async () => {
		const other = await newProject(owner, 'Stations RLS');
		const [row] = (await asOwner(`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values") VALUES ($1, 'rain_catchment_mm', 'RLS station', 'mm', '2020-01-01', $2) RETURNING id`, [other, VALUES])) as { id: string }[];
		const read = await withUser(owner.id, async (db) => {
			await db.query(`UPDATE time_series SET station_map_mm = 812.5, station_map_source = 'Synthetic study', station_lat = -34, station_lon = 20 WHERE id = $1`, [row!.id]);
			return (await db.query('SELECT station_map_mm, station_map_source, station_lat, station_lon FROM time_series WHERE id = $1', [row!.id])).rows;
		});
		expect(read).toEqual([{ station_map_mm: 812.5, station_map_source: 'Synthetic study', station_lat: -34, station_lon: 20 }]);
		// Negative: a stranger's RLS sees no row, so neither reads nor writes it.
		const stranger = await signUp('StationsStranger');
		const seen = await withUser(stranger.id, async (db) => {
			const u = await db.query(`UPDATE time_series SET station_map_mm = 100, station_map_source = 'x' WHERE id = $1`, [row!.id]);
			const s = await db.query('SELECT 1 FROM time_series WHERE id = $1', [row!.id]);
			return { updated: u.rowCount, selected: s.rowCount };
		});
		expect(seen).toEqual({ updated: 0, selected: 0 });
		expect(await asOwner('SELECT station_map_mm FROM time_series WHERE id = $1', [row!.id])).toEqual([{ station_map_mm: 812.5 }]);
	});

	it('copies settings.unitRain’s gauge MAP onto the station a run reads, and leaves the settings and everything else alone', async () => {
		const project = async (name: string, unitRain: unknown) => {
			const id = await newProject(owner, name);
			await client.query(`UPDATE project SET settings = settings || jsonb_build_object('unitRain', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(unitRain)]);
			return id;
		};
		const gauge = { mode: 'perUnit', gaugeMapMm: 745.25, gaugeMapSource: 'Synthetic gauge 1990-2020' };
		// Several stations: the run reads the first by the name's bytes ("Z" before "a", ASCII before "Ä"); other kinds don't count.
		const several = await project('Copy several', gauge);
		const first = await insert({ name: 'Zulu gauge' }, several);
		const later = await insert({ name: 'alpha gauge' }, several);
		const accent = await insert({ name: 'Ärea gauge' }, several);
		const chirps = await insert({ name: '0 chirps', kind: 'rain_chirps_mm' }, several);
		// A unit's own gauge (209) sorts first but has a site, so the outlet's station is the one read.
		const withSite = await newProject(owner, 'Copy with a sited gauge');
		const outlet = node('Outlet', null);
		const unit = node('Unit', outlet.id);
		expect((await owner.call('PUT', `/projects/${withSite}/model`, { nodes: [outlet, unit], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		await client.query(`UPDATE project SET settings = settings || jsonb_build_object('unitRain', $2::jsonb) WHERE id = $1`, [withSite, JSON.stringify({ ...gauge, gaugeMapMm: 900 })]);
		const unitGauge = await insert({ name: '0 unit gauge', site_node_id: unit.id }, withSite);
		const outletGauge = await insert({ name: 'Outlet gauge' }, withSite);
		// Copied whatever the mode (the setting was stored; the run builder decides what reads it).
		const catchmentMode = await project('Copy catchment mode', { mode: 'catchment', gaugeMapMm: 600, gaugeMapSource: 'Synthetic' });
		const catchmentModeGauge = await insert({ name: 'Gauge' }, catchmentMode);
		// Nothing to copy: no gauge MAP, an unusable one (as the engine's mapMmError refuses), or no station.
		const none = await project('Copy none', { mode: 'perUnit' });
		const noneGauge = await insert({ name: 'Gauge' }, none);
		const bad = [
			{ mode: 'perUnit', gaugeMapMm: 0, gaugeMapSource: 'x' },
			{ mode: 'perUnit', gaugeMapMm: 12001, gaugeMapSource: 'x' },
			{ mode: 'perUnit', gaugeMapMm: 700 },
			{ mode: 'perUnit', gaugeMapMm: 700, gaugeMapSource: '  ' },
			{ mode: 'perUnit', gaugeMapMm: 700, gaugeMapSource: 's'.repeat(601) },
			{ mode: 'perUnit', gaugeMapMm: '700', gaugeMapSource: 'x' },
			{ mode: 'perUnit', gaugeMapMm: null, gaugeMapSource: 'x' }
		];
		const badGauges: string[] = [];
		for (const [i, u] of bad.entries()) badGauges.push(await insert({ name: 'Gauge' }, await project(`Copy bad ${i}`, u)));
		const noStation = await project('Copy no station', gauge);
		const noStationChirps = await insert({ name: 'CHIRPS', kind: 'rain_chirps_mm' }, noStation);
		// A station that already has its own MAP keeps it.
		const kept = await project('Copy kept', gauge);
		const keptGauge = await insert({ name: 'Gauge', station_map_mm: 500, station_map_source: 'Own' }, kept);
		const settingsBefore = await client.query('SELECT id, settings FROM project ORDER BY id');

		await client.query(COPY);

		const map = async (id: string) =>
			(await client.query<{ m: number | null; s: string | null }>('SELECT station_map_mm AS m, station_map_source AS s FROM time_series WHERE id = $1', [id])).rows[0];
		expect(await map(first)).toEqual({ m: 745.25, s: 'Synthetic gauge 1990-2020' });
		for (const id of [later, accent, chirps]) expect(await map(id)).toEqual({ m: null, s: null });
		expect(await map(outletGauge)).toEqual({ m: 900, s: 'Synthetic gauge 1990-2020' });
		expect(await map(unitGauge)).toEqual({ m: null, s: null });
		expect(await map(catchmentModeGauge)).toEqual({ m: 600, s: 'Synthetic' });
		for (const id of [noneGauge, ...badGauges, noStationChirps]) expect(await map(id)).toEqual({ m: null, s: null });
		expect(await map(keptGauge)).toEqual({ m: 500, s: 'Own' });
		// The settings JSON is untouched (expand only).
		expect((await client.query('SELECT id, settings FROM project ORDER BY id')).rows).toEqual(settingsBefore.rows);

		// Run again: nothing changes (each station already has its MAP).
		await client.query(COPY);
		expect(await map(first)).toEqual({ m: 745.25, s: 'Synthetic gauge 1990-2020' });
	});

	it('picks the same station as a run among several by the name’s bytes', async () => {
		const id = await newProject(owner, 'Copy order');
		await client.query(`UPDATE project SET settings = settings || '{"unitRain":{"mode":"perUnit","gaugeMapMm":701,"gaugeMapSource":"Synthetic"}}'::jsonb WHERE id = $1`, [id]);
		const names = ['average gauge', 'RAIN-B logger', 'Ärea', 'Zeta'];
		const ids: Record<string, string> = {};
		for (const n of names) ids[n] = await insert({ name: n }, id);
		await client.query(COPY);
		// Byte order: "RAIN-B logger" < "Zeta" < "average gauge" < "Ärea" (docs/data-model.md § Which series a run reads).
		const { rows } = await client.query<{ name: string }>('SELECT name FROM time_series WHERE project_id = $1 AND station_map_mm IS NOT NULL', [id]);
		expect(rows.map((r) => r.name)).toEqual(['RAIN-B logger']);
		// The run's own query, read the same way: its pick is the row the copy chose.
		const { rows: pick } = await client.query<{ id: string }>(
			`SELECT DISTINCT ON (site_node_id, kind) id FROM time_series t WHERE project_id = $1 AND kind = 'rain_catchment_mm' ORDER BY site_node_id NULLS FIRST, kind, name COLLATE "C"`,
			[id]
		);
		expect(pick[0]!.id).toBe(ids['RAIN-B logger']);
	});
});
