// A rainfall station's details on a series (issue #553, 239_rain_stations.sql,
// series/station.ts): PATCH …/series/:id { station } as an editor, an upload
// (PUT …/series, POST …/series/merge) that creates a station in one request,
// every series read returning `station`, a copy, the exported document and its
// import carrying it, and the run builder taking the station's MAP as
// settings.unitRain's gauge MAP (runs/execute.ts stationGaugeMap). Each refusal
// has its positive control. Needs Postgres. Synthetic values only.
import type { ModelInput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Station = { mapMm: number | null; mapSource: string | null; lat: number | null; lon: number | null };
type Meta = { id: string; kind: string; name: string; siteNodeId: string | null; station: Station | null };

const DAYS = 30;
const rain = (v: number) => Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? v : 0));
const STATION: Station = { mapMm: 745, mapSource: 'Synthetic station record 1991–2020', lat: -33.9, lon: 18.9 };

/** Outlet ← farm A (2 km²), a month of catchment rain ('') and a flow record. */
async function stationProject(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm A', outlet.id, { areaKm2: 2 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const put = async (body: Record<string, unknown>) => {
		const r = await u.call('PUT', `/projects/${id}/series`, { unit: 'mm', startDate: '2020-01-01', ...body });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		return r.body as Meta;
	};
	const catchment = await put({ kind: 'rain_catchment_mm', name: '', values: rain(10) });
	const flow = await put({ kind: 'flow_observed_m3s', unit: 'm3/s', name: '', values: rain(1) });
	return { id, outlet, farm, catchment, flow, put };
}

const patch = (u: User, pid: string, seriesId: string, body: Record<string, unknown>) => u.call('PATCH', `/projects/${pid}/series/${seriesId}`, body);
const list = async (u: User, pid: string) => (await u.call('GET', `/projects/${pid}/series`)).body.series as Meta[];
const labelled = async (pid: string) =>
	(await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.labelled' AND subject ? 'station' ORDER BY id`, [pid])).map(
		(e: { subject: unknown }) => e.subject
	);

describe('a rainfall station’s details (239_rain_stations)', () => {
	let owner: User;
	let editor: User;
	let viewer: User;
	let stranger: User;
	let p: Awaited<ReturnType<typeof stationProject>>;
	beforeAll(async () => {
		owner = await signUp('StnOwner');
		editor = await signUp('StnEditor');
		viewer = await signUp('StnViewer');
		stranger = await signUp('StnStranger');
		p = await stationProject(owner, 'Stations');
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	});

	it('every series read says station null until one is recorded', async () => {
		expect(p.catchment.station).toBeNull();
		expect((await list(owner, p.id)).every((s) => s.station === null)).toBe(true);
		expect((await owner.call('GET', `/projects/${p.id}/series/${p.catchment.id}`)).body.station).toBeNull();
	});

	it('an editor records a station; a viewer reads it back (RLS) but may not change it; logged once as series.labelled', async () => {
		// Refusals first, each with the positive control below.
		expect((await patch(viewer, p.id, p.catchment.id, { station: STATION })).status).toBe(403);
		expect((await patch(stranger, p.id, p.catchment.id, { station: STATION })).status).toBe(404);
		expect((await patch(editor, p.id, '00000000-0000-4000-8000-000000000000', { station: STATION })).status).toBe(404);
		const r = await patch(editor, p.id, p.catchment.id, { station: { ...STATION, mapSource: `  ${STATION.mapSource}  ` } });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body).toMatchObject({ id: p.catchment.id, station: STATION });
		// The viewer sees it, in the list and the one series.
		expect((await list(viewer, p.id)).find((s) => s.id === p.catchment.id)!.station).toEqual(STATION);
		expect((await viewer.call('GET', `/projects/${p.id}/series/${p.catchment.id}`)).body.station).toEqual(STATION);
		// The same again changes and logs nothing.
		expect((await patch(editor, p.id, p.catchment.id, { station: STATION })).status).toBe(200);
		expect(await labelled(p.id)).toEqual([
			{ seriesId: p.catchment.id, kind: 'rain_catchment_mm', name: '', station: { from: 'not a station', to: 'MAP 745 mm (Synthetic station record 1991–2020) at -33.9, 18.9' } }
		]);
		// A stranger sees no series at all.
		expect((await stranger.call('GET', `/projects/${p.id}/series`)).status).toBe(404);
	});

	it('a missing field is null; all-null and null clear the station', async () => {
		const s = await p.put({ kind: 'rain_catchment_mm', name: 'Clear me', values: rain(3) });
		const map = await patch(owner, p.id, s.id, { station: { mapMm: 600, mapSource: 'Synthetic' } });
		expect(map.status, JSON.stringify(map.body)).toBe(200);
		expect(map.body.station).toEqual({ mapMm: 600, mapSource: 'Synthetic', lat: null, lon: null });
		const place = await patch(owner, p.id, s.id, { station: { lat: -34, lon: 19 } });
		expect(place.body.station).toEqual({ mapMm: null, mapSource: null, lat: -34, lon: 19 });
		expect((await patch(owner, p.id, s.id, { station: { mapMm: null, mapSource: null, lat: null, lon: null } })).body.station).toBeNull();
		expect((await patch(owner, p.id, s.id, { station: { mapMm: 600, mapSource: 'Synthetic' } })).body.station).not.toBeNull();
		expect((await patch(owner, p.id, s.id, { station: null })).body.station).toBeNull();
	});

	it('refuses station details the engine’s rainStationError refuses, with a plain message', async () => {
		const bad: [unknown, RegExp][] = [
			[{ mapMm: 745 }, /a MAP needs its source/],
			[{ mapMm: 0, mapSource: 's' }, /MAP must be a number from 1 to 12000/],
			[{ mapMm: 12_001, mapSource: 's' }, /MAP must be a number/],
			[{ mapMm: 745, mapSource: '   ' }, /a MAP needs its source/],
			[{ mapMm: 745, mapSource: 'x'.repeat(601) }, /longer than 600/],
			[{ mapSource: 'only a source' }, /a MAP source needs its MAP/],
			[{ lat: -33.9 }, /both a latitude and a longitude/],
			[{ lat: -91, lon: 18 }, /latitude/],
			[{ lat: -33, lon: 181 }, /longitude/],
			[{ mapMm: 745, mapSource: 's', elevation: 300 }, /unrecognized|elevation/i],
			['745', /object/i]
		];
		for (const [station, message] of bad) {
			const r = await patch(owner, p.id, p.catchment.id, { station });
			expect(r.status, JSON.stringify(station)).toBe(400);
			expect(JSON.stringify(r.body), JSON.stringify(station)).toMatch(message);
			expect(JSON.stringify(r.body)).not.toMatch(/constraint|violates|time_series_/);
		}
		// Positive control: the station is as recorded above.
		expect((await list(owner, p.id)).find((s) => s.id === p.catchment.id)!.station).toEqual(STATION);
	});

	it('refuses a station on a series that can’t be one: another kind, a unit’s own rain, or a site on a station', async () => {
		const chirps = await p.put({ kind: 'rain_chirps_mm', name: '', values: rain(4) });
		const onChirps = await patch(owner, p.id, chirps.id, { station: STATION });
		expect(onChirps.status).toBe(400);
		expect(onChirps.body.error).toBe('station: only a catchment rainfall series (rain_catchment_mm) is a rainfall station');
		const onFlow = await patch(owner, p.id, p.flow.id, { station: STATION });
		expect(onFlow.status).toBe(400);
		// A unit's own gauge (209) isn't a station.
		const own = await p.put({ kind: 'rain_catchment_mm', name: 'Farm A gauge', values: rain(5) });
		expect((await patch(owner, p.id, own.id, { siteNodeId: p.farm.id })).status).toBe(200);
		const onSited = await patch(owner, p.id, own.id, { station: STATION });
		expect(onSited.status).toBe(400);
		expect(onSited.body.error).toMatch(/^station: a rainfall station is the project’s, not one unit’s/);
		// Nor may a station be given a unit while it has its details.
		const sitedStation = await patch(owner, p.id, p.catchment.id, { siteNodeId: p.farm.id });
		expect(sitedStation.status).toBe(400);
		expect(sitedStation.body.error).toMatch(/^siteNodeId: this series is a rainfall station/);
		expect((await list(owner, p.id)).find((s) => s.id === p.catchment.id)).toMatchObject({ siteNodeId: null, station: STATION });
		// Positive controls: clearing the unit and recording the station in one PATCH; clearing the station and giving a unit in one.
		const moved = await patch(owner, p.id, own.id, { siteNodeId: null, station: { mapMm: 800, mapSource: 'Synthetic' } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(moved.body).toMatchObject({ siteNodeId: null, station: { mapMm: 800 } });
		const back = await patch(owner, p.id, own.id, { station: null, siteNodeId: p.farm.id });
		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(back.body).toMatchObject({ siteNodeId: p.farm.id, station: null });
		// Clearing on a series that can't be a station is nothing to refuse.
		expect((await patch(owner, p.id, chirps.id, { station: null })).status).toBe(200);
	});

	it('an upload creates a station in one request (PUT and merge); the wrong kind rolls the whole upload back', async () => {
		const st = { mapMm: 690, mapSource: 'Synthetic second station', lat: null, lon: null };
		const r = await editor.call('PUT', `/projects/${p.id}/series`, { kind: 'rain_catchment_mm', name: 'Station B', unit: 'mm', startDate: '2020-01-01', values: rain(6), station: st });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.station).toEqual(st);
		// A replace that doesn't say keeps it.
		const again = await editor.call('PUT', `/projects/${p.id}/series`, { kind: 'rain_catchment_mm', name: 'Station B', unit: 'mm', startDate: '2020-01-01', values: rain(7) });
		expect(again.body.station).toEqual(st);
		const m = await editor.call('POST', `/projects/${p.id}/series/merge`, {
			kind: 'rain_catchment_mm',
			name: 'Station C',
			unit: 'mm',
			startDate: '2020-01-01',
			values: rain(8),
			station: { mapMm: 710, mapSource: 'Synthetic third station' }
		});
		expect(m.status, JSON.stringify(m.body)).toBe(200);
		expect(m.body.station).toEqual({ mapMm: 710, mapSource: 'Synthetic third station', lat: null, lon: null });
		// Refused: a station on a CHIRPS upload (nothing is stored), bad details, and a viewer's upload.
		const wrong = await editor.call('PUT', `/projects/${p.id}/series`, { kind: 'rain_chirps_mm', name: 'Not a station', unit: 'mm', startDate: '2020-01-01', values: rain(1), station: st });
		expect(wrong.status).toBe(400);
		expect(wrong.body.error).toMatch(/only a catchment rainfall series/);
		const badMap = await editor.call('POST', `/projects/${p.id}/series/merge`, { kind: 'rain_catchment_mm', name: 'Station D', unit: 'mm', startDate: '2020-01-01', values: rain(1), station: { mapMm: 745 } });
		expect(badMap.status).toBe(400);
		expect((await viewer.call('PUT', `/projects/${p.id}/series`, { kind: 'rain_catchment_mm', name: 'Station E', unit: 'mm', startDate: '2020-01-01', values: rain(1), station: st })).status).toBe(403);
		const names = (await list(owner, p.id)).map((s) => s.name);
		expect(names).toEqual(expect.arrayContaining(['Station B', 'Station C']));
		expect(names).not.toContain('Not a station');
		expect(names).not.toContain('Station D');
		expect(names).not.toContain('Station E');
	});

	it('a copy, the exported document and its import carry the station; an import checks it', async () => {
		const copy = await owner.call('POST', `/projects/${p.id}/copy`, { name: 'Stations copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		const cid = copy.body.project.id as string;
		expect((await list(owner, cid)).find((s) => s.kind === 'rain_catchment_mm' && s.name === '')!.station).toEqual(STATION);

		type Doc = { series: { kind: string; name: string; siteNodeId?: string; station?: Station }[] };
		const doc = (await owner.call('GET', `/projects/${p.id}/export.json`)).body as Doc;
		expect(doc.series.find((s) => s.kind === 'rain_catchment_mm' && s.name === '')!.station).toEqual(STATION);
		expect('station' in doc.series.find((s) => s.kind === 'flow_observed_m3s')!).toBe(false);
		const imported = await owner.call('POST', '/projects/import', { ...doc, name: 'Stations import' });
		expect(imported.status, JSON.stringify(imported.body)).toBe(201);
		const iid = imported.body.project.id as string;
		expect((await list(owner, iid)).find((s) => s.kind === 'rain_catchment_mm' && s.name === '')!.station).toEqual(STATION);
		// A file with a station on a flow record, or bad details, is refused.
		const bad = structuredClone(doc);
		bad.series.find((s) => s.kind === 'flow_observed_m3s')!.station = STATION;
		const refused = await owner.call('POST', '/projects/import', { ...bad, name: 'Bad station' });
		expect(refused.status).toBe(400);
		expect(refused.body.details).toEqual([{ message: 'series flow_observed_m3s: station: only a catchment rainfall series (rain_catchment_mm) is a rainfall station' }]);
		const badMap = structuredClone(doc);
		badMap.series.find((s) => s.kind === 'rain_catchment_mm' && s.name === '')!.station = { ...STATION, mapSource: null };
		expect((await owner.call('POST', '/projects/import', { ...badMap, name: 'Bad MAP' })).status).toBe(400);
	});
});

describe('the run builder takes the station’s MAP as the gauge MAP (runs/execute.ts)', () => {
	const unitRain = (i: ModelInput) => (i.settings as unknown as { unitRain?: Record<string, unknown> | null }).unitRain;
	const input = (u: User, pid: string) => withUser(u.id, (db) => loadModelInput(db, pid));

	it('station over settings; settings as before without one; nothing added for a project without unitRain', async () => {
		const u = await signUp('StnRun');
		const q = await stationProject(u, 'Station run');
		// No unitRain: a station's MAP adds none (the input is as before).
		expect((await patch(u, q.id, q.catchment.id, { station: { mapMm: 650, mapSource: 'Synthetic station' } })).status).toBe(200);
		expect(unitRain(await input(u, q.id))).toBeUndefined();
		// unitRain with its own gauge MAP: the station's wins, with its source.
		const settings = { mode: 'perUnit', gaugeMapMm: 700, gaugeMapSource: 'Synthetic settings gauge' };
		expect((await u.call('PATCH', `/projects/${q.id}`, { settings: { unitRain: settings } })).status).toBe(200);
		expect(unitRain(await input(u, q.id))).toEqual({ ...settings, gaugeMapMm: 650, gaugeMapSource: 'Synthetic station' });
		// A station later by name isn't the one a run reads: its MAP plays no part.
		await q.put({ kind: 'rain_catchment_mm', name: 'zz later station', values: rain(9), station: { mapMm: 900, mapSource: 'Not read' } });
		expect(unitRain(await input(u, q.id))).toMatchObject({ gaugeMapMm: 650 });
		// The run stores it, so a scenario, an evidence pack and a reproduction (loadRunInput) read the same value.
		const res = await u.call('POST', `/projects/${q.id}/runs`, { label: 'station MAP' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const stored: ModelInput = await withUser(u.id, (db) => loadRunInput(db, res.body.run.id as string));
		expect(unitRain(stored)).toMatchObject({ gaugeMapMm: 650, gaugeMapSource: 'Synthetic station' });
		// The station's MAP cleared: the settings' gauge MAP, as before 239.
		expect((await patch(u, q.id, q.catchment.id, { station: { lat: -34, lon: 19 } })).status).toBe(200);
		expect(unitRain(await input(u, q.id))).toEqual(settings);
		expect((await patch(u, q.id, q.catchment.id, { station: null })).status).toBe(200);
		expect(unitRain(await input(u, q.id))).toEqual(settings);
	});
});
