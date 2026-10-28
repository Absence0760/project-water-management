// Rainfall stations into a run's input, through the API (issue #553, engine ≥
// 1.91.0; runs/stationInput.ts, projects/rainStationSettings.ts): an invented
// example catchment with two stations beside its catchment rain series, one
// placed on a cached CHIRPS cell. Checks that a project without
// settings.rainStations gets exactly the input it had; that a save is checked
// against the project (stations, land units, shapes; a stranger and a viewer
// can't save it, an editor can: the positive control); that with it the input
// carries every station's record, its details (isCatchmentGauge on the series
// the run reads as rain_catchment_mm) and the CHIRPS at a placed station's
// cached cell; that a run stores them in its snapshot, reproduces from it,
// and a pack bundle's input carries them; that a copy, an export + import and
// a restore keep the setting naming the stations; and that deleting a station
// the setting names doesn't break the input or the run.
import { bundleRunInput, stationChirpsSeriesKey, stationSeriesKey, type ModelInput } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';
import { importProjectData } from '../../scripts/import-project.js';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { chcCell } from '../feeds/cellCache.js';
import { loadBundleRun } from '../evidence/bundle.js';
import { loadRunInput } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const small = buildExamples({ fit: false })[1]!;
/** Placed on a cell this file caches (invented coordinates, in no example's cover). */
const PLACE = { lat: -12.3125, lon: 141.4625 };
const CACHE_YEAR = 2012;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let pid: string;
let gauge: string;
let ridge: string;
let vlei: string;
let flow: string;
let units: string[];
let outlet: string;

async function call(u: User, method: string, path: string, body?: unknown, status = 200) {
	const r = await u.call(method, path, body);
	expect(r.status, `${method} ${path} → ${JSON.stringify(r.body)}`).toBe(status);
	return r.body;
}
const input = async (p = pid) => (await call(owner, 'GET', `/projects/${p}/model-input`)).input as ModelInput;
const save = (u: User, rainStations: unknown, p = pid) => u.call('PATCH', `/projects/${p}`, { settings: { rainStations } });
const errorOf = (r: { body: { error?: string; details?: { message: string }[] } }) => [r.body.error, ...(r.body.details ?? []).map((d) => d.message)].join(' | ');

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('StationsOwner'), signUp('StationsEditor'), signUp('StationsViewer'), signUp('StationsStranger')]);
	pid = await importProjectData(small, owner.email);
	await call(owner, 'POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' }, 201);
	await call(owner, 'POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' }, 201);
	const series = (await call(owner, 'GET', `/projects/${pid}/series`)).series as { id: string; kind: string; name: string }[];
	gauge = series.find((s) => s.kind === 'rain_catchment_mm')!.id;
	flow = series.find((s) => s.kind === 'flow_observed_m3s')!.id;
	const days = Array.from({ length: 3 * 366 }, (_, t) => (t % 4 === 0 ? 6 + (t % 13) : 0));
	ridge = (await call(owner, 'PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', name: 'Station Ridge', unit: 'mm', startDate: '2011-01-01', values: days, station: { mapMm: 820, mapSource: 'the ridge gauge’s record, 1991–2020', ...PLACE } })).id;
	vlei = (await call(owner, 'PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', name: 'Station Vlei', unit: 'mm', startDate: '2011-01-01', values: days.map((v) => v / 2), station: { mapMm: 510, mapSource: 'the vlei gauge’s record' } })).id;
	const nodes = (await call(owner, 'GET', `/projects/${pid}/model`)).nodes as { id: string; kind: string; areaKm2: number; downstreamNodeId: string | null }[];
	units = nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0).map((n) => n.id);
	outlet = nodes.find((n) => n.downstreamNodeId === null)!.id;
	expect(units.length).toBeGreaterThanOrEqual(2);
	// One year of the placed station's cell in the cache (the test feeds' origin), as a feed covering it would have left it.
	const cell = chcCell(PLACE.lat, PLACE.lon);
	await asOwner(
		`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
		 VALUES ('fixtures', 'rnl', $1, $2, $3, (SELECT array_agg((i % 7)::real ORDER BY i) FROM generate_series(1, 366) i), array_fill(true, ARRAY[366]), make_date($3, 12, 31))
		 ON CONFLICT (origin, product, row_idx, col_idx, year) DO UPDATE SET vals = EXCLUDED.vals, final = EXCLUDED.final, final_through = EXCLUDED.final_through`,
		[cell.row, cell.col, CACHE_YEAR]
	);
});

afterAll(async () => {
	const cell = chcCell(PLACE.lat, PLACE.lon);
	await asOwner(`DELETE FROM chirps_cell_year WHERE origin = 'fixtures' AND product = 'rnl' AND row_idx = $1 AND col_idx = $2`, [cell.row, cell.col]);
});

describe('rainfall stations in a run’s input', () => {
	let before: ModelInput;

	it('without settings.rainStations, the input has no stations and no station series (the input as before)', async () => {
		before = await input();
		expect(before).not.toHaveProperty('stations');
		expect(Object.keys(before.series).filter((k) => k.includes('#'))).toEqual([]);
		// The positive control: the catchment rain series is there, read as before.
		expect(before.series.rain_catchment_mm).toBeDefined();
		// Switched on with nothing assigned, and off again (null): the same input but for the setting itself.
		expect((await save(owner, { units: {}, catchment: null })).status).toBe(200);
		expect(await input()).toStrictEqual({ ...before, settings: { ...before.settings, rainStations: { units: {}, catchment: null } } });
		expect((await save(owner, null)).status).toBe(200);
		expect(await input()).toStrictEqual({ ...before, settings: { ...before.settings, rainStations: null } });
	});

	it('refuses a save naming what isn’t this project’s station or land unit, or a bad shape, in plain words', async () => {
		const refused = async (rs: unknown, pattern: RegExp) => {
			const r = await save(owner, rs);
			expect(r.status, JSON.stringify(rs)).toBe(400);
			expect(errorOf(r)).toMatch(pattern);
		};
		await refused({ catchment: { stationId: crypto.randomUUID() } }, /the catchment’s station is not a rainfall station of this project/);
		// A flow record is a series of the project, but no station.
		await refused({ units: { [units[0]!]: { stationId: flow } } }, /a unit’s station is not a rainfall station of this project/);
		await refused({ units: { [units[0]!]: { stationId: ridge, correctAgainst: flow } } }, /the station correcting a unit’s CHIRPS is not a rainfall station/);
		// The outlet has no land; an unknown node isn't one at all.
		await refused({ units: { [outlet]: { stationId: ridge } } }, /a unit given a station is not a land unit of this project/);
		await refused({ sites: { [vlei]: { unitId: crypto.randomUUID() } } }, /the unit a station stands in is not a land unit/);
		// Any rain record's unreliable periods (engine ≥ 1.102.0, issue #611), but no other series' and nothing unknown.
		await refused({ unreliable: { [crypto.randomUUID()]: [] } }, /a rain record’s unreliable periods is not a rain record of this project/);
		await refused({ unreliable: { [flow]: [] } }, /a rain record’s unreliable periods is not a rain record of this project/);
		await refused({ unreliable: { [ridge]: [['2012-03-01', '2012-02-01']] } }, /ends before it starts/);
		await refused({ catchmentMapMm: 700 }, /the catchment’s a MAP needs its source/);
		await refused({ catchmentMapMm: 50_000, catchmentMapSource: 'x' }, /./);
		await refused({ pinnedFactors: { [ridge]: Array(12).fill(1) } }, /pinned factors are the engine’s own/);
		// Another project's station: refused here, though it is a station (RLS keeps it out of sight anyway).
		const other = await importProjectData(small, stranger.email);
		const theirs = ((await call(stranger, 'GET', `/projects/${other}/series`)).series as { id: string; kind: string }[]).find((s) => s.kind === 'rain_catchment_mm')!.id;
		await refused({ catchment: { stationId: theirs } }, /not a rainfall station of this project/);
		expect(((await call(owner, 'GET', `/projects/${pid}`)).project.settings as { rainStations?: unknown }).rainStations).toBeNull();
	});

	it('a stranger can’t save it (404) and a viewer can’t (403); an editor can (the positive control)', async () => {
		const rs = { catchment: { stationId: ridge }, units: { [units[0]!]: { stationId: vlei }, [units[1]!]: { stationId: ridge, correctAgainst: vlei } }, sites: { [vlei]: { unitId: units[0]! } }, unreliable: { [ridge]: [['2012-01-01', '2012-01-10']] } };
		expect((await save(stranger, rs)).status).toBe(404);
		expect((await save(viewer, rs)).status).toBe(403);
		const ok = await save(editor, rs);
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body.project.settings.rainStations).toEqual(rs);
		// Replaced whole: a save without a unit unassigns it.
		const fewer = { ...rs, units: { [units[1]!]: rs.units[units[1]!] } };
		expect((await save(editor, fewer)).body.project.settings.rainStations).toEqual(fewer);
		expect((await save(editor, rs)).status).toBe(200);
	});

	it('with stations assigned, the input carries every station’s record and details and the CHIRPS at a placed station’s cached cell', async () => {
		const got = await input();
		expect(got.stations).toEqual({
			[gauge]: { name: 'Catchment average rainfall', mapMm: null, mapSource: null, lat: null, lon: null, isCatchmentGauge: true },
			[ridge]: { name: 'Station Ridge', mapMm: 820, mapSource: 'the ridge gauge’s record, 1991–2020', ...PLACE },
			[vlei]: { name: 'Station Vlei', mapMm: 510, mapSource: 'the vlei gauge’s record', lat: null, lon: null }
		});
		expect(got.series[stationSeriesKey(gauge)]!.values).toEqual(before.series.rain_catchment_mm!.values);
		expect(got.series[stationSeriesKey(ridge)]).toMatchObject({ startDate: '2011-01-01', values: expect.any(Array) });
		expect(got.series[stationSeriesKey(vlei)]!.values[0]).toBe(3);
		// The ridge stands on the cached cell: one year of it, from its first day. The vlei has no place, so no cell.
		const cell = got.series[stationChirpsSeriesKey(ridge)]!;
		expect(cell.startDate).toBe(`${CACHE_YEAR}-01-01`);
		expect(cell.values.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 0, 1]);
		expect(got.series[stationChirpsSeriesKey(vlei)]).toBeUndefined();
		// Everything else is the input as before.
		const { stations: _s, ...rest } = got;
		const otherSeries = Object.fromEntries(Object.entries(rest.series).filter(([k]) => !k.includes('#')));
		expect(otherSeries).toEqual(before.series);
	});

	let runId: string;
	it('a run stores the stations in its snapshot and their series as inputs (no series id), reproduces, and a pack bundle’s input carries them', async () => {
		runId = (await call(owner, 'POST', `/projects/${pid}/runs`, { label: 'stations' }, 201)).run.id as string;
		const [row] = (await asOwner(`SELECT inputs->'stations' AS stations, inputs->'series' AS series FROM model_run WHERE id = $1`, [runId])) as { stations: unknown; series: Record<string, unknown> }[];
		expect(row!.stations).toEqual((await input()).stations);
		expect(Object.keys(row!.series)).toEqual(expect.arrayContaining([stationSeriesKey(gauge), stationSeriesKey(ridge), stationSeriesKey(vlei), stationChirpsSeriesKey(ridge)]));
		const refs = (await asOwner(`SELECT kind, series_id FROM run_input_series WHERE run_id = $1 AND kind LIKE '%#%' ORDER BY kind`, [runId])) as { kind: string; series_id: string | null }[];
		// Each station's record names its series (241), so a manual run is a person accepting it (series/hold.ts);
		// the CHIRPS at the ridge's cell is no series.
		expect(refs).toEqual(
			[
				{ kind: stationChirpsSeriesKey(ridge), series_id: null },
				{ kind: stationSeriesKey(gauge), series_id: gauge },
				{ kind: stationSeriesKey(ridge), series_id: ridge },
				{ kind: stationSeriesKey(vlei), series_id: vlei }
			].sort((x, y) => (x.kind < y.kind ? -1 : 1))
		);
		// What the ingest hold reads as accepted for the ridge: this run's values of it (056/188's function, here as the owner).
		const [accepted] = (await asOwner(
			`SELECT i.start_date::text AS start FROM run_input_series i JOIN model_run r ON r.id = i.run_id
			 WHERE i.series_id = $1 AND r.trigger = 'manual' ORDER BY r.created_at DESC LIMIT 1`,
			[ridge]
		)) as { start: string }[];
		expect(accepted!.start).toBe('2011-01-01');
		// The catchment gauge's download still shows the run's catchment columns, from its rain_catchment_mm key.
		const csv = await (await app.request(`/projects/${pid}/series/${gauge}/export.csv`, { headers: { cookie: owner.cookie, origin: 'http://localhost:7777' } })).text();
		expect(csv).toMatch(/Rain used/);
		// The trigger refuses a station key naming another series.
		await expect(
			asOwner(`INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256, series_id) SELECT run_id, project_id, $2, start_date, sha256, $3 FROM run_input_series WHERE run_id = $1 AND kind = $4`, [
				runId,
				stationSeriesKey(vlei) + 'x',
				ridge,
				stationSeriesKey(ridge)
			])
		).rejects.toThrow(/names a series of another kind/);
		const rebuilt = await withUser(viewer.id, (db) => loadRunInput(db, runId));
		expect(rebuilt.stations).toEqual(row!.stations);
		expect(rebuilt.series[stationChirpsSeriesKey(ridge)]!.startDate).toBe(`${CACHE_YEAR}-01-01`);
		const repro = await call(viewer, 'GET', `/projects/${pid}/runs/${runId}/reproduce`);
		expect(repro.status).toBe('identical');
		// The bundle's run: its input.json is the snapshot, and the re-run's input (bundleRunInput) has the stations and their series.
		const bundled = await withUser(owner.id, (db) => loadBundleRun(db, runId));
		const series = Object.fromEntries(Object.entries(bundled.inputs.series ?? {}).map(([k, s]) => [k, { startDate: s!.startDate, values: [...bundled.values[k]!] }]));
		const again = bundleRunInput(bundled.inputs, series);
		expect(again.stations).toEqual(row!.stations);
		expect(again.series[stationSeriesKey(ridge)]!.values).toEqual(rebuilt.series[stationSeriesKey(ridge)]!.values);
		// A stranger reads none of it.
		expect((await stranger.call('GET', `/projects/${pid}/runs/${runId}/reproduce`)).status).toBe(404);
	});

	it('a copy and an export + import keep the setting naming their own stations and units', async () => {
		const ids = async (p: string) =>
			Object.fromEntries(((await call(owner, 'GET', `/projects/${p}/series`)).series as { id: string; kind: string; name: string }[]).filter((s) => s.kind === 'rain_catchment_mm').map((s) => [s.name, s.id]));
		const nodeIds = async (p: string) => ((await call(owner, 'GET', `/projects/${p}/model`)).nodes as { id: string; name: string }[]).map((n) => n.id);
		const check = async (p: string) => {
			const s = await ids(p);
			const nodes = await nodeIds(p);
			const rs = ((await call(owner, 'GET', `/projects/${p}`)).project.settings as { rainStations: { catchment: { stationId: string }; units: Record<string, { stationId: string; correctAgainst?: string }>; sites: Record<string, { unitId: string }>; unreliable: Record<string, unknown> } }).rainStations;
			expect(rs.catchment.stationId).toBe(s['Station Ridge']);
			expect(Object.values(rs.units).map((a) => a.stationId).sort()).toEqual([s['Station Ridge'], s['Station Vlei']].sort());
			expect(Object.keys(rs.units).every((u) => nodes.includes(u))).toBe(true);
			expect(Object.keys(rs.sites)).toEqual([s['Station Vlei']]);
			expect(nodes).toContain(Object.values(rs.sites)[0]!.unitId);
			expect(Object.keys(rs.unreliable)).toEqual([s['Station Ridge']]);
			// So the copy's input reads its own stations.
			expect(Object.keys((await input(p)).stations ?? {}).sort()).toEqual(Object.values(s).sort());
		};
		const copy = (await call(owner, 'POST', `/projects/${pid}/copy`, { name: 'Stations copy' }, 201)).project.id as string;
		await check(copy);
		const doc = await call(owner, 'GET', `/projects/${pid}/export.json`);
		// Only a station carries its id, and only since the setting names stations by it.
		expect((doc.series as { kind: string; id?: string }[]).filter((s) => s.id).map((s) => s.kind)).toEqual(['rain_catchment_mm', 'rain_catchment_mm', 'rain_catchment_mm']);
		const imported = (await call(owner, 'POST', '/projects/import', doc, 201)).project.id as string;
		await check(imported);
		// Any series may carry an id since the settings name more than stations by it (issue #611); one id twice is refused.
		const flowId = structuredClone(doc);
		(flowId.series as { kind: string; id?: string }[]).find((s) => s.kind === 'flow_observed_m3s')!.id = crypto.randomUUID();
		expect((await owner.call('POST', '/projects/import', flowId)).status).toBe(201);
		const bad = structuredClone(doc);
		const list = bad.series as { kind: string; id?: string }[];
		list.find((s) => s.kind === 'flow_observed_m3s')!.id = list.find((s) => s.id)!.id;
		expect((await owner.call('POST', '/projects/import', bad)).status).toBe(400);
	});

	it('a run forces the catchment from its station × catchment MAP ÷ station MAP, and pairs it on its own cached cell (engine ≥ 1.91.0)', async () => {
		const rs = { catchment: { stationId: ridge }, catchmentMapMm: 410, catchmentMapSource: 'an invented catchment MAP' };
		expect((await save(owner, rs)).status).toBe(200);
		const r = (await call(owner, 'POST', `/projects/${pid}/runs`, { label: 'station forcing' }, 201)).run;
		const st = r.summary.stations as { catchment: { stationId: string; ratio: number; stationMapMm: number; areaMapMm: number; days: { station: number } }; pairings: { stationId: string; chirpsAt: unknown; refused: string | null }[] };
		expect(st.catchment).toMatchObject({ stationId: ridge, stationMapMm: 820, areaMapMm: 410 });
		expect(st.catchment.ratio).toBeCloseTo(0.5, 12);
		expect(st.catchment.days.station).toBeGreaterThan(0);
		// The ridge's pairing reads its own cell, which this file cached for one year only: too short, so refused, saying so.
		const pairing = st.pairings.find((p) => p.stationId === ridge)!;
		expect(pairing.chirpsAt).toEqual({ cell: true });
		expect(pairing.refused).toEqual(expect.any(String));
		// The positive control: without the setting, no station summary.
		expect((await save(owner, null)).status).toBe(200);
		expect((await call(owner, 'POST', `/projects/${pid}/runs`, { label: 'no stations' }, 201)).run.summary.stations).toBeUndefined();
	});

	it('deleting a station the setting names leaves the input buildable and the run made, warning; restoring it brings it back under its id', async () => {
		expect((await save(owner, { catchment: { stationId: vlei } })).status).toBe(200);
		await call(owner, 'DELETE', `/projects/${pid}/series/${vlei}`, undefined, 204);
		const got = await input();
		expect(Object.keys(got.stations!).sort()).toEqual([gauge, ridge].sort());
		expect(got.series[stationSeriesKey(vlei)]).toBeUndefined();
		const r = await call(owner, 'POST', `/projects/${pid}/runs`, { label: 'a station gone' }, 201);
		expect((r.run.summary.warnings as string[]).join('\n')).toMatch(/the catchment’s station ".+" has no record in this run’s input/);
		// A save that keeps naming it passes (the Settings form sends the whole setting with every save, issue #553 round 3),
		// with a unit the setting named and the model no longer has; one that names it anew is refused, until it is back.
		expect((await save(owner, { catchment: { stationId: vlei } })).status).toBe(200);
		expect((await save(owner, null)).status).toBe(200);
		const anew = await save(owner, { catchment: { stationId: vlei } });
		expect(anew.status).toBe(400);
		expect(errorOf(anew)).toMatch(/the catchment’s station is not a rainfall station of this project/);
		// Named where it wasn't before (a unit's correcting station), alongside the kept name: still refused.
		expect((await save(owner, { catchment: { stationId: ridge } })).status).toBe(200);
		expect((await save(owner, { catchment: { stationId: ridge }, units: { [units[0]!]: { stationId: ridge, correctAgainst: vlei } } })).status).toBe(400);
		const revs = (await call(owner, 'GET', `/projects/${pid}/series/${vlei}/revisions`)).revisions as { id: string; reason: string }[];
		await call(owner, 'POST', `/projects/${pid}/series/${vlei}/revisions/${revs[0]!.id}/restore`, {});
		expect(Object.keys((await input()).stations!)).toContain(vlei);
		expect((await save(owner, { catchment: { stationId: vlei } })).status).toBe(200);
	});

	it('a unit the stored setting names and the model no longer has doesn’t block a save that keeps it; a non-land unit named anew is refused', async () => {
		// As if the unit had been deleted from the model after it was given a station (stored straight, as the form can't).
		const gone = crypto.randomUUID();
		await asOwner(`UPDATE project SET settings = jsonb_set(settings, '{rainStations}', $2::jsonb) WHERE id = $1`, [pid, JSON.stringify({ units: { [gone]: { stationId: ridge } } })]);
		const kept = await save(owner, { units: { [gone]: { stationId: ridge }, [units[0]!]: { stationId: vlei } } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		const outletAnew = await save(owner, { units: { [gone]: { stationId: ridge }, [outlet]: { stationId: ridge } } });
		expect(outletAnew.status).toBe(400);
		expect(errorOf(outletAnew)).toMatch(/a unit given a station is not a land unit of this project/);
		expect((await save(owner, null)).status).toBe(200);
	});

	it('reads a station’s cell in the product of the CHIRPS series the run reads, not of the first catchment feed (issue #561)', async () => {
		// A `sat` feed added first writes "CHIRPS boundary"; an uploaded `rnl` record, "CHIRPS (uploaded)", sorts ahead of
		// it, so the run reads the record and never the feed's series (feeds/fromBoundary.ts).
		const feed = (await call(owner, 'POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: PLACE.lat, lon: PLACE.lon }], product: 'sat' }, targetKind: 'rain_chirps_mm', targetName: 'CHIRPS boundary', enabled: false }, 201)).feed as { id: string };
		const values = Array.from({ length: 366 }, (_, t) => t % 5);
		const record = (await call(owner, 'PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'CHIRPS (uploaded)', unit: 'mm', startDate: '2012-01-01', values, product: 'CHIRPS rnl', productVersion: '3.0' })).id as string;
		try {
			expect((await save(owner, { catchment: { stationId: ridge } })).status).toBe(200);
			// The record the run reads is `rnl`, which this file cached: the ridge's cell is read in it.
			const got = await input();
			expect(got.series.rain_chirps_mm!.provenance).toEqual({ product: 'CHIRPS rnl', version: '3.0' });
			expect(got.series[stationChirpsSeriesKey(ridge)]?.startDate).toBe(`${CACHE_YEAR}-01-01`);
			// The positive control: the record relabelled `sat`, the cell is read in `sat`, which the cache doesn't hold.
			await asOwner(`UPDATE time_series SET product = 'CHIRPS sat' WHERE id = $1`, [record]);
			expect((await input()).series[stationChirpsSeriesKey(ridge)]).toBeUndefined();
		} finally {
			await call(owner, 'DELETE', `/projects/${pid}/series/${record}`, undefined, 204);
			await call(owner, 'DELETE', `/projects/${pid}/feeds/${feed.id}`, undefined, 204);
			expect((await save(owner, null)).status).toBe(200);
		}
	});
});
