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
// Z1H001). A place matches by its main name or by one of its alternate names
// (237: another spelling, an old name), each compared on its own. Within a
// group the closest come first: the whole name, then a name that starts with
// the words, then the rest; places then by kind and size (PLACE_ORDER).
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
	/** The place's alternate name the search matched, as GeoNames publishes it ("Tsabong" for Tshabong, 237), when it matched that more closely than the name; null otherwise and for the map's layers. */
	alias: string | null;
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
 * How closely a folded name matches: 0 the whole name, 1 a name starting with
 * the words, 2 the words elsewhere in it; 3 when `matches` is false.
 */
const closenessRank = (expr: string, phrase: string, matches = 'true') => `CASE WHEN NOT (${matches}) THEN 3 WHEN ${expr} = ${phrase} THEN 0 WHEN ${expr} LIKE ${phrase} || '%' THEN 1 ELSE 2 END`;

/**
 * The order of the places (docs/maps.md § Search, "Which comes first"), after
 * how closely the name or alternate name matches:
 *  1. kind: towns, then farms, then rivers and water, then the rest;
 *  2. a national capital (PPLC, PPLG) first, then a first-order seat (PPLA:
 *     a South African province's capital, a Botswana district's);
 *  3. the larger population (GeoNames'; 0, unknown, last);
 *  4. the lower seat of government (PPLA2 … PPLA4) before a plain place;
 *  5. South Africa's before a neighbour's (236), only now as a tiebreak;
 *  6. a match by the main name before one by an alternate name; then by name.
 * The question each answers is which place the user means: the one on the
 * basemap's label. On GeoNames' 2026-10-13 dumps 1 587 town names are shared,
 * and in 102 of them the old order (South Africa first, then the seat) listed
 * a hamlet of no recorded population first: Namibia's capital Windhoek (386 219)
 * after a Limpopo hamlet, Lesotho's capital Maseru (359 753), Botswana's Kanye
 * (a district seat, 48 028) after an Eastern Cape hamlet, and inside South
 * Africa Wellington (55 543) or Stilfontein (93 110) after a hamlet of the
 * name. Kuruman (the Northern Cape seat, 9 093) still comes before the Free
 * State hamlet, and Malmesbury's town (43 009) before its farms, by kind.
 * GeoNames gives a population for under one place in ten, but for every
 * capital and first-order seat (38 of 38) and for 179 of 209 lower seats, so
 * the seat tiers settle the places it leaves at 0.
 */
const CAPITAL_TIER = `CASE WHEN feature IN ('P.PPLC', 'P.PPLG') THEN 0 WHEN feature = 'P.PPLA' THEN 1 ELSE 2 END`;
const SEAT_RANK = `CASE feature WHEN 'P.PPLA2' THEN 2 WHEN 'P.PPLA3' THEN 3 WHEN 'P.PPLA4' THEN 4 ELSE 5 END`;
const KIND_RANK = `CASE split_part(feature, '.', 1) WHEN 'P' THEN 0 WHEN 'S' THEN 1 WHEN 'H' THEN 2 ELSE 3 END`;
const HOME_FIRST = `(country = 'ZA') DESC`;
const PLACE_ORDER = `least(main_close, alt_close), ${KIND_RANK}, ${CAPITAL_TIER}, population DESC, ${SEAT_RANK}, ${HOME_FIRST}, (alt_close < main_close), name, dataset, place_id`;

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
	// a trigram index: the main name's on ' ' || search_name (225), the
	// alternate names' on ' ' || alt_search (237); the expressions must be the
	// indexes'. The two arms make a BitmapOr on the one table, no join.
	// everyWordStarts' bool_and over the array would read every row of the
	// gazetteer (about 111 000 in production). alt_search joins every
	// alternate name, so its arm only offers rows: each alternate is checked
	// on its own (every word starts a word of that one), only on a row that
	// has alternates, and a row neither name matches is dropped. Which
	// alternate matched is looked up for the rows listed only. OFFSET 0 keeps
	// the planner from folding m into the outer query, which would work each
	// closeness out again for the filter and the sort.
	const wordsIn = (expr: string) => words.map((_, i) => `(' ' || ${expr}) LIKE '% ' || $${i + 3}::text || '%'`).join(' AND ');
	// Sequential scans are off for this one statement. Under RLS the planner
	// may not read the table's statistics for LIKE (textlike isn't
	// leakproof), so it prices every word test at a fixed 20 %, whatever the
	// word and whatever the data. For one-letter words ("k d") the trigram
	// index offers one weak trigram a word, and that blind estimate makes a
	// parallel scan of every row cost within 1 % of the index: the plan
	// flipped to the scan on a fixture change that touched no query (#570).
	// Through the index "k d" took 9 ms on 150 000 places, the parallel scan
	// 13 ms on three processes, a serial one 27 ms. The setting goes back
	// before the next statement; a query shape the index can't serve still
	// scans (the setting only prices a scan up), which the perf test's plan
	// check catches.
	const seqscan = (await db.query<{ was: string }>(`SELECT current_setting('enable_seqscan') AS was, set_config('enable_seqscan', 'off', true)`)).rows[0]!.was;
	const places = await db.query<{ place_id: string; name: string; feature: string; admin1: string; country: string; lon: number; lat: number; dataset: string; source: string; alias: string | null }>(
		`SELECT place_id, name, feature, admin1, country, lon, lat, dataset, source,
			CASE WHEN alt_close < main_close THEN (
				SELECT a.n FROM unnest(alt_names, string_to_array(alt_search, ' | ')) AS a(n, k)
				WHERE ${wordsIn('a.k')} ORDER BY ${closenessRank('a.k', '$1')}, a.n LIMIT 1
			) END AS alias
		 FROM (
			SELECT place_id, name, feature, admin1, country, lon, lat, dataset, source, population, alt_names, alt_search, main_close, alt_close
			FROM (
				SELECT g.*,
					${closenessRank('search_name', '$1', wordsIn('search_name'))} AS main_close,
					CASE WHEN alt_search = '' THEN 3 ELSE coalesce((
						SELECT min(${closenessRank('k', '$1')}) FROM unnest(string_to_array(alt_search, ' | ')) AS k WHERE ${wordsIn('k')}
					), 3) END AS alt_close
				FROM gazetteer_reference g
				WHERE (${wordsIn('search_name')}) OR (${wordsIn('alt_search')})
				OFFSET 0
			) m
			WHERE main_close < 3 OR alt_close < 3
			ORDER BY ${PLACE_ORDER}
			LIMIT $2
		 ) listed
		 ORDER BY ${PLACE_ORDER}`,
		[phrase, SEARCH_PLACE_LIMIT + 1, ...words]
	);
	await db.query(`SELECT set_config('enable_seqscan', $1, true)`, [seqscan]);

	// Only asked when no place matched: with none loaded the answer says so.
	const placesLoaded = places.rows.length > 0 || (await db.query<{ loaded: boolean }>(`SELECT EXISTS (SELECT 1 FROM gazetteer_reference) AS loaded`)).rows[0]!.loaded;

	const hits: SearchHit[] = [
		...cap(gauges.rows, SEARCH_LAYER_LIMIT).map(
			(r): SearchHit => ({ kind: 'gauge', code: r.code, name: r.name, river: r.river, feature: null, admin1: null, country: null, alias: null, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: null })
		),
		...cap(dams.rows, SEARCH_LAYER_LIMIT).map(
			(r): SearchHit => ({ kind: 'dam', code: r.register_no, name: r.name, river: r.river ?? '', feature: null, admin1: null, country: null, alias: null, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: null })
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
				alias: null,
				lon: (r.min_lon + r.max_lon) / 2,
				lat: (r.min_lat + r.max_lat) / 2,
				bbox: [r.min_lon, r.min_lat, r.max_lon, r.max_lat],
				dataset: r.dataset,
				synthetic: r.dataset === SYNTHETIC_GAZETTEER,
				source: null
			})
		),
		...cap(places.rows, SEARCH_PLACE_LIMIT).map(
			(r): SearchHit => ({ kind: 'place', code: null, name: r.name, river: '', feature: r.feature, admin1: r.admin1, country: r.country, alias: r.alias, lon: r.lon, lat: r.lat, bbox: null, dataset: r.dataset, synthetic: r.dataset === SYNTHETIC_GAZETTEER, source: r.source })
		)
	];
	return { q, hits, truncated, placesLoaded };
}
