// Evaporation proposed from the map (issue #326 Part B, "B-evap";
// 180_evaporation_reference.sql, 181_evaporation_accepted.sql; docs/api.md
// § Catchment map, docs/maps.md § Evaporation from the map).
//
//   GET  /projects/:id/evaporation-proposals        the boundary's monthly evaporation from a grid, beside the settings (viewer)
//   POST /projects/:id/evaporation-from-map         accept it into the settings it belongs to (editor)
//   GET  /projects/:id/evaporation-stations         the nearest DWS evaporation stations to the boundary, with each one's monthly means (viewer)
//   POST /projects/:id/evaporation-from-station     accept a station's pan record as the A-pan (editor; issue #646 item 6)
//
// The map proposes, the modeller decides. What the 12 values go into is the
// dataset's kind, never converted: a reference-ET grid (FAO-56 ET₀) becomes
// GR4J's monthly PE (settings.pe = { kind: 'monthly', mm, source }, the pan
// coefficient then unused); an A-pan grid becomes the A-pan row
// (settings.apanMm, read by demand, the dams and GR4J under pe 'pan'). An
// accept is one settings revision whose reason names the dataset, version
// and method (what an evidence pack prints), and an evaporation_accepted
// row. The server re-derives the values; the client only names the dataset.
//
// A station (evaporationStations.ts) proposes 12 monthly means of its daily
// pan record and, for a Class-A pan, the record itself as the daily A-pan
// series. An accept writes the A-pan row as one settings revision whose
// reason cites the station, its pan, the months the means came from and any
// conversion, and (Class-A only, unless the body says daily: false) replaces
// the series `DWS <code>` (kind evap_apan_mm), its source naming the station.
// A Symons pan needs the S→A equation the user picks, and never writes the
// daily series. A project holding another daily A-pan series is refused (409):
// the engine reads one series of a kind, so two would leave one unused.
import { PE_SOURCE_MAX, type SpanConversionId } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginSettingsChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole } from '../projects/access.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import { lastValueDaySql } from '../series/lastDay.js';
import { queueAutoCalibrationFor, queueRerunFor } from '../series/newData.js';
import { replaceSeries } from '../series/replace.js';
import { wakeForRerun } from '../series/routes.js';
import {
	citeEvaporation,
	evaporationDatasets,
	evaporationLabel,
	summariseEvaporation,
	TARGET_OF,
	type EvaporationDataset,
	type EvaporationKind,
	type EvaporationSummary,
	type EvaporationTarget
} from './evaporation.js';
import {
	conversionsFor,
	distanceToBoundaryKm,
	EVAP_STATIONS_WITHIN_KM,
	EVAP_STATIONS_WITHIN_MAX_KM,
	evaporationStation,
	evaporationStationDatasets,
	monthlyMeans,
	nearestEvaporationStations,
	PAN_LABEL,
	stationApan,
	stationValues,
	trimmedRecord,
	type MonthlyMeans
} from './evaporationStations.js';
import type { Geometry } from './geojson.js';
import { EVAP_STATION_CODE } from './loadEvaporationStations.js';

export const EvaporationFromMap = z.object({ dataset: z.string().trim().min(1).max(50) }).strict();

/** The proposals' one query parameter: a dataset label (absent = the default). */
export const EvaporationQuery = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

interface Boundary {
	id: string;
	name: string;
	geometry: Geometry;
}

/** The catchment boundary, if drawn. */
async function boundaryOf(db: Db, projectId: string): Promise<Boundary | null> {
	const { rows } = await db.query<Boundary>(
		`SELECT id, name, geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	return rows[0] ?? null;
}

/** The dataset asked for, or the default (a real one before the synthetic grid); null with none loaded. */
async function pickDataset(db: Db, wanted: string | undefined): Promise<{ dataset: EvaporationDataset | null; datasets: EvaporationDataset[] }> {
	const datasets = await evaporationDatasets(db);
	if (wanted === undefined) return { dataset: datasets[0] ?? null, datasets };
	const hit = datasets.find((d) => d.dataset === wanted);
	if (!hit) throw new ApiError(400, `No evaporation dataset “${wanted}” is loaded.`);
	return { dataset: hit, datasets };
}

/** The project's settings as stored, merged over the defaults. */
async function settingsOf(db: Db, projectId: string): Promise<{ stored: unknown; merged: ReturnType<typeof mergeSettings> }> {
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const stored = rows[0]?.settings;
	return { stored, merged: mergeSettings(stored) };
}

const sameRow = (a: readonly number[] | null | undefined, b: readonly number[]) => !!a && a.length === 12 && a.every((x, i) => Math.abs(x - b[i]!) < 0.05);

/** What the settings hold now for each target: the A-pan row, and the monthly PE row when there is one. */
function currentRows(s: ReturnType<typeof mergeSettings>): Record<EvaporationTarget, number[] | null> {
	return { apan: [...s.apanMm], pe: s.pe?.kind === 'monthly' ? [...s.pe.mm] : null };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** How the values were taken over this boundary, in a sentence. */
const howTaken = (b: Boundary, s: EvaporationSummary) =>
	`area-weighted over the ${s.cells} grid cell${s.cells === 1 ? '' : 's'} the catchment boundary “${b.name || 'unnamed'}” covers (${pct(s.coverage)} of it has values)`;

/** The PE row's `source` (at most PE_SOURCE_MAX): the dataset's citation and how it was taken. */
export const peSourceFor = (d: EvaporationDataset, b: Boundary, s: EvaporationSummary) =>
	`Proposed from the map: ${evaporationLabel(d)}, ${citeEvaporation(d)}, ${howTaken(b, s)}; taken as GR4J's PE unchanged.`.slice(0, PE_SOURCE_MAX);

/** GET …/evaporation-stations' query: the search radius from the boundary, km. */
export const EvaporationStationsQuery = z.object({ within: z.coerce.number().finite().positive().max(EVAP_STATIONS_WITHIN_MAX_KM).optional() }).strict();

/** POST …/evaporation-from-station: the station, the S→A equation (Symons only) and whether to write the daily series (Class-A only; default yes). */
export const EvaporationFromStation = z
	.object({
		station: z.string().trim().toUpperCase().regex(EVAP_STATION_CODE, 'a DWS evaporation station code, e.g. A2E001'),
		conversion: z.enum(['wr90', 'taljaard2023']).optional(),
		daily: z.boolean().optional()
	})
	.strict();

/** The daily A-pan series a station's record is written as. */
export const stationSeriesName = (code: string) => `DWS ${code}`;

/** The project's daily A-pan series (the first by name, as a run reads it), with its source and span. */
async function dailyApanOf(db: Db, projectId: string): Promise<{ name: string; source: string | null; from: string; to: string }[]> {
	const { rows } = await db.query<{ name: string; source: string | null; from: string | null; to: string | null }>(
		`SELECT ts.name, ts.source, to_char(ts.start_date, 'YYYY-MM-DD') AS "from", to_char(${lastValueDaySql('ts')}, 'YYYY-MM-DD') AS "to"
		 FROM time_series ts WHERE ts.project_id = $1 AND ts.kind = 'evap_apan_mm' ORDER BY ts.name COLLATE "C"`,
		[projectId]
	);
	return rows.map((r) => ({ name: r.name, source: r.source, from: r.from ?? '', to: r.to ?? '' }));
}

const monthsText = (m: MonthlyMeans) => `${m.first}–${m.last}, ${Math.min(...m.years)}–${Math.max(...m.years)} complete years a month`;

export const evaporationRoutes = new Hono<AuthEnv>()
	.get('/:id/evaporation-proposals', async (c) => {
		const id = c.req.param('id');
		const { dataset: wanted } = EvaporationQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { dataset, datasets } = await pickDataset(db, wanted);
			const boundary = await boundaryOf(db, id);
			const summary = dataset && boundary ? await summariseEvaporation(db, dataset, boundary.geometry) : null;
			const { merged } = await settingsOf(db, id);
			const now = currentRows(merged);
			// A daily A-pan record (evap_apan_mm) replaces the monthly row on every day it covers, and a monthly PE row
			// replaces it for GR4J: the panel says so before an accept (persona-hydrologist, round 4).
			const { rows: daily } = await db.query<{ from: string | null; to: string | null }>(
				`SELECT to_char(min(ts.start_date), 'YYYY-MM-DD') AS "from", to_char(max(${lastValueDaySql('ts')}), 'YYYY-MM-DD') AS "to"
				 FROM time_series ts WHERE ts.project_id = $1 AND ts.kind = 'evap_apan_mm'`,
				[id]
			);
			const dailyApan = daily[0]?.from && daily[0].to ? { from: daily[0].from, to: daily[0].to } : null;
			const { rows: accepted } = await db.query<{
				target: EvaporationTarget;
				monthly_mm: number[];
				dataset: string;
				kind: EvaporationKind;
				source: string;
				version: string;
				method: string;
				coverage: number;
				accepted_at: Date;
			}>(
				`SELECT target, monthly_mm, dataset, kind, source, version, method, coverage, accepted_at
				 FROM evaporation_accepted WHERE project_id = $1 ORDER BY target`,
				[id]
			);
			return c.json({
				dataset,
				datasets: datasets.map((d) => ({ dataset: d.dataset, kind: d.kind, version: d.version, synthetic: d.synthetic })),
				boundary: boundary ? { featureId: boundary.id, name: boundary.name } : null,
				target: dataset ? TARGET_OF[dataset.kind] : null,
				proposal: summary,
				settings: { apanMm: now.apan, peKind: merged.pe?.kind ?? 'pan', peMm: now.pe, dailyApan },
				accepted: accepted.map((r) => ({
					target: r.target,
					monthlyMm: r.monthly_mm,
					dataset: r.dataset,
					kind: r.kind,
					source: r.source,
					version: r.version,
					method: r.method,
					coverage: r.coverage,
					acceptedAt: r.accepted_at.toISOString(),
					// Still what the settings hold (they are rewritten whole on a save, so the link is by value).
					current: sameRow(now[r.target], r.monthly_mm)
				}))
			});
		});
	})
	.post('/:id/evaporation-from-map', async (c) => {
		const body = EvaporationFromMap.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { dataset } = await pickDataset(db, body.dataset);
			const d = dataset!;
			const boundary = await boundaryOf(db, id);
			if (!boundary) throw new ApiError(400, 'There is no catchment boundary on the map: draw or import it on the Map first.');
			// Re-derived here from the dataset and the boundary as they are now.
			const summary = await summariseEvaporation(db, d, boundary.geometry);
			if ('problem' in summary) throw new ApiError(400, `${citeEvaporation(d)} can’t be summarised over the boundary: ${summary.problem}.`);
			if (!summary.monthlyMm.some((x) => x > 0)) throw new ApiError(400, `${citeEvaporation(d)} has no evaporation over the boundary, so there is nothing to use.`);
			const target = TARGET_OF[d.kind];
			const before = await beginSettingsChange(db, id);
			const { stored } = await settingsOf(db, id);
			const patch = target === 'pe' ? { pe: { kind: 'monthly', mm: summary.monthlyMm, source: peSourceFor(d, boundary, summary) } } : { apanMm: summary.monthlyMm };
			const settings = patchSettings(stored, patch);
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(settings)]);
			await db.query(
				`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				 ON CONFLICT (project_id, target) DO UPDATE SET monthly_mm = EXCLUDED.monthly_mm, dataset = EXCLUDED.dataset, kind = EXCLUDED.kind,
					source = EXCLUDED.source, version = EXCLUDED.version, method = EXCLUDED.method, coverage = EXCLUDED.coverage, accepted_at = now()`,
				[id, target, summary.monthlyMm, d.dataset, d.kind, d.source, d.version, d.method, summary.coverage]
			);
			const what = target === 'pe' ? 'GR4J’s monthly PE' : 'A-pan evaporation';
			const revision = await recordModelRevision(db, id, {
				source: 'settings_patch',
				before,
				reason: `${what} from the map: ${summary.annualMm} mm a year of ${evaporationLabel(d)}, ${howTaken(boundary, summary)}; ${citeEvaporation(d)}. ${d.method}`.slice(0, 500)
			});
			return c.json({ target, monthlyMm: summary.monthlyMm, dataset: d.dataset, revisionId: revision?.id ?? null });
		});
	})
	.get('/:id/evaporation-stations', async (c) => {
		const id = c.req.param('id');
		const q = EvaporationStationsQuery.parse(c.req.query());
		const withinKm = q.within ?? EVAP_STATIONS_WITHIN_KM;
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const boundary = await boundaryOf(db, id);
			const datasets = await evaporationStationDatasets(db);
			const { merged } = await settingsOf(db, id);
			const settings = { apanMm: [...merged.apanMm], dailyApan: await dailyApanOf(db, id) };
			if (!boundary) return c.json({ boundary: null, withinKm, datasets, stations: [], settings });
			const near = await nearestEvaporationStations(db, boundary.geometry, withinKm);
			const values = await stationValues(db, near.map((s) => s.code));
			const stations = near.map((s) => {
				const means = monthlyMeans(s.startDate, values.get(s.code) ?? []);
				const { startDate: _s, length: _l, daysWithValue: _d, ...rest } = s;
				return {
					...rest,
					monthly: means,
					apan: s.pan === 'class_a' ? stationApan('class_a', means, null) : null,
					conversions: s.pan === 'symons' ? conversionsFor(means) : null,
					seriesName: stationSeriesName(s.code)
				};
			});
			return c.json({ boundary: { featureId: boundary.id, name: boundary.name }, withinKm, datasets, stations, settings });
		});
	})
	.post('/:id/evaporation-from-station', async (c) => {
		const body = EvaporationFromStation.parse(await readJson(c));
		const id = c.req.param('id');
		const res = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const boundary = await boundaryOf(db, id);
			if (!boundary) throw new ApiError(400, 'There is no catchment boundary on the map: draw or import it on the Map first.');
			const st = await evaporationStation(db, body.station);
			if (!st) throw new ApiError(400, `No evaporation station ${body.station} is loaded.`);
			const km = distanceToBoundaryKm([st.lon, st.lat], boundary.geometry);
			if (!(km <= EVAP_STATIONS_WITHIN_MAX_KM)) throw new ApiError(400, `${st.code} is more than ${EVAP_STATIONS_WITHIN_MAX_KM} km from the catchment boundary.`);
			const conversion: SpanConversionId | null = body.conversion ?? null;
			const means = monthlyMeans(st.startDate, st.values);
			const apan = stationApan(st.pan, means, conversion);
			if (!apan.ok) throw new ApiError(400, `${st.code}’s record can’t be used: ${apan.reason}.`);
			const daily = body.daily ?? st.pan === 'class_a';
			if (daily && st.pan === 'symons') throw new ApiError(400, 'A Symons pan’s daily record is not written as the A-pan series: its 12 converted means are used instead.');
			const seriesName = stationSeriesName(st.code);
			if (daily) {
				const other = (await dailyApanOf(db, id)).find((s) => s.name !== seriesName);
				if (other) throw new ApiError(409, `The project already has a daily A-pan series, “${other.name}”: a run reads one, so delete or replace it on the Data page first, or use only the monthly means.`);
			}
			const before = await beginSettingsChange(db, id);
			const { stored } = await settingsOf(db, id);
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(patchSettings(stored, { apanMm: apan.apanMm }))]);
			const where = km === 0 ? `inside the catchment boundary “${boundary.name || 'unnamed'}”` : `${Math.round(km * 10) / 10} km from the catchment boundary “${boundary.name || 'unnamed'}”`;
			const annual = Math.round(apan.apanMm.reduce((a, b) => a + b, 0));
			const record = trimmedRecord(st.startDate, st.values);
			const parts = [
				`A-pan evaporation from DWS evaporation station ${st.code}${st.name ? ` “${st.name}”` : ''} (${PAN_LABEL[st.pan]}, ${where}): ${annual} mm a year, the monthly means of ${monthsText(means)}`,
				apan.note ? `; ${apan.note}` : '',
				daily ? `; daily series “${seriesName}” written (${record.startDate} to ${fromEpochDay(toEpochDay(record.startDate) + record.values.length - 1)})` : st.pan === 'symons' ? '; the daily S-pan record not written' : '; daily series not written',
				`. ${st.source} (dataset “${st.dataset}”).`
			];
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: parts.join('').slice(0, 500) });
			let queued = null;
			if (daily) {
				const source = `DWS evaporation station ${st.code} (${PAN_LABEL[st.pan]}), dataset ${st.dataset}`.slice(0, 200);
				const r = await replaceSeries(db, id, { kind: 'evap_apan_mm', name: seriesName, unit: 'mm', startDate: record.startDate, values: record.values, origin: { source, unit: 'mm', factor: 1 } });
				const change = { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, daysChanged: r.daysChanged, via: 'user' as const };
				queued = await queueRerunFor(db, id, change);
				await queueAutoCalibrationFor(db, id, change);
			}
			return { queued, out: { station: st.code, apanMm: apan.apanMm, conversion, series: daily ? seriesName : null, revisionId: revision?.id ?? null } };
		});
		await wakeForRerun(res.queued);
		return c.json(res.out);
	});
