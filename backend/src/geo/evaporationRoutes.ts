// Evaporation proposed from the map (issue #326 Part B, "B-evap";
// 180_evaporation_reference.sql, 181_evaporation_accepted.sql; docs/api.md
// § Catchment map, docs/maps.md § Evaporation from the map).
//
//   GET  /projects/:id/evaporation-proposals        the boundary's monthly evaporation from a grid, beside the settings (viewer);
//                                                   a grid asked for by label that isn't loaded answers as none loaded
//   POST /projects/:id/evaporation-from-map         accept it into the settings it belongs to (editor)
//   GET  /projects/:id/evaporation-stations         the nearest DWS evaporation stations to the boundary, with each one's monthly means (viewer)
//   POST /projects/:id/evaporation-from-station     accept a station's pan record as the A-pan (editor; issue #646 item 6)
//   GET  /projects/:id/evaporation-wr2012           WR2012's monthly S-pan and A-pan for each quaternary the boundary overlaps, and the catchment's (viewer)
//   POST /projects/:id/evaporation-from-wr2012      accept the catchment's WR2012 A-pan as the A-pan row (editor)
//   POST /projects/:id/evaporation-from-span        12 S-pan months the user typed or pasted, converted, as the A-pan (editor)
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
//
// WR2012's evaporation (wr2012Evaporation.ts; 310): each quaternary the
// boundary overlaps, with its share of the catchment and the monthly S-pan
// (runoff module) and A-pan (irrigation module) of WR2012's WRSM2000 network
// configurations, and the catchment's rows as their area-weighted means. The
// A-pan is the model's own input, so an accept writes it as it stands (no
// conversion), as one settings revision whose reason names the dataset, the
// quaternaries with their shares, the module files and any disagreement.
// Twelve S-pan months from elsewhere go through …/evaporation-from-span, with
// the equation the user picks.
import { apanMonthlyFromSpan, PE_SOURCE_MAX, SPAN_CONVERSIONS, type SpanConversionId } from '@water-management/engine';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginSettingsChange, fitCitedReason, fitReason, recordModelRevision } from '../history/record.js';
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
	referenceEvaporation,
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
import { quaternaryDatasets } from './quaternary.js';
import { quaternariesText, wr2012EvaporationFor } from './wr2012Evaporation.js';

export const EvaporationFromMap = z.object({ dataset: z.string().trim().min(1).max(50) }).strict();

/** The proposals' one query parameter: a dataset label (absent = the default). */
export const EvaporationQuery = z.object({ dataset: z.string().trim().min(1).max(50).optional() });

interface Boundary {
	id: string;
	name: string;
	geometry: Geometry;
	/** As it stood when read: recorded with an acceptance (273, issue #646 F8), so a redrawn boundary shows as changed since. */
	updatedAt: string;
	areaM2: number | null;
}

/** The catchment boundary, if drawn. */
async function boundaryOf(db: Db, projectId: string): Promise<Boundary | null> {
	const { rows } = await db.query<Boundary>(
		`SELECT id, name, geometry, area_m2 AS "areaM2", to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
		 FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	return rows[0] ?? null;
}

/**
 * The dataset asked for, or the default (a real one before the synthetic grid); null with none loaded. One asked for
 * that isn't loaded is refused (400), or, with `missing: 'none'` (the proposals' GET), answered as none loaded: Model
 * settings → Demand asks for the CCWR A-pan grid by its label (Atlas-Apan-2007), and a server that hasn't loaded it
 * (production until issue #755, a fresh clone) is the normal state, which the panel says plainly.
 */
async function pickDataset(db: Db, wanted: string | undefined, missing: 'refuse' | 'none' = 'refuse'): Promise<{ dataset: EvaporationDataset | null; datasets: EvaporationDataset[] }> {
	const datasets = await evaporationDatasets(db);
	if (wanted === undefined) return { dataset: datasets[0] ?? null, datasets };
	const hit = datasets.find((d) => d.dataset === wanted);
	if (!hit && missing === 'refuse') throw new ApiError(400, `No evaporation dataset “${wanted}” is loaded.`);
	return { dataset: hit ?? null, datasets };
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
const howTaken = (b: Pick<Boundary, 'name'>, s: EvaporationSummary) =>
	`area-weighted over the ${s.cells} grid cell${s.cells === 1 ? '' : 's'} the catchment boundary “${b.name || 'unnamed'}” covers (${pct(s.coverage)} of it has values)`;

/**
 * The PE row's `source` (at most PE_SOURCE_MAX): the dataset's citation and how it was taken; with the dataset's
 * reference in place of its citation when the citation would not fit (issue #763), never a cut-off citation.
 */
export const peSourceFor = (d: EvaporationDataset, b: Pick<Boundary, 'name'>, s: EvaporationSummary) => {
	const line = (cite: string) => `Proposed from the map: ${evaporationLabel(d)}, ${cite}, ${howTaken(b, s)}; taken as GR4J's PE unchanged.`;
	const full = line(citeEvaporation(d));
	return full.length <= PE_SOURCE_MAX ? full : line(referenceEvaporation(d)).slice(0, PE_SOURCE_MAX);
};

/**
 * The settings revision's reason for an accepted proposal (issue #763): what changed and how it was taken, then the
 * dataset's stable reference (label, version, period, where its source, method and credit live), which fitReason
 * always keeps whole. The long source and method stay on the dataset row (and evaporation_accepted's copy).
 */
export const evaporationReason = (d: EvaporationDataset, b: Pick<Boundary, 'name'>, s: EvaporationSummary): string => {
	const what = TARGET_OF[d.kind] === 'pe' ? 'GR4J’s monthly PE' : 'A-pan evaporation';
	return fitReason(`${what} from the map: ${s.annualMm} mm a year of ${evaporationLabel(d)}, ${howTaken(b, s)}`, `; ${referenceEvaporation(d)}.`);
};

/**
 * A DWS evaporation station's revision reason (issue #763): the station's source and dataset last, kept whole, or
 * the dataset's reference when the source is long; only the description before it is shortened.
 */
export const stationReason = (head: string, st: { source: string; dataset: string }): string =>
	fitCitedReason(head, `. ${st.source} (dataset “${st.dataset}”).`, `. Dataset “${st.dataset}”: its source as the dataset records it, credit at /data-sources.`);

/**
 * WR2012's A-pan revision reason (issue #763): the source last, kept whole, or the datasets' reference when it is
 * long; the quaternary list before it (the head, which starts with the dataset labels) is what gets shortened.
 */
export const wr2012Reason = (head: string, datasets: string, source: string | null): string =>
	source
		? fitCitedReason(head, `. ${source}`, `. Source as dataset ${datasets} records it, credit at /data-sources#wrc-water-resources.`)
		: fitReason(head, '.');

/**
 * A typed S-pan's revision reason (issue #763): the S-pan months, the conversion and its note last, kept whole;
 * only the user's note (up to 200 characters) is shortened.
 */
export const spanReason = (note: string | undefined, apanMm: readonly number[], spanMm: readonly number[], label: string, conversionNote: string): string => {
	const annual = (row: readonly number[]) => Math.round(row.reduce((a, b) => a + b, 0));
	return fitReason(
		`A-pan evaporation from S-pan typed or pasted${note ? ` (${note})` : ''}: ${annual(apanMm)} mm a year from ${annual(spanMm)} mm of S-pan`,
		` (Oct–Sep, mm: ${spanMm.join(' ')}), converted by the ${label}; ${conversionNote}.`
	);
};

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

/** POST …/evaporation-from-wr2012: nothing to pick (the A-pan is WR2012's own); the server re-derives it. */
export const EvaporationFromWr2012 = z.object({}).strict();

/** POST …/evaporation-from-span: 12 S-pan months (mm, Oct … Sep), the S→A equation, and where they come from (optional). */
export const EvaporationFromSpan = z
	.object({
		spanMm: z.array(z.number().finite().min(0).max(1000)).length(12),
		conversion: z.enum(['wr90', 'taljaard2023']),
		note: z.string().trim().max(200).optional()
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
			const { dataset, datasets } = await pickDataset(db, wanted, 'none');
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
				`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage, boundary)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
				 ON CONFLICT (project_id, target) DO UPDATE SET monthly_mm = EXCLUDED.monthly_mm, dataset = EXCLUDED.dataset, kind = EXCLUDED.kind,
					source = EXCLUDED.source, version = EXCLUDED.version, method = EXCLUDED.method, coverage = EXCLUDED.coverage, boundary = EXCLUDED.boundary, accepted_at = now()`,
				// The boundary as it was summarised (273, issue #646 F8): the Map's Checks flag a redraw since.
				[id, target, summary.monthlyMm, d.dataset, d.kind, d.source, d.version, d.method, summary.coverage, JSON.stringify({ featureId: boundary.id, updatedAt: boundary.updatedAt, areaM2: boundary.areaM2 ?? 0 })]
			);
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: evaporationReason(d, boundary, summary) });
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
			const head = [
				`A-pan evaporation from DWS evaporation station ${st.code}${st.name ? ` “${st.name}”` : ''} (${PAN_LABEL[st.pan]}, ${where}): ${annual} mm a year, the monthly means of ${monthsText(means)}`,
				daily ? `; daily series “${seriesName}” written (${record.startDate} to ${fromEpochDay(toEpochDay(record.startDate) + record.values.length - 1)})` : st.pan === 'symons' ? '; the daily S-pan record not written' : '; daily series not written',
				// The conversion note last in the head: its equation comes first, so a shortened reason keeps it, and only its reference is cut.
				apan.note ? `; ${apan.note}` : ''
			].join('');
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: stationReason(head, st) });
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
	})
	.get('/:id/evaporation-wr2012', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const boundary = await boundaryOf(db, id);
			const datasets = await quaternaryDatasets(db);
			const { merged } = await settingsOf(db, id);
			const settings = { apanMm: [...merged.apanMm], dailyApan: await dailyApanOf(db, id) };
			if (!boundary) return c.json({ boundary: null, datasets, evaporation: null, settings });
			const evaporation = await wr2012EvaporationFor(db, boundary.geometry);
			return c.json({ boundary: { featureId: boundary.id, name: boundary.name }, datasets, evaporation, settings });
		});
	})
	.post('/:id/evaporation-from-wr2012', async (c) => {
		EvaporationFromWr2012.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const boundary = await boundaryOf(db, id);
			if (!boundary) throw new ApiError(400, 'There is no catchment boundary on the map: draw or import it on the Map first.');
			// Re-derived here from the loaded quaternaries and the boundary as they are now.
			const ev = await wr2012EvaporationFor(db, boundary.geometry);
			if (!ev.apanMm) throw new ApiError(400, `WR2012’s A-pan can’t be proposed for the catchment: ${ev.problem ?? 'no quaternary has an irrigation module'}.`);
			const apanMm = ev.apanMm;
			const before = await beginSettingsChange(db, id);
			const { stored } = await settingsOf(db, id);
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(patchSettings(stored, { apanMm }))]);
			const used = ev.quaternaries.filter((q) => q.apanMm);
			const datasets = [...new Set(used.map((q) => q.evaporationDataset))].map((d) => `“${d}”`).join(', ');
			const files = used.reduce((a, q) => a + (q.apan?.agree ?? 0), 0);
			const annual = (row: readonly number[]) => Math.round(row.reduce((a, b) => a + b, 0));
			const left = 1 - ev.apanCoverage;
			const reason = [
				`A-pan evaporation from WR2012’s WRSM2000 irrigation modules (dataset ${datasets}): ${annual(apanMm)} mm a year, `,
				used.length === 1 ? 'the A-pan of the quaternary' : 'the area-weighted A-pan of the quaternaries',
				` under the catchment boundary “${boundary.name || 'unnamed'}”: ${quaternariesText(used)}; from ${files} module file${files === 1 ? '' : 's'}`,
				left >= 0.005 ? `; ${Math.round(left * 100)} % of the catchment has no WR2012 A-pan and is left out of the mean` : '',
				ev.spanMm ? `; their runoff modules’ S-pan is ${annual(ev.spanMm)} mm a year` : ''
			].join('');
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: wr2012Reason(reason, datasets, used[0]!.source?.trim() || null) });
			return c.json({ apanMm, spanMm: ev.spanMm, quaternaries: used.map((q) => q.code), revisionId: revision?.id ?? null });
		});
	})
	.post('/:id/evaporation-from-span', async (c) => {
		const body = EvaporationFromSpan.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// The S-pan is the user's own; the conversion, its floors and the note citing it are the same as a station's.
			const spanMm = body.spanMm.map((x) => Math.round(x * 10) / 10);
			const fill = apanMonthlyFromSpan(spanMm, body.conversion);
			if (!fill.ok) throw new ApiError(400, `These S-pan months can’t be converted that way: ${fill.reason}.`);
			const before = await beginSettingsChange(db, id);
			const { stored } = await settingsOf(db, id);
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(patchSettings(stored, { apanMm: fill.values }))]);
			const label = SPAN_CONVERSIONS.find((x) => x.id === body.conversion)!.label;
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: spanReason(body.note, fill.values, spanMm, label, fill.note) });
			return c.json({ apanMm: fill.values, spanMm, conversion: body.conversion, revisionId: revision?.id ?? null });
		});
	});
