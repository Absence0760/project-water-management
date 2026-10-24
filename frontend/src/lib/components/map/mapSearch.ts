// The Map's search box in words (issue #523 C5; docs/maps.md § Search,
// docs/ui.md § Map): what each match is, where it is, how far the map zooms
// to it, and the credits a list of places carries. The search itself is the
// backend's (GET …/map/search, our own reference tables only).
import type { MapSearchHit } from '#lib/api/types.js';

/** South Africa's provinces by GeoNames' admin1 code (admin1CodesASCII.txt, ZA.*). */
export const ZA_PROVINCES: Readonly<Record<string, string>> = {
	'02': 'KwaZulu-Natal',
	'03': 'Free State',
	'05': 'Eastern Cape',
	'06': 'Gauteng',
	'07': 'Mpumalanga',
	'08': 'Northern Cape',
	'09': 'Limpopo',
	'10': 'North West',
	'11': 'Western Cape'
};

/** South Africa's neighbours the gazetteer loads, by GeoNames' country code (the backend's GAZETTEER_COUNTRIES; docs/maps.md § Gazetteer). */
export const NEIGHBOURS: Readonly<Record<string, string>> = {
	BW: 'Botswana',
	LS: 'Lesotho',
	MZ: 'Mozambique',
	NA: 'Namibia',
	SZ: 'Eswatini',
	ZW: 'Zimbabwe'
};

/** A place over the border: one with a country that isn't South Africa's. */
const abroad = (h: MapSearchHit): boolean => h.kind === 'place' && !!h.country && h.country !== 'ZA';

/** What a gazetteer place is, from its GeoNames feature class and code. */
export function placeWord(feature: string | null): string {
	const [cls, code = ''] = (feature ?? '').split('.');
	if (cls === 'P') return 'Town or settlement';
	if (cls === 'S') return 'Farm';
	if (cls === 'H') {
		if (code === 'STM' || code === 'STMI' || code === 'STMS') return 'River';
		if (code === 'RSV' || code === 'DAM') return 'Dam';
		if (code === 'PAN' || code === 'PANS') return 'Pan';
		return 'Water feature';
	}
	if (cls === 'T') return 'Peak or hill';
	if (cls === 'A') return 'Administrative area';
	return 'Area';
}

/**
 * A match's name as listed: the place's or station's name, the dam's, or the
 * quaternary's code; a place found by another of its names with the one typed
 * ("Tshabong (also Tsabong)", "Polokwane (also Pietersburg)"), so the list
 * says why the name differs; a place over the border with its country
 * ("Lobatse, Botswana").
 */
export function hitName(h: MapSearchHit): string {
	if (h.kind === 'quaternary') return `Quaternary ${h.code}`;
	const named = h.name || h.code || 'Unnamed';
	const name = h.kind === 'place' && h.alias ? `${named} (also ${h.alias})` : named;
	return abroad(h) ? `${name}, ${NEIGHBOURS[h.country!] ?? h.country}` : name;
}

/** What and where, after the name: "Gauging station Z1H001 · Sandspruit", "Farm · Western Cape" (a province for South Africa's places only: a neighbour's admin1 code is its own country's); "(sample)" for the invented datasets. */
export function hitDetail(h: MapSearchHit): string {
	const parts: string[] = [];
	if (h.kind === 'gauge') parts.push(`Gauging station ${h.code}`);
	else if (h.kind === 'dam') parts.push(`Registered dam ${h.code}`);
	else if (h.kind === 'quaternary') parts.push('Quaternary catchment');
	else parts.push(placeWord(h.feature));
	if (h.river) parts.push(h.river);
	if (h.kind === 'place' && !abroad(h) && h.admin1 && ZA_PROVINCES[h.admin1]) parts.push(ZA_PROVINCES[h.admin1]!);
	return `${parts.join(' · ')}${h.synthetic ? ' (sample)' : ''}`;
}

/** Where the view goes: a quaternary's box, else the point; and the closest zoom (a town wants more around it than a gauge). */
export function frameFor(h: MapSearchHit): { bbox: [number, number, number, number]; maxZoom: number } {
	if (h.bbox) return { bbox: h.bbox, maxZoom: 12 };
	return { bbox: [h.lon, h.lat, h.lon, h.lat], maxZoom: h.kind === 'place' ? 13 : 14 };
}

/** The places' credits, each once, in the order listed (GeoNames' CC BY 4.0 attribution; the synthetic places' "SYNTHETIC" line). */
export function placeCredits(hits: readonly MapSearchHit[]): { source: string; synthetic: boolean }[] {
	const seen = new Map<string, boolean>();
	for (const h of hits) if (h.kind === 'place' && h.source && !seen.has(h.source)) seen.set(h.source, h.synthetic);
	return [...seen].map(([source, synthetic]) => ({ source, synthetic }));
}

/** The live line after a search: how many matched, or that nothing did (and, with no place names loaded, that a town can't be found yet). */
export function resultLine(q: string, hits: readonly MapSearchHit[], truncated: boolean, placesLoaded: boolean): string {
	if (!hits.length && !placesLoaded)
		return `Nothing found for “${q}”. No town, farm or river names are loaded on this site yet, so only gauge codes, dams’ names and quaternaries can be found.`;
	if (!hits.length) return `Nothing found for “${q}”. Try a town, farm or river name, a gauge code (A2H012), a dam’s name or a quaternary (A21A).`;
	const n = `${hits.length} match${hits.length === 1 ? '' : 'es'} for “${q}”`;
	return truncated ? `${n}; more match, so type more to narrow it.` : `${n}.`;
}
