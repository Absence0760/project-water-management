// The Map's search without a database (issue #523 C5; docs/maps.md § Search):
// how a name and a query are folded (searchKey: never a LIKE wildcard), the
// codes it tries, the route's query check, the GeoNames dump parser over the
// committed synthetic fixture, and the import's arguments.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_GAZETTEER_FILE, SYNTHETIC_GAZETTEER_SOURCE } from '../../scripts/import-gazetteer.js';
import { codeKey, GEONAMES_SOURCE, searchKey, searchWords, SYNTHETIC_GAZETTEER } from './gazetteer.js';
import { GAZETTEER_COUNTRIES, keepsFeature, NEIGHBOUR_BBOX, placeRecords } from './loadGazetteer.js';
import { SearchQuery } from './searchRoutes.js';

const line = (cols: Partial<Record<number, string>>) => {
	const base = ['1', 'Name', 'Name', '', '-33.5', '20.7', 'P', 'PPL', 'ZA', '', '11', '', '', '', '0', '', '0', 'Africa/Johannesburg', '2026-10-12'];
	for (const [i, v] of Object.entries(cols)) base[Number(i)] = v!;
	return base.join('\t');
};

describe('searchKey and searchWords', () => {
	it('folds case, accents and punctuation, one space between words', () => {
		expect(searchKey('  Môrester  ')).toBe('morester');
		expect(searchKey('Sandlaagte-Oos')).toBe('sandlaagte oos');
		expect(searchKey('Wilgerivier @ Bosrand')).toBe('wilgerivier bosrand');
		expect(searchKey("Gouda's Drift (Noord)")).toBe('gouda s drift noord');
	});

	it('never leaves a LIKE wildcard or a backslash in a word', () => {
		for (const q of ['100%', 'a_b', 'x\\y', '%_%', "o'; DROP TABLE x; --"]) {
			for (const w of searchWords(q)) expect(w).toMatch(/^[\p{L}\p{N}]+$/u);
		}
		expect(searchWords('%_%')).toEqual([]);
	});

	it('keeps each word once, at most six', () => {
		expect(searchWords('a a b')).toEqual(['a', 'b']);
		expect(searchWords('a b c d e f g h')).toHaveLength(6);
	});
});

describe('codeKey', () => {
	it('upper-cases and drops spaces; null when it can’t be a code', () => {
		expect(codeKey('z1h 003')).toBe('Z1H003');
		expect(codeKey('Z100/01')).toBe('Z100/01');
		expect(codeKey('a%')).toBeNull();
		expect(codeKey('a_b')).toBeNull();
		expect(codeKey('/x')).toBeNull();
	});
});

describe('the route’s query', () => {
	it('takes 2 to 100 characters with a letter or digit, trimmed; nothing else', () => {
		expect(SearchQuery.parse({ q: '  Kwarts ' })).toEqual({ q: 'Kwarts' });
		for (const q of ['', 'k', ' k ', 'x'.repeat(101), '%%', '--']) expect(SearchQuery.safeParse({ q }).success, JSON.stringify(q)).toBe(false);
		expect(SearchQuery.safeParse({ q: 'ab', near: '1' }).success).toBe(false);
	});
});

describe('the GeoNames dump parser', () => {
	it('keeps towns, farms, rivers, areas and peaks; leaves out roads, schools and the like', () => {
		expect(keepsFeature('P', 'PPL')).toBe(true);
		expect(keepsFeature('S', 'FRM')).toBe(true);
		expect(keepsFeature('H', 'STM')).toBe(true);
		expect(keepsFeature('S', 'SCH')).toBe(false);
		expect(keepsFeature('R', 'RD')).toBe(false);
		expect(keepsFeature('V', 'FRST')).toBe(false);
	});

	it('reads a line, folds its name for the search, and says why it skipped one', () => {
		const text = [
			line({ 0: '10', 1: 'Môrester' }),
			line({ 0: '11', 4: '', 5: '' }),
			line({ 0: '12', 4: '-95' }),
			line({ 0: 'x y' }),
			line({ 0: '13', 6: 'S', 7: 'SCH' }),
			line({ 0: '10', 1: 'Again' }),
			'14\tShort',
			'# a comment',
			''
		].join('\n');
		const { records, problems, leftOut } = placeRecords(text, 'za.txt', 'src');
		expect(records).toEqual([{ placeId: '10', name: 'Môrester', searchName: 'morester', feature: 'P.PPL', admin1: '11', country: 'ZA', lon: 20.7, lat: -33.5, source: 'src' }]);
		expect(leftOut).toBe(1);
		expect(problems).toEqual([
			'za.txt line 2 (11): no position in WGS84 degrees',
			'za.txt line 3 (12): no position in WGS84 degrees',
			'za.txt line 4: "x y" is not a place id',
			'za.txt line 6: 10 appears twice',
			'za.txt line 7: 2 columns, not GeoNames\' 19'
		]);
	});

	it('leaves out a place of a country not on the list (Kenya, none, a lower-case code), counted apart, not as a problem', () => {
		const text = [line({ 0: '30', 1: 'Binne' }), line({ 0: '31', 1: 'Nairobi', 8: 'KE' }), line({ 0: '32', 1: 'Nowhere', 8: '' }), line({ 0: '33', 1: 'Lower', 8: 'za' }), line({ 0: '34', 1: 'Lower', 8: 'bw' })].join('\n');
		const { records, problems, leftOut, otherCountry } = placeRecords(text, 'all.txt', 'src');
		expect(records.map((r) => r.placeId)).toEqual(['30']);
		expect(otherCountry).toBe(4);
		expect(leftOut).toBe(0);
		expect(problems).toEqual([]);
	});

	it('strips control characters from a name (the table refuses them)', () => {
		const { records } = placeRecords(line({ 0: '20', 1: 'Twee\u0007Riviere' }), 'za.txt', 'src');
		expect(records[0]!.name).toBe('Twee Riviere');
	});
});

describe('South Africa’s neighbours (the basemap labels Kanye, Lobatse and Gaborone over the border; ad hoc testing 2026-10-13)', () => {
	it('allows South Africa and the six countries on its border, nothing else', () => {
		expect([...GAZETTEER_COUNTRIES].sort()).toEqual(['BW', 'LS', 'MZ', 'NA', 'SZ', 'ZA', 'ZW']);
		// The basemap's extent (bin/tiles-dev.sh TILES_BBOX's default): a neighbour's place past it would move the view off the map.
		expect(NEIGHBOUR_BBOX).toEqual([16.3, -35.0, 33.0, -22.0]);
	});

	it('keeps a neighbour’s place on the basemap with its country, leaves out one past its edge (counted), and keeps South Africa whole', () => {
		const text = [
			line({ 0: '40', 1: 'Binne' }),
			line({ 0: '41', 1: 'Lobatse', 4: '-25.22', 5: '25.68', 8: 'BW', 10: '09' }),
			line({ 0: '42', 1: 'Maseru', 4: '-29.32', 5: '27.48', 8: 'LS', 10: '14' }),
			line({ 0: '43', 1: 'Francistown', 4: '-21.17', 5: '27.51', 8: 'BW' }),
			line({ 0: '44', 1: 'Nampula', 4: '-15.1', 5: '39.3', 8: 'MZ' }),
			line({ 0: '45', 1: 'Grensdorp', 4: '-22.0', 5: '33.0', 8: 'ZW' }),
			line({ 0: '46', 1: 'Eiland', 4: '-46.9', 5: '37.7' })
		].join('\n');
		const got = placeRecords(text, 'neighbours.txt', 'src');
		expect(got.records.map((r) => `${r.placeId} ${r.country}`)).toEqual(['40 ZA', '41 BW', '42 LS', '45 ZW', '46 ZA']);
		expect(got.outsideMap).toBe(2);
		expect(got.otherCountry).toBe(0);
		expect(got.countries).toEqual({ ZA: 2, BW: 1, LS: 1, ZW: 1 });
		expect(got.problems).toEqual([]);
	});

	it('several files share one check for a place id seen twice', () => {
		const seen = new Set<string>();
		expect(placeRecords(line({ 0: '50' }), 'za.txt', 'src', seen).records).toHaveLength(1);
		const second = placeRecords([line({ 0: '50', 8: 'BW', 4: '-25', 5: '25' }), line({ 0: '51', 8: 'BW', 4: '-25', 5: '25' })].join('\n'), 'bw.txt', 'src', seen);
		expect(second.records.map((r) => r.placeId)).toEqual(['51']);
		expect(second.problems).toEqual(['bw.txt line 1: 50 appears twice']);
	});
});

describe('the committed synthetic gazetteer', () => {
	const { records, problems, leftOut, otherCountry } = placeRecords(readFileSync(SYNTHETIC_GAZETTEER_FILE, 'utf8'), 'fixture', SYNTHETIC_GAZETTEER_SOURCE);

	it('parses whole, every place invented and marked so; the school and the railway left out', () => {
		expect(problems).toEqual([]);
		expect(leftOut).toBe(2);
		expect(otherCountry).toBe(0);
		expect(records.length).toBe(9);
		for (const r of records) expect(r.placeId).toMatch(/^9\d{6}$/);
		expect(SYNTHETIC_GAZETTEER_SOURCE).toMatch(/^SYNTHETIC/);
	});

	it('puts Kwartsvallei on the synthetic DEM’s outlet, where the e2e find-then-start delineates from (within 10 m)', () => {
		// Read as text, as delineate.test.ts does: e2e/support/dem.ts is outside the backend's compilation.
		const dem = readFileSync(new URL('../../../e2e/support/dem.ts', import.meta.url), 'utf8');
		const m = /FIXTURE_OUTLET: \[number, number\] = \[([-\d.]+), ([-\d.]+)\]/.exec(dem)!;
		const FIXTURE_OUTLET = [Number(m[1]), Number(m[2])] as const;
		const k = records.find((r) => r.name === 'Kwartsvallei')!;
		expect(Math.abs(k.lon - FIXTURE_OUTLET[0]) * 93_000).toBeLessThan(10);
		expect(Math.abs(k.lat - FIXTURE_OUTLET[1]) * 111_000).toBeLessThan(10);
	});
});

describe('pnpm import:gazetteer arguments', () => {
	it('with none, the committed fixture under its label', () => {
		expect(parseArgs([])).toEqual({ files: [SYNTHETIC_GAZETTEER_FILE], dataset: SYNTHETIC_GAZETTEER, source: SYNTHETIC_GAZETTEER_SOURCE });
	});

	it('a file needs a label; the source defaults to GeoNames’ attribution; paths resolve from where the command was typed', () => {
		expect(parseArgs(['ZA.txt'])).toMatch(/--dataset/);
		expect(parseArgs(['ZA.txt', '--dataset', SYNTHETIC_GAZETTEER])).toMatch(/fixture/);
		expect(parseArgs(['ZA.txt', '--dataset', 'GeoNames-ZA'], { INIT_CWD: '/data' })).toEqual({ files: ['/data/ZA.txt'], dataset: 'GeoNames-ZA', source: GEONAMES_SOURCE });
		expect(parseArgs(['ZA.txt', '--dataset', 'G', '--source', 'Mine'], { INIT_CWD: '/data' })).toMatchObject({ source: 'Mine' });
	});

	it('several dumps load as one dataset (South Africa and its neighbours); the same file twice is refused', () => {
		expect(parseArgs(['ZA.txt', 'BW.txt.gz', '--dataset', 'GeoNames-2026-10', 'LS.txt'], { INIT_CWD: '/data' })).toEqual({
			files: ['/data/ZA.txt', '/data/BW.txt.gz', '/data/LS.txt'],
			dataset: 'GeoNames-2026-10',
			source: GEONAMES_SOURCE
		});
		expect(parseArgs(['BW.txt', './BW.txt', '--dataset', 'x'], { INIT_CWD: '/data' })).toMatch(/twice/);
	});
});
