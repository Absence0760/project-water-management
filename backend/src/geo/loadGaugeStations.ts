// Load a gauging-station dataset into gauge_station_reference (153; issue
// #326 Part B "B-gauge", docs/maps.md § Gauging stations). The operator's
// tool, run as the schema owner (`pnpm import:gauge-stations`); the app only
// reads the table.
//
// Input, one or more files:
//  * a GeoJSON FeatureCollection of Points in WGS84, each feature's code in a
//    `code` / `station` / `STATION` / `Station` property, with `name`,
//    `river`, `catchmentKm2`, `recordStart`, `recordEnd` (and `source`); or
//  * a CSV with a header row (the DWS station catalogue, transcribed):
//    code,name,river,lat,lon,catchment_km2,record_start,record_end
//    (the columns may come in any order; lat and lon in decimal degrees).
// Dates are YYYY-MM-DD, YYYY/MM/DD or YYYYMMDD. A load replaces every row of
// its dataset, in one transaction.
import type pg from 'pg';
import type { StationCandidate } from './stations.js';

export type StationRecord = Omit<StationCandidate, 'dataset'>;

export const STATION_CODE = /^[A-Z][0-9][A-Z][0-9]{3}$/;
const CODE_KEYS = ['code', 'station', 'STATION', 'Station', 'STATION_NO', 'Code'];
const pick = (p: Record<string, unknown>, keys: string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && v !== '');

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(String(v).trim());
	return Number.isFinite(n) ? n : null;
};

/** A date as YYYY-MM-DD, or null when it's absent or not a real day. */
export function parseDate(v: unknown): string | null | 'bad' {
	if (v === null || v === undefined || String(v).trim() === '') return null;
	const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/.exec(String(v).trim());
	if (!m) return 'bad';
	const iso = `${m[1]}-${m[2]}-${m[3]}`;
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? 'bad' : iso;
}

interface Raw {
	where: string;
	code: unknown;
	name: unknown;
	river: unknown;
	lon: unknown;
	lat: unknown;
	catchmentKm2: unknown;
	recordStart: unknown;
	recordEnd: unknown;
	source: unknown;
}

/** Check one raw station; a record, or why it was skipped. */
function toRecord(r: Raw, defaultSource: string): StationRecord | string {
	const code = String(r.code ?? '').trim().toUpperCase();
	if (!STATION_CODE.test(code)) return `${r.where}: "${code}" is not a station code (e.g. A2H012)`;
	const lon = num(r.lon);
	const lat = num(r.lat);
	if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) return `${r.where} (${code}): no position in WGS84 degrees`;
	const recordStart = parseDate(r.recordStart);
	const recordEnd = parseDate(r.recordEnd);
	if (recordStart === 'bad' || recordEnd === 'bad') return `${r.where} (${code}): a record date is not a day (YYYY-MM-DD)`;
	if (recordStart && recordEnd && recordStart > recordEnd) return `${r.where} (${code}): the record ends before it starts`;
	const area = num(r.catchmentKm2);
	const source = typeof r.source === 'string' && r.source.trim() ? r.source.trim().slice(0, 500) : defaultSource;
	if (!source) return `${r.where} (${code}): no source (give the station a "source" or pass --source)`;
	return {
		code,
		name: String(r.name ?? '').trim().slice(0, 200),
		river: String(r.river ?? '').trim().slice(0, 200),
		lon,
		lat,
		catchmentKm2: area !== null && area > 0 ? area : null,
		recordStart,
		recordEnd,
		source
	};
}

/** The raw stations a GeoJSON FeatureCollection of points holds. */
function fromGeoJson(fc: { features?: unknown }, file: string): { raw: Raw[]; problems: string[] } {
	const raw: Raw[] = [];
	const problems: string[] = [];
	(fc.features as { properties?: Record<string, unknown> | null; geometry?: { type?: unknown; coordinates?: unknown } | null }[]).forEach((f, i) => {
		const p = f?.properties ?? {};
		const where = `${file} feature ${i + 1}`;
		const g = f?.geometry;
		if (g?.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length !== 2) return problems.push(`${where}: not a 2D point`);
		raw.push({
			where,
			code: pick(p, CODE_KEYS),
			name: pick(p, ['name', 'NAME', 'Name', 'place', 'PLACE']),
			river: pick(p, ['river', 'RIVER', 'River']),
			lon: g.coordinates[0],
			lat: g.coordinates[1],
			catchmentKm2: pick(p, ['catchmentKm2', 'catchment_km2', 'CATCH_AREA', 'area_km2']),
			recordStart: pick(p, ['recordStart', 'record_start', 'START', 'start']),
			recordEnd: pick(p, ['recordEnd', 'record_end', 'END', 'end']),
			source: p.source
		});
	});
	return { raw, problems };
}

/** The raw stations a CSV holds (header row, columns as the file comment says). */
function fromCsv(text: string, file: string): { raw: Raw[]; problems: string[] } {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { raw: [], problems: [`${file}: empty`] };
	const head = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
	const col = (name: string) => head.indexOf(name);
	for (const need of ['code', 'lat', 'lon']) if (col(need) < 0) return { raw: [], problems: [`${file}: no "${need}" column`] };
	return {
		raw: lines.slice(1).map((line, i) => {
			const cells = line.split(',').map((c) => c.trim());
			const get = (name: string) => (col(name) >= 0 ? cells[col(name)] : undefined);
			return {
				where: `${file} row ${i + 2}`,
				code: get('code'),
				name: get('name'),
				river: get('river'),
				lon: get('lon'),
				lat: get('lat'),
				catchmentKm2: get('catchment_km2'),
				recordStart: get('record_start'),
				recordEnd: get('record_end'),
				source: get('source')
			};
		}),
		problems: []
	};
}

/**
 * The records a set of files describes (GeoJSON or CSV, told apart by their
 * text), with a problem per station skipped. The source is the station's
 * own, else `defaultSource`. A code seen twice is kept the first time.
 */
export function stationRecords(files: readonly { name: string; text: string }[], defaultSource: string): { records: StationRecord[]; problems: string[] } {
	const records: StationRecord[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		let parsed: { raw: Raw[]; problems: string[] };
		if (f.text.trimStart().startsWith('{')) {
			let json: { type?: unknown; features?: unknown };
			try {
				json = JSON.parse(f.text);
			} catch {
				problems.push(`${f.name}: not valid JSON`);
				continue;
			}
			if (json?.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
				problems.push(`${f.name}: not a GeoJSON FeatureCollection`);
				continue;
			}
			parsed = fromGeoJson(json, f.name);
		} else parsed = fromCsv(f.text, f.name);
		problems.push(...parsed.problems);
		for (const r of parsed.raw) {
			const rec = toRecord(r, defaultSource);
			if (typeof rec === 'string') problems.push(rec);
			else if (seen.has(rec.code)) problems.push(`${r.where}: ${rec.code} appears twice`);
			else {
				seen.add(rec.code);
				records.push(rec);
			}
		}
	}
	return { records, problems };
}

/** Replace every row of `dataset` with `records`, in one transaction, as the schema owner. Returns how many rows it wrote. */
export async function replaceStations(client: pg.ClientBase, dataset: string, records: readonly StationRecord[]): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM gauge_station_reference WHERE dataset = $1', [dataset]);
		for (const r of records) {
			await client.query(
				`INSERT INTO gauge_station_reference (code, name, river, lon, lat, catchment_km2, record_start, record_end, dataset, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, river = EXCLUDED.river, lon = EXCLUDED.lon, lat = EXCLUDED.lat,
					catchment_km2 = EXCLUDED.catchment_km2, record_start = EXCLUDED.record_start, record_end = EXCLUDED.record_end,
					dataset = EXCLUDED.dataset, source = EXCLUDED.source, loaded_at = now()`,
				[r.code, r.name, r.river, r.lon, r.lat, r.catchmentKm2, r.recordStart, r.recordEnd, dataset, r.source]
			);
		}
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
