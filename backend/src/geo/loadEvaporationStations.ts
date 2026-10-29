// Load an evaporation-station dataset into evaporation_station_reference
// (274; issue #646 item 6, docs/maps.md § Evaporation stations). The
// operator's tool, run as the schema owner (`pnpm import:evaporation-stations`);
// the app only reads the table.
//
// Input: a station list and one daily record per station.
//  * The list is a CSV with a header row: code,name,pan,lat,lon (and an
//    optional source), the columns in any order, lat and lon in decimal
//    degrees, pan one of A / Class-A / class_a or S / Symons / symons (DWS's
//    station lists mark each evaporation record [A] or [S]).
//  * Each record is DWS's daily evaporation table for that station (a saved
//    HyData.aspx page or DWS's text reply), read by dwsEvaporation.ts, in a
//    directory, its file name starting with the station code
//    (Z1E001-reply.synthetic.txt). A station with no record file is skipped,
//    and so is a record that names another station.
// A load replaces every row of its dataset, in one transaction.
import type pg from 'pg';
import { parseDwsEvaporation } from './dwsEvaporation.js';
import type { PanType } from './evaporationStations.js';

export const EVAP_STATION_CODE = /^[A-Z][0-9]E[0-9]{3}$/;

export interface EvaporationStationRecord {
	code: string;
	name: string;
	pan: PanType;
	lon: number;
	lat: number;
	startDate: string;
	values: (number | null)[];
	daysWithValue: number;
	source: string;
}

const PAN: Record<string, PanType> = { a: 'class_a', 'class-a': 'class_a', class_a: 'class_a', 'class a': 'class_a', s: 'symons', symons: 'symons', 's-pan': 'symons' };

/** A pan type as a station list writes it ("[S]", "Class-A", "symons"), or null. */
export function panOf(v: string | undefined): PanType | null {
	return PAN[(v ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase()] ?? null;
}

const num = (v: string | undefined): number | null => {
	if (v === undefined || v.trim() === '') return null;
	const n = Number(v.trim());
	return Number.isFinite(n) ? n : null;
};

/**
 * The stations a list and its record files describe, with a problem per
 * station skipped. `records` maps a file name to its text; a station's record
 * is the first file whose name starts with its code. The source is the row's
 * own, else `defaultSource`.
 */
export function evaporationStationRecords(
	list: { name: string; text: string },
	records: readonly { name: string; text: string }[],
	defaultSource: string
): { stations: EvaporationStationRecord[]; problems: string[] } {
	const problems: string[] = [];
	const stations: EvaporationStationRecord[] = [];
	const lines = list.text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { stations, problems: [`${list.name}: empty`] };
	const head = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
	for (const need of ['code', 'pan', 'lat', 'lon']) if (!head.includes(need)) return { stations, problems: [`${list.name}: no "${need}" column`] };
	const seen = new Set<string>();
	lines.slice(1).forEach((line, i) => {
		const cells = line.split(',').map((c) => c.trim());
		const get = (k: string) => (head.includes(k) ? cells[head.indexOf(k)] : undefined);
		const where = `${list.name} row ${i + 2}`;
		const code = (get('code') ?? '').toUpperCase();
		if (!EVAP_STATION_CODE.test(code)) return problems.push(`${where}: "${code}" is not an evaporation station code (e.g. A2E001)`);
		if (seen.has(code)) return problems.push(`${where}: ${code} appears twice`);
		const pan = panOf(get('pan'));
		if (!pan) return problems.push(`${where} (${code}): pan must be A (Class-A) or S (Symons)`);
		const lon = num(get('lon'));
		const lat = num(get('lat'));
		if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) return problems.push(`${where} (${code}): no position in WGS84 degrees`);
		const source = get('source')?.slice(0, 500) || defaultSource;
		if (!source) return problems.push(`${where} (${code}): no source (give the row a "source" or pass --source)`);
		const file = records.find((f) => f.name.toUpperCase().startsWith(code));
		if (!file) return problems.push(`${where} (${code}): no record file starting with ${code}`);
		let rec;
		try {
			rec = parseDwsEvaporation(file.text);
		} catch (e) {
			return problems.push(`${file.name} (${code}): ${(e as Error).message}`);
		}
		if (rec.station && rec.station !== code) return problems.push(`${file.name}: the record names ${rec.station}, the list ${code}`);
		seen.add(code);
		stations.push({ code, name: (get('name') ?? '').slice(0, 200), pan, lon, lat, startDate: rec.startDate, values: rec.values, daysWithValue: rec.daysWithValue, source });
	});
	return { stations, problems };
}

/** Replace every row of `dataset` with `stations`, in one transaction, as the schema owner. Returns how many rows it wrote. */
export async function replaceEvaporationStations(client: pg.ClientBase, dataset: string, stations: readonly EvaporationStationRecord[]): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM evaporation_station_reference WHERE dataset = $1', [dataset]);
		for (const s of stations) {
			await client.query(
				`INSERT INTO evaporation_station_reference (code, name, pan, lon, lat, start_date, "values", days_with_value, dataset, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
				 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, pan = EXCLUDED.pan, lon = EXCLUDED.lon, lat = EXCLUDED.lat,
					start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", days_with_value = EXCLUDED.days_with_value,
					dataset = EXCLUDED.dataset, source = EXCLUDED.source, loaded_at = now()`,
				[s.code, s.name, s.pan, s.lon, s.lat, s.startDate, s.values, s.daysWithValue, dataset, s.source]
			);
		}
		await client.query('COMMIT');
		return stations.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
