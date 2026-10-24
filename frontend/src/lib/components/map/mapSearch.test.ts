// The Map's search in words (mapSearch.ts; issue #523 C5): each match's name
// and detail, the view it moves to, and the places' credits.
import { describe, expect, it } from 'vitest';
import type { MapSearchHit } from '#lib/api/types.js';
import { frameFor, hitDetail, hitName, placeCredits, placeWord, resultLine } from './mapSearch';

const hit = (h: Partial<MapSearchHit>): MapSearchHit => ({
	kind: 'place',
	code: null,
	name: 'Kwartsvallei',
	river: '',
	feature: 'P.PPL',
	admin1: '11',
	country: 'ZA',
	alias: null,
	lon: 20.74,
	lat: -33.54,
	bbox: null,
	dataset: 'GeoNames-ZA',
	synthetic: false,
	source: 'GeoNames (geonames.org), CC BY 4.0',
	...h
});

describe('a match in words', () => {
	it('names what it is and where: a gauge, a registered dam, a quaternary, a place in its province', () => {
		const gauge = hit({ kind: 'gauge', code: 'Z1H002', name: 'Wilgerivier @ Bosrand', river: 'Wilgerivier', feature: null, admin1: null, country: null, source: null, synthetic: true });
		expect([hitName(gauge), hitDetail(gauge)]).toEqual(['Wilgerivier @ Bosrand', 'Gauging station Z1H002 · Wilgerivier (sample)']);
		const dam = hit({ kind: 'dam', code: 'Z100/05', name: 'Bosrand Dam', river: '', feature: null, admin1: null, source: null });
		expect([hitName(dam), hitDetail(dam)]).toEqual(['Bosrand Dam', 'Registered dam Z100/05']);
		const q = hit({ kind: 'quaternary', code: 'Z01A', name: '', feature: null, admin1: null, source: null, bbox: [21, -34, 21.3, -33.7] });
		expect([hitName(q), hitDetail(q)]).toEqual(['Quaternary Z01A', 'Quaternary catchment']);
		expect(hitDetail(hit({}))).toBe('Town or settlement · Western Cape');
		// An unknown province code says nothing rather than something wrong.
		expect(hitDetail(hit({ admin1: '99', feature: 'S.FRM' }))).toBe('Farm');
	});

	it('a place over the border names its country, and never a South African province for its admin1 code', () => {
		// Botswana's admin1 08 is no Northern Cape.
		const lobatse = hit({ name: 'Lobatse', country: 'BW', admin1: '08' });
		expect([hitName(lobatse), hitDetail(lobatse)]).toEqual(['Lobatse, Botswana', 'Town or settlement']);
		for (const [cc, country] of [['NA', 'Namibia'], ['LS', 'Lesotho'], ['SZ', 'Eswatini'], ['ZW', 'Zimbabwe'], ['MZ', 'Mozambique']]) expect(hitName(hit({ name: 'X', country: cc }))).toBe(`X, ${country}`);
		// South Africa's own places stay as they were.
		expect([hitName(hit({})), hitDetail(hit({}))]).toEqual(['Kwartsvallei', 'Town or settlement · Western Cape']);
		// A code the app has no name for still says it's elsewhere.
		expect(hitName(hit({ name: 'Y', country: 'KE' }))).toBe('Y, KE');
	});

	it('a place found by another of its names lists its name with the one matched (the basemap’s "Tsabong" is GeoNames’ Tshabong, 237)', () => {
		expect(hitName(hit({ name: 'Tshabong', alias: 'Tsabong', country: 'BW', admin1: '04' }))).toBe('Tshabong (also Tsabong), Botswana');
		const polokwane = hit({ name: 'Polokwane', alias: 'Pietersburg', admin1: '09' });
		expect([hitName(polokwane), hitDetail(polokwane)]).toEqual(['Polokwane (also Pietersburg)', 'Town or settlement · Limpopo']);
		// Found by its name: no "also".
		expect(hitName(hit({ name: 'Tshabong', alias: null, country: 'BW' }))).toBe('Tshabong, Botswana');
	});

	it('words the GeoNames feature classes a catchment is found by', () => {
		expect(placeWord('H.STM')).toBe('River');
		expect(placeWord('H.RSV')).toBe('Dam');
		expect(placeWord('H.PAN')).toBe('Pan');
		expect(placeWord('H.SPNG')).toBe('Water feature');
		expect(placeWord('T.MT')).toBe('Peak or hill');
		expect(placeWord('L.AREA')).toBe('Area');
		expect(placeWord('A.ADM2')).toBe('Administrative area');
	});
});

describe('where the view goes', () => {
	it('a quaternary’s box; a point closer for a gauge or dam than for a place', () => {
		expect(frameFor(hit({ kind: 'quaternary', bbox: [21, -34, 21.3, -33.7] }))).toEqual({ bbox: [21, -34, 21.3, -33.7], maxZoom: 12 });
		expect(frameFor(hit({}))).toEqual({ bbox: [20.74, -33.54, 20.74, -33.54], maxZoom: 13 });
		expect(frameFor(hit({ kind: 'gauge' })).maxZoom).toBe(14);
	});
});

describe('the credits and the live line', () => {
	it('credits each places’ source once; the map’s layers carry none', () => {
		const hits = [hit({}), hit({ name: 'Other' }), hit({ kind: 'gauge', source: null }), hit({ source: 'SYNTHETIC test data', synthetic: true })];
		expect(placeCredits(hits)).toEqual([
			{ source: 'GeoNames (geonames.org), CC BY 4.0', synthetic: false },
			{ source: 'SYNTHETIC test data', synthetic: true }
		]);
		expect(placeCredits([hit({ kind: 'dam', source: null })])).toEqual([]);
	});

	it('says how many matched, that more did, or what to try', () => {
		expect(resultLine('kw', [hit({}), hit({})], false, true)).toBe('2 matches for “kw”.');
		expect(resultLine('kw', [hit({})], true, true)).toBe('1 match for “kw”; more match, so type more to narrow it.');
		expect(resultLine('zz', [], false, true)).toMatch(/^Nothing found for “zz”\. Try/);
	});

	it('with no place names loaded, says so rather than suggest a town (production before its gazetteer load)', () => {
		expect(resultLine('Malmesbury', [], false, false)).toBe(
			'Nothing found for “Malmesbury”. No town, farm or river names are loaded on this site yet, so only gauge codes, dams’ names and quaternaries can be found.'
		);
	});
});
