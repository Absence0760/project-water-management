// Load a gazetteer into gazetteer_reference (225; issue #523 C5, docs/maps.md
// § Search). The operator's tool, run as the schema owner (`pnpm
// import:gazetteer` locally; in production the migrate Lambda through
// load-reference.yml, referenceLoad.ts); the app only reads the table.
//
// Input: GeoNames' country dump (`ZA.txt` from download.geonames.org/export/dump/,
// tab-separated, UTF-8, no header), one place a line in its 19 columns:
//   geonameid, name, asciiname, alternatenames, latitude, longitude,
//   feature class, feature code, country code, cc2, admin1 code, admin2,
//   admin3, admin4, population, elevation, dem, timezone, modification date.
// Only the first, second, fifth to ninth and eleventh are read. A blank line
// or one starting with # is skipped (the committed fixture's comments).
//
// Which places are kept: the feature classes a catchment is found by, A
// (administrative areas), H (rivers, dams, pans), L (areas, localities), P
// (towns, settlements) and T (peaks, hills, passes), and of S (spots,
// buildings) only the farms (FRM, FRMS, FRMT). Roads, railways, undersea and
// vegetation features (R, U, V) and every other S feature are left out, as is
// a line whose position isn't WGS84 degrees. So is a place whose country code
// (the ninth column) isn't ZA, counted apart: the search is South Africa's, and
// a file holding other countries (allCountries.txt, a neighbour's dump) is the
// wrong file, so the loaders say how many they dropped. A load replaces every row of its
// dataset, in one transaction.
import type pg from 'pg';
import { searchKey } from './gazetteer.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

export interface PlaceRecord {
	placeId: string;
	name: string;
	searchName: string;
	feature: string;
	admin1: string;
	lon: number;
	lat: number;
	source: string;
}

/** The country a place must be in (GeoNames' ISO 3166 country code). */
export const GAZETTEER_COUNTRY = 'ZA';
/** The feature classes kept whole, and the S (spot) codes kept: farms. */
const KEEP_CLASSES = new Set(['A', 'H', 'L', 'P', 'T']);
const KEEP_SPOTS = new Set(['FRM', 'FRMS', 'FRMT']);
/** Rows written per INSERT. */
const BATCH = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Whether a place of this class and code is one the search keeps. */
export function keepsFeature(cls: string, code: string): boolean {
	return KEEP_CLASSES.has(cls) || (cls === 'S' && KEEP_SPOTS.has(code));
}

/**
 * The places a GeoNames dump holds, with a problem per line it couldn't read
 * (a place of a class the search doesn't keep is left out quietly, counted in
 * `leftOut`; a place outside South Africa, country code not ZA, is left out
 * and counted in `otherCountry`). The source is stored on every place. A geonameid seen twice is
 * kept the first time.
 */
export function placeRecords(text: string, file: string, source: string): { records: PlaceRecord[]; problems: string[]; leftOut: number; otherCountry: number } {
	const records: PlaceRecord[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	let leftOut = 0;
	let otherCountry = 0;
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	lines.forEach((line, i) => {
		if (!line.trim() || line.startsWith('#')) return;
		const where = `${file} line ${i + 1}`;
		const c = line.split('\t');
		if (c.length < 11) return problems.push(`${where}: ${c.length} columns, not GeoNames' 19`);
		if ((c[8] ?? '').trim() !== GAZETTEER_COUNTRY) {
			otherCountry++;
			return;
		}
		const placeId = c[0]!.trim();
		if (!/^[0-9A-Za-z_-]{1,30}$/.test(placeId)) return problems.push(`${where}: "${placeId.slice(0, 40)}" is not a place id`);
		const cls = c[6]!.trim();
		const code = c[7]!.trim();
		if (!/^[A-Z]$/.test(cls) || !/^[A-Z0-9]{1,10}$/.test(code)) return problems.push(`${where} (${placeId}): no feature class and code`);
		if (!keepsFeature(cls, code)) {
			leftOut++;
			return;
		}
		const name = c[1]!.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
		const key = searchKey(name).slice(0, 200) || searchKey(c[2] ?? '').slice(0, 200);
		if (!name || !key) return problems.push(`${where} (${placeId}): no name`);
		const lat = Number(c[4]);
		const lon = Number(c[5]);
		if (!c[4]?.trim() || !c[5]?.trim() || !Number.isFinite(lat) || !Number.isFinite(lon) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
			return problems.push(`${where} (${placeId}): no position in WGS84 degrees`);
		}
		if (seen.has(placeId)) return problems.push(`${where}: ${placeId} appears twice`);
		seen.add(placeId);
		const admin1 = (c[10] ?? '').trim();
		records.push({ placeId, name, searchName: key, feature: `${cls}.${code}`, admin1: /^[0-9A-Za-z]{1,20}$/.test(admin1) ? admin1 : '', lon, lat, source });
	});
	return { records, problems, leftOut, otherCountry };
}

/** Replace every row of `dataset` with `records`, in one transaction, as the schema owner; `origin` is the bucket file a production load read. Returns how many rows it wrote. */
export async function replacePlaces(client: pg.ClientBase, dataset: string, records: readonly PlaceRecord[], origin: ReferenceOrigin | null = null): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM gazetteer_reference WHERE dataset = $1', [dataset]);
		for (let i = 0; i < records.length; i += BATCH) {
			const batch = records.slice(i, i + BATCH);
			const col = <T>(f: (r: PlaceRecord) => T) => batch.map(f);
			await client.query(
				`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, admin1, lon, lat, source)
				 SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::float8[], $9::text[])`,
				[
					dataset,
					col((r) => r.placeId),
					col((r) => r.name),
					col((r) => r.searchName),
					col((r) => r.feature),
					col((r) => r.admin1),
					col((r) => r.lon),
					col((r) => r.lat),
					col((r) => r.source)
				]
			);
		}
		await recordReferenceOrigin(client, 'gazetteer', dataset, origin);
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
