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
// Only the first, second, fourth to ninth, eleventh and fifteenth are read. A
// blank line or one starting with # is skipped (the committed fixture's
// comments).
//
// Alternate names (fourth column, comma-separated; 237): the search finds a
// place by them too ("Tsabong", the basemap's spelling, finds GeoNames'
// Tshabong; "Pietersburg" Polokwane). GeoNames lists every language's, so only
// those a user here can type are kept (alternateNames): Latin script only, no
// airport or other codes (TBY, FAMY, RSA), no links, and none that folds to
// the main name or to one already kept. On the 2026-10-13 dumps of South
// Africa and its neighbours that keeps 23 267 of 53 836 on the places loaded
// (27 232 fold to a name already there, 2 956 are in another script, 126 are
// codes, 7 links), on 14 615 places. Population (fifteenth column) ranks a
// larger place first; GeoNames gives it for under one place in ten (0 for the
// rest), but for every capital and nearly every seat and large town.
//
// Which places are kept: the feature classes a catchment is found by, A
// (administrative areas), H (rivers, dams, pans), L (areas, localities), P
// (towns, settlements) and T (peaks, hills, passes), and of S (spots,
// buildings) only the farms (FRM, FRMS, FRMT). Roads, railways, undersea and
// vegetation features (R, U, V) and every other S feature are left out, as is
// a line whose position isn't WGS84 degrees.
//
// Which countries (ninth column): South Africa and the six on its border
// (GAZETTEER_COUNTRIES: Botswana, Lesotho, Mozambique, Namibia, Eswatini,
// Zimbabwe; migration 236 holds the table to the same list). Catchments and
// the basemap cross the border, and the basemap labels towns over it (Kanye,
// Lobatse, Gaborone), so a neighbour's dump loads too, but only its places
// inside the basemap's extent (NEIGHBOUR_BBOX): one past it would move the
// view off the map. South Africa's own places are kept wherever they are. A
// place of any other country, or none, is left out and counted apart
// (otherCountry): allCountries.txt or a far country's dump is the wrong file,
// so the loaders say how many they dropped. Several dumps can load as one
// dataset (`pnpm import:gazetteer ZA.txt BW.txt …`, or the files
// concatenated), sharing one check for a geonameid seen twice. A load replaces
// every row of its dataset, in one transaction; other datasets stay.
import type pg from 'pg';
import { searchKey } from './gazetteer.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

export interface PlaceRecord {
	placeId: string;
	name: string;
	searchName: string;
	feature: string;
	admin1: string;
	/** GeoNames' ISO 3166 country code, one of GAZETTEER_COUNTRIES. */
	country: string;
	/** The other names the search finds it by, as published (alternateNames), and each folded, in the same order. */
	altNames: string[];
	altSearch: string[];
	/** GeoNames' population; 0 where it gives none. */
	population: number;
	lon: number;
	lat: number;
	source: string;
}

/** The countries a place may be in (GeoNames' ISO 3166 codes): South Africa, then its neighbours. Migration 236's CHECK is the same list. */
export const GAZETTEER_COUNTRIES = ['ZA', 'BW', 'LS', 'MZ', 'NA', 'SZ', 'ZW'] as const;
const COUNTRIES: ReadonlySet<string> = new Set(GAZETTEER_COUNTRIES);
/** South Africa's code: its places are kept wherever they are, and ranked first. */
export const HOME_COUNTRY = 'ZA';
/**
 * The basemap's extent (west, south, east, north; bin/tiles-dev.sh's default
 * TILES_BBOX, docs/maps.md § Basemap): a neighbour's place outside it is left
 * out, since there is no map to show it on. Measured on GeoNames' dumps of
 * 2026-10-13: it keeps 15 405 of the neighbours' 83 952 places (the whole of
 * Lesotho and Eswatini, southern Botswana, Namibia and Mozambique, Zimbabwe's
 * Beitbridge), docs/maps.md § Gazetteer.
 */
export const NEIGHBOUR_BBOX: readonly [number, number, number, number] = [16.3, -35.0, 33.0, -22.0];
/** The feature classes kept whole, and the S (spot) codes kept: farms. */
const KEEP_CLASSES = new Set(['A', 'H', 'L', 'P', 'T']);
const KEEP_SPOTS = new Set(['FRM', 'FRMS', 'FRMT']);
/** The most alternate names kept for one place (migration 237's CHECK; the most on the 2026-10-13 dumps is 150). */
export const MAX_ALTERNATES = 200;
/** Every letter is a Latin one (accents allowed: Môrester, Čabong). */
const LATIN_ONLY = /^[^\p{L}]*(?:\p{Script=Latin}[^\p{L}]*)+$/u;
/** A code, not a name: an airport's (TBY, FAMY), a country's (RSA): upper case and digits, 2 to 5, no space. */
const CODE = /^[A-Z0-9]{2,5}$/;
/** A link or a path, not a name. */
const LINK = /https?:|www\.|\//i;

/**
 * The alternate names the search keeps from a dump line's alternatenames
 * column (comma-separated): Latin script only, no codes or links, each one
 * folding to a name not yet kept (the main name's `mainKey` counts as kept).
 * `names` as published, `keys` folded (searchKey), in the same order;
 * `dropped` counts the ones left out for their script, as a code or a link
 * (not those folding to a name already kept).
 */
export function alternateNames(raw: string, mainKey: string): { names: string[]; keys: string[]; dropped: number } {
	const names: string[] = [];
	const keys: string[] = [];
	const seen = new Set([mainKey]);
	let dropped = 0;
	for (const part of raw.split(',')) {
		const name = part.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
		if (!name) continue;
		if (name.length > 200 || LINK.test(name) || CODE.test(name) || !LATIN_ONLY.test(name)) {
			dropped++;
			continue;
		}
		const key = searchKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		if (names.length >= MAX_ALTERNATES) {
			dropped++;
			continue;
		}
		names.push(name);
		keys.push(key);
	}
	return { names, keys, dropped };
}

/** Rows written per INSERT. */
const BATCH = 2000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Whether a place of this class and code is one the search keeps. */
export function keepsFeature(cls: string, code: string): boolean {
	return KEEP_CLASSES.has(cls) || (cls === 'S' && KEEP_SPOTS.has(code));
}

/** What a dump gave: the places to load, a problem per line it couldn't read, and what it left out on purpose. */
export interface PlaceRecords {
	records: PlaceRecord[];
	problems: string[];
	/** Places of a kind the search doesn't keep (roads, schools, …). */
	leftOut: number;
	/** Places of a country off GAZETTEER_COUNTRIES (or none). */
	otherCountry: number;
	/** A neighbour's places outside the basemap (NEIGHBOUR_BBOX). */
	outsideMap: number;
	/** The places kept, by country. */
	countries: Record<string, number>;
	/** Alternate names kept on the places kept, and left out (another script, a code, a link). */
	alternates: number;
	alternatesLeftOut: number;
}

/**
 * The places a GeoNames dump holds, with a problem per line it couldn't read
 * (a place of a class the search doesn't keep is left out quietly, counted in
 * `leftOut`; one of a country off the list in `otherCountry`; a neighbour's
 * place off the basemap in `outsideMap`). The source is stored on every place.
 * A geonameid seen twice is kept the first time; pass one `seen` to several
 * calls to check across files.
 */
export function placeRecords(text: string, file: string, source: string, seen = new Set<string>()): PlaceRecords {
	const records: PlaceRecord[] = [];
	const problems: string[] = [];
	const countries: Record<string, number> = {};
	let leftOut = 0;
	let otherCountry = 0;
	let outsideMap = 0;
	let alternates = 0;
	let alternatesLeftOut = 0;
	const [west, south, east, north] = NEIGHBOUR_BBOX;
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
	lines.forEach((line, i) => {
		if (!line.trim() || line.startsWith('#')) return;
		const where = `${file} line ${i + 1}`;
		const c = line.split('\t');
		if (c.length < 11) return problems.push(`${where}: ${c.length} columns, not GeoNames' 19`);
		const country = (c[8] ?? '').trim();
		if (!COUNTRIES.has(country)) {
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
		if (country !== HOME_COUNTRY && (lon < west || lon > east || lat < south || lat > north)) {
			outsideMap++;
			return;
		}
		if (seen.has(placeId)) return problems.push(`${where}: ${placeId} appears twice`);
		seen.add(placeId);
		const admin1 = (c[10] ?? '').trim();
		const pop = (c[14] ?? '').trim();
		const alt = alternateNames(c[3] ?? '', key);
		alternates += alt.names.length;
		alternatesLeftOut += alt.dropped;
		countries[country] = (countries[country] ?? 0) + 1;
		records.push({
			placeId,
			name,
			searchName: key,
			feature: `${cls}.${code}`,
			admin1: /^[0-9A-Za-z]{1,20}$/.test(admin1) ? admin1 : '',
			country,
			altNames: alt.names,
			altSearch: alt.keys,
			population: /^\d{1,12}$/.test(pop) ? Number(pop) : 0,
			lon,
			lat,
			source
		});
	});
	return { records, problems, leftOut, otherCountry, outsideMap, countries, alternates, alternatesLeftOut };
}

/** One line on what a load kept and left out on purpose, for the operator (the CLI's output, CloudWatch). */
export function placesSummary(got: Pick<PlaceRecords, 'countries' | 'leftOut' | 'otherCountry' | 'outsideMap' | 'alternates' | 'alternatesLeftOut'>): string {
	const by = Object.entries(got.countries)
		.map(([cc, n]) => `${cc} ${n}`)
		.join(', ');
	const parts = [
		`kept by country: ${by || 'none'}`,
		`${got.alternates} alternate names (${got.alternatesLeftOut} left out: another script, a code or a link)`,
		`${got.leftOut} of the kinds the search leaves out`
	];
	if (got.outsideMap) parts.push(`${got.outsideMap} of a neighbour's outside the basemap (${NEIGHBOUR_BBOX.join(',')})`);
	if (got.otherCountry) parts.push(`${got.otherCountry} of a country off the list (${GAZETTEER_COUNTRIES.join(', ')}): is this a GeoNames dump of South Africa or a neighbour?`);
	return parts.join('; ');
}

/** Joins one place's alternate names for the INSERT: a unit separator, which CONTROL strips from every name. */
const ALT_SEP = '\u001f';

/** Replace every row of `dataset` with `records`, in one transaction, as the schema owner; `origin` is the bucket file a production load read. Returns how many rows it wrote. */
export async function replacePlaces(client: pg.ClientBase, dataset: string, records: readonly PlaceRecord[], origin: ReferenceOrigin | null = null): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM gazetteer_reference WHERE dataset = $1', [dataset]);
		for (let i = 0; i < records.length; i += BATCH) {
			const batch = records.slice(i, i + BATCH);
			const col = <T>(f: (r: PlaceRecord) => T) => batch.map(f);
			await client.query(
				`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, admin1, country, lon, lat, source, population, alt_names, alt_search)
				 SELECT $1, p, n, sn, f, a1, cc, x, y, src, pop, string_to_array(alts, chr(31)), keys
				 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::float8[], $9::float8[], $10::text[], $11::int8[], $12::text[], $13::text[])
				   AS t(p, n, sn, f, a1, cc, x, y, src, pop, alts, keys)`,
				[
					dataset,
					col((r) => r.placeId),
					col((r) => r.name),
					col((r) => r.searchName),
					col((r) => r.feature),
					col((r) => r.admin1),
					col((r) => r.country),
					col((r) => r.lon),
					col((r) => r.lat),
					col((r) => r.source),
					col((r) => r.population),
					col((r) => r.altNames.join(ALT_SEP)),
					col((r) => r.altSearch.join(' | '))
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
