// The Map's search (issue #523 C5, #90 Q23; docs/maps.md § Search): a few
// words in, the places they name out, for moving the map's view before Start
// from the map. It reads only our own reference tables, never a third-party
// geocoder: the map's own layers first (gauging-station codes and names, the
// register of dams' names and numbers, quaternary codes), then the gazetteer
// (225, GeoNames' place and farm names in production). Nothing is written.
//
// The match rule, the same for every table: every word typed starts some word
// of the name (case, accents and punctuation ignored, searchKey), or, for a
// code, the code starts with what was typed (spaces ignored: "z1h 00" finds
// Z1H001). Within a group the closest come first: the whole name, then a name
// that starts with the words, then the rest by name.
import type { Db } from '../db/tx.js';

/**
 * The label every committed fixture loads under (the stations', the
 * register's, the quaternaries' and this one's); a match from it is marked
 * synthetic. Kept here, not imported from those modules, so the migrate
 * Lambda's loader (referenceLoad.ts, through loadGazetteer.ts) pulls in none of them.
 */
export const SYNTHETIC_GAZETTEER = 'synthetic';
/** GeoNames' attribution (CC BY 4.0), stored on every place a load takes without a source of its own. */
export const GEONAMES_SOURCE = 'GeoNames (geonames.org), CC BY 4.0';
/** The most matches per map layer, and from the gazetteer. */
export const SEARCH_LAYER_LIMIT = 5;
export const SEARCH_PLACE_LIMIT = 10;
/** The most words a search compares (the rest are ignored). */
export const SEARCH_MAX_WORDS = 6;

/**
 * A name as the search compares it: lower case, accents dropped, every run of
 * anything but letters and digits one space, trimmed. The loader writes it to
 * gazetteer_reference.search_name; the query folds the words typed the same
 * way. Only letters, digits and single spaces survive, so the words never
 * carry a LIKE wildcard (% or _).
 */
export function searchKey(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** The words a search compares: searchKey's, at most SEARCH_MAX_WORDS, each kept once. */
export function searchWords(q: string): string[] {
	return [...new Set(searchKey(q).split(' ').filter(Boolean))].slice(0, SEARCH_MAX_WORDS);
}

/** What was typed as a code (a gauge's, a register number's, a quaternary's): upper case, no spaces; null when it can't be one. */
export function codeKey(q: string): string | null {
	const c = q.replace(/\s+/g, '').toUpperCase();
	return /^[A-Z0-9][A-Z0-9/]{0,19}$/.test(c) ? c : null;
}

export type SearchKind = 'gauge' | 'dam' | 'quaternary' | 'place';

export interface SearchHit {
	kind: SearchKind;
	/** The gauge's code, the dam's register number, the quaternary's code; null for a place. */
	code: string | null;
	name: string;
	/** The gauge's or dam's river ('' when not given); '' otherwise. */
	river: string;
	/** A place's GeoNames feature class and code ('P.PPL', 'S.FRM'); null for the map's layers. */
	feature: string | null;
	/** A place's province (GeoNames' admin1 code, '' when not given; its own country's, so a neighbour's is no South African province); null for the map's layers. */
	admin1: string | null;
	/** A place's country (GeoNames' ISO 3166 code: ZA, or a neighbour's, 236); null for the map's layers. */
	country: string | null;
	/** Where to move the view: the point, and for a quaternary its box (west, south, east, north). */
	lon: number;
	lat: number;
	bbox: [number, number, number, number] | null;
	dataset: string;
	/** True for the repo's invented datasets: never a real place. */
	synthetic: boolean;
	/** A place's credit, shown with the match (GeoNames' CC BY 4.0 attribution); null for the map's layers. */
	source: string | null;
}

export interface SearchAnswer {
	q: string;
	hits: SearchHit[];
	/** Some group had more matches than it lists: type more to narrow it. */
	truncated: boolean;
	/**
	 * The gazetteer holds places (any dataset). False until the operator loads
	 * one (production: load-reference.yml, kind gazetteer), when no town, farm
	 * or river can be found, so an empty answer must not read as "no such place".
	 */
	placesLoaded: boolean;
}

/**
 * The SQL test "every word of $words starts a word of <expr>", where <expr>
 * is already searchKey-shaped (letters, digits, single spaces). The leading
 * space makes "starts a word" one LIKE.
 */
const everyWordStarts = (expr: string, words: string) => `(SELECT bool_and((' ' || ${expr}) LIKE '% ' || w || '%') FROM unnest(${words}::text[]) w)`;
/** The accented letters a South African name carries (Afrikaans, French Huguenot names), and their plain letters: searchKey's fold, for SQL without the unaccent extension. */
const ACCENTED = 'áàâäãåéèêëíìîïóòôöõúùûüýÿçñ';
const PLAIN = 'aaaaaaeeeeiiiiooooouuuuyycn';
/** A name folded in SQL as searchKey folds it: lower case, accents dropped (ACCENTED), non-alphanumerics one space. */
const sqlKey = (col: string) => `btrim(regexp_replace(translate(lower(${col}), '${ACCENTED}', '${PLAIN}'), '[^[:alnum:]]+', ' ', 'g'))`;
/** Closest first: the whole name, then a name starting with the words typed, then by name. */
const closeness = (expr: string, phrase: string) => `(${expr} = ${phrase}) DESC, (${expr} LIKE ${phrase} || '%') DESC`;

/**
 * Among towns of the same name, the seat of government first: the capital,
 * then a province's, a district's, a local municipality's seat, then the rest
 * (GeoNames' PPLC, PPLG, PPLA…PPLA4). Kuruman is a Northern Cape PPLA2 and a
 * Free State PPL; the one on the map's label is the seat. GeoNames' population
 * would rank them too, but the dump leaves it 0 for most places.
 */
const SEAT_RANK = `CASE feature WHEN 'P.PPLC' THEN 0 WHEN 'P.PPLG' THEN 0 WHEN 'P.PPLA' THEN 1 WHEN 'P.PPLA2' THEN 2 WHEN 'P.PPLA3' THEN 3 WHEN 'P.PPLA4' THEN 4 ELSE 5 END`;

/**
 * South Africa's places before a neighbour's (236): after closeness and kind,
 * before the seat of government, so the Eastern Cape's Kanye (a hamlet) comes
 * before Botswana's (a district seat), while a neighbour's town still comes
 * before a South African farm of its name. The catchments are South Africa's;
 * the neighbours' places are there for the towns the basemap labels over the
 * border.
 */
const HOME_FIRST = `(country = 'ZA') DESC`;

/** Search the map's layers, then the gazetteer, for `q`. */
export async function searchMap(db: Db, q: string): Promise<SearchAnswer> {
	const words = searchWords(q);
	const phrase = words.join(' ');
	const code = codeKey(q);
	let truncated = false;
	const cap = <T>(rows: T[], limit: number): T[] => {
		if (rows.length > limit) truncated = true;
		return rows.slice(0, limit);
	};
	if (!words.length) return { q, hits: [], truncated: false, placesLoaded: true };

	const gauges = await db.query<{ code: string; name: string; river: string; lon: number; lat: number; dataset: string }>(
		`SELECT code, name, river, lon, lat, dataset FROM gauge_station_reference
		 WHERE ($1::text IS NOT NULL AND code LIKE $1 || '%') OR ${everyWordStarts(sqlKey('name'), '$2')}
		 ORDER BY ($1::text IS NOT NULL AND code LIKE $1 || '%') DESC, ${closeness(sqlKey('name'), '$3')}, code
		 LIMIT $4`,
		[code, words, phrase, SEARCH_LAYER_LIMIT + 1]
	);
	const dams = await db.query<{ register_no: string; name: string; river: string | null; lon: number; lat: number; dataset: string }>(
		`SELECT register_no, name, river, lon, lat, dataset FROM dam_register_reference
		 WHERE ($1::text IS NOT NULL AND upper(register_no) LIKE $1 || '%') OR ${everyWordStarts(sqlKey('name'), '$2')}
		 ORDER BY ($1::text IS NOT NULL AND upper(register_no) LIKE $1 || '%') DESC, ${closeness(sqlKey('name'), '$3')}, register_no
		 LIMIT $4`,
		[code, words, phrase, SEARCH_LAYER_LIMIT + 1]
	);
	const quaternaries = code
		? await db.query<{ code: string; dataset: string; min_lon: number; min_lat: number; max_lon: number; max_lat: number }>(
				`SELECT code, dataset, min_lon, min_lat, max_lon, max_lat FROM quaternary_reference WHERE code LIKE $1 || '%' ORDER BY code LIMIT $2`,
				[code, SEARCH_LAYER_LIMIT + 1]
			)
		: { rows: [] };
	// One word-start test per word, each on its own, so every one goes through
	// the trigram index on ' ' || search_name (225): the expression must be
	// that index's. everyWordStarts' bool_and over the array would read every
	// row of the gazetteer (about 150 000 in production).
	const placeWords = words.map((_, i) => `(' ' || search_name) LIKE '% ' || $${i + 3}::text || '%'`).join(' AND ');
	const places = await db.query<{ place_id: string; name: string; feature: string; admin1: string; country: string; lon: number; lat: number; dataset: string; source: string }>(
		`SELECT place_id, name, feature, admin1, country, lon, lat, dataset, source FROM gazetteer_reference
		 WHERE ${placeWords}
		 ORDER BY ${closeness('search_name', '$1')},
			CASE split_part(feature, '.', 1) WHEN 'P' THEN 0 WHEN 'S' THEN 1 WHEN 'H' THEN 2 ELSE 3 END,
			${HOME_FIRST}, ${SEAT_RANK}, name, dataset, place_id
		 LIMIT $2`,
		[phrase, SEARCH_PLACE_LIMIT + 1, ...words]
	);

	// Only asked when no place matched: with none loaded the answer says so.
	const placesLoaded = places.rows.length > 0 || (await db.query<{ loaded: boolean }>(`SELECT EXISTS (SELECT 1 FROM gazetteer_reference) AS loaded`)).rows[0]!.loaded;

	const hits: SearchHit[] = [
		...cap(gauges.rows, SEARCH_LAYER_LIMIT).map(
			(r): SearchHit => ({ kind: 'gauge', code: r.code, name: r.name, river: r.river, feature: null, admin1: null, country: null, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: null })
		),
		...cap(dams.rows, SEARCH_LAYER_LIMIT).map(
			(r): SearchHit => ({ kind: 'dam', code: r.register_no, name: r.name, river: r.river ?? '', feature: null, admin1: null, country: null, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: null })
		),
		...cap(quaternaries.rows, SEARCH_LAYER_LIMIT).map(
			(r): SearchHit => ({
				kind: 'quaternary',
				code: r.code,
				name: '',
				river: '',
				feature: null,
				admin1: null,
				country: null,
				lon: (r.min_lon + r.max_lon) / 2,
				lat: (r.min_lat + r.max_lat) / 2,
				bbox: [r.min_lon, r.min_lat, r.max_lon, r.max_lat],
				dataset: r.dataset,
				synthetic: r.dataset === SYNTHETIC_GAZETTEER,
				source: null
			})
		),
		...cap(places.rows, SEARCH_PLACE_LIMIT).map(
			(r): SearchHit => ({ kind: 'place', code: null, name: r.name, river: '', feature: r.feature, admin1: r.admin1, country: r.country, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: r.source })
		)
	];
	return { q, hits, truncated, placesLoaded };
}
