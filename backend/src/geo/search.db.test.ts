// GET /projects/:id/map/search (issue #523 C5; docs/api.md § Catchment map,
// docs/maps.md § Search) over the committed synthetic datasets: the map's
// own layers first (gauges, the register's dams, quaternaries), then the
// gazetteer (225), each place with its credit. A viewer reads it (positive
// control); a farmer gets 403, a stranger 404, a signed-out caller 401;
// water_app can't write the gazetteer; a load replaces its dataset and
// records nothing of a local import in reference_load.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importGaugeStations, parseArgs as stationArgs } from '../../scripts/import-gauge-stations.js';
import { importGazetteer, parseArgs as gazetteerArgs } from '../../scripts/import-gazetteer.js';
import { importQuaternaries, parseArgs as quaternaryArgs } from '../../scripts/import-quaternaries.js';
import { loadSyntheticDamRegister } from '../../scripts/import-dam-register.js';
import { anon, asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SEARCH_LAYER_LIMIT, searchMap } from './gazetteer.js';
import { placeRecords, replacePlaces } from './loadGazetteer.js';
import type { SearchHit } from './gazetteer.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
const outlet = node('Outlet', null);
const farm = node('Farm A', outlet.id);
const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;
const search = (u: User, q: string, id = projectId) => u.call('GET', `/projects/${id}/map/search?${new URLSearchParams({ q })}`);
const hitsOf = (body: { hits: SearchHit[] }) => body.hits.map((h) => `${h.kind}:${h.code ?? h.name}`);

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['Qowner', 'Qviewer', 'Qfarmer', 'Qstranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Search' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const quaternaries = quaternaryArgs([]);
	const stations = stationArgs([]);
	const places = gazetteerArgs([]);
	if (typeof quaternaries === 'string' || typeof stations === 'string' || typeof places === 'string') throw new Error('fixture args');
	await importQuaternaries(OWNER_URL(), quaternaries);
	await importGaugeStations(OWNER_URL(), stations);
	await loadSyntheticDamRegister(OWNER_URL());
	await importGazetteer(OWNER_URL(), places);
}, 60_000);

describe('who may search', () => {
	it('a viewer may (positive control); a farmer gets 403, a stranger 404, no session 401', async () => {
		const ok = await search(viewer, 'Kwartsvallei');
		expect(ok.status).toBe(200);
		expect(ok.body.hits.length).toBeGreaterThan(0);
		expect((await search(farmer, 'Kwartsvallei')).status).toBe(403);
		expect((await search(stranger, 'Kwartsvallei')).status).toBe(404);
		expect((await anon('GET', `/projects/${projectId}/map/search?q=Kwartsvallei`)).status).toBe(401);
	});

	it('refuses a query too short, too long, of no letters or digits, or with other parameters (400)', async () => {
		for (const q of ['', ' k ', 'x'.repeat(101), '%%', '__']) expect((await search(viewer, q)).status, JSON.stringify(q)).toBe(400);
		expect((await viewer.call('GET', `/projects/${projectId}/map/search`)).status).toBe(400);
		expect((await viewer.call('GET', `/projects/${projectId}/map/search?q=Kwarts&near=1`)).status).toBe(400);
	});
});

describe('what a search finds', () => {
	it('lists the map’s layers before the gazetteer: a gauge and a registered dam named Bosrand, then nothing else', async () => {
		const res = await search(viewer, 'bosrand');
		expect(hitsOf(res.body)).toEqual(['gauge:Z1H002', 'dam:Z100/05']);
		expect(res.body.hits[0]).toMatchObject({ name: 'Wilgerivier @ Bosrand', river: 'Wilgerivier', synthetic: true, source: null, bbox: null, lon: 21.29, lat: -33.665 });
		expect(res.body.hits[1]).toMatchObject({ name: 'Bosrand Dam', river: 'Wilgerivier', synthetic: true });
	});

	it('matches the start of any word, every word typed, case and accents ignored, the closest first', async () => {
		// "vaalbank": the name that starts with it first, then the one with it as a later word.
		expect(hitsOf((await search(viewer, 'VAALBANK')).body)).toEqual(['dam:Z100/03', 'dam:Z100/04']);
		// Both words must start a word: "klein vaal" finds Klein Vaalbank Dam only.
		expect(hitsOf((await search(viewer, 'klein vaal')).body)).toEqual(['dam:Z100/04']);
		// A word's middle doesn't match ("aalbank").
		expect((await search(viewer, 'aalbank')).body.hits).toEqual([]);
		// Accents and punctuation folded both ways: "morester" finds Môrester, "sandlaagte oos" Sandlaagte-Oos.
		expect(hitsOf((await search(viewer, 'morester')).body)).toEqual(['place:Môrester']);
		expect(hitsOf((await search(viewer, 'Sandlaagte oos')).body)).toEqual(['place:Sandlaagte-Oos']);
	});

	it('folds a station’s or dam’s accents in SQL as the gazetteer’s are folded at load', async () => {
		await asOwner(`INSERT INTO gauge_station_reference (code, name, river, lon, lat, dataset, source) VALUES ('Z9H901', 'Môrester @ Kloof', 'Kloof', 21.4, -33.7, 'search-test', 'Test')`);
		try {
			expect(hitsOf((await search(viewer, 'morester')).body)).toEqual(['gauge:Z9H901', 'place:Môrester']);
			expect(hitsOf((await search(viewer, 'MÔRESTER kloof')).body)).toEqual(['gauge:Z9H901']);
		} finally {
			await asOwner(`DELETE FROM gauge_station_reference WHERE dataset = 'search-test'`);
		}
	});

	it('finds codes from their start, spaces ignored: gauges, register numbers and quaternaries (with their box)', async () => {
		// Six stations' codes start Z1 (five river gauges and a reservoir), and eight register numbers (Z100/…): five of each listed.
		const z1 = await search(viewer, 'z1');
		expect(z1.body.hits.map((h: SearchHit) => h.kind)).toEqual([...Array(SEARCH_LAYER_LIMIT).fill('gauge'), ...Array(SEARCH_LAYER_LIMIT).fill('dam')]);
		expect(z1.body.truncated).toBe(true);
		expect(hitsOf((await search(viewer, 'Z1H 003')).body)).toEqual(['gauge:Z1H003']);
		expect(hitsOf((await search(viewer, 'z100/0')).body)).toEqual(['dam:Z100/01', 'dam:Z100/02', 'dam:Z100/03', 'dam:Z100/04', 'dam:Z100/05']);
		const q = await search(viewer, 'Z01');
		expect(hitsOf(q.body)).toEqual(['quaternary:Z01A', 'quaternary:Z01B', 'quaternary:Z01C']);
		const [w, s, e, n] = q.body.hits[0].bbox as number[];
		expect(w).toBeLessThan(e!);
		expect(s).toBeLessThan(n!);
		expect(q.body.hits[0].lon).toBeCloseTo((w! + e!) / 2, 9);
		expect(q.body.truncated).toBe(false);
	});

	it('lists places after the layers: towns before farms before rivers among equals, each with its feature, province and credit', async () => {
		const res = await search(viewer, 'kwartsvallei');
		expect(hitsOf(res.body)).toEqual(['place:Kwartsvallei', 'place:Kwartsvallei 12', 'place:Kwartsvalleirivier']);
		expect(res.body.hits[0]).toMatchObject({ kind: 'place', code: null, feature: 'P.PPL', admin1: '11', lon: 20.74287, lat: -33.53968, synthetic: true, source: expect.stringMatching(/^SYNTHETIC/) });
		expect(res.body.hits[1].feature).toBe('S.FRM');
		// The school and the railway are left out by the loader.
		expect((await search(viewer, 'kwartsvallei skool')).body.hits).toEqual([]);
		// "sand": the gauges on the Sandspruit first, then the places.
		expect(hitsOf((await search(viewer, 'sand')).body)).toEqual(['gauge:Z1H001', 'gauge:Z1H003', 'place:Sandlaagte', 'place:Sandlaagte-Oos']);
	});
});

describe('a town on the map is found (production searched an empty gazetteer, 2026-10-13)', () => {
	// SYNTHETIC lines in GeoNames' dump format, named after real towns the
	// basemap labels: the feature codes and provinces follow GeoNames' ZA dump
	// (Malmesbury a PPLA3 in the Western Cape with farms of the same name in
	// Limpopo; Kuruman a PPLA2 in the Northern Cape and a small PPL in the Free
	// State), but the ids and positions are made up.
	const line = (id: string, name: string, cls: string, code: string, admin1: string, lat: number, lon: number, pop = 0) =>
		[id, name, name, '', String(lat), String(lon), cls, code, 'ZA', '', admin1, '', '', '', String(pop), '', '0', 'Africa/Johannesburg', '2026-10-13'].join('\t');
	const dump = [
		line('9100001', 'Malmesbury', 'S', 'FRM', '09', -24.9, 28.5),
		line('9100002', 'Malmesbury', 'S', 'FRM', '09', -23.9, 27.2),
		line('9100003', 'Malmesbury', 'P', 'PPLA3', '11', -33.5, 18.7, 43009),
		line('9100004', 'Kuruman', 'P', 'PPL', '03', -29.9, 27.0),
		line('9100005', 'Kuruman', 'P', 'PPLA2', '08', -27.5, 23.4, 9093),
		line('9100006', 'Kuruman', 'S', 'AIRF', '08', -27.4, 23.5)
	].join('\n');

	it('a loaded dump finds the town first: a town before farms of its name, a seat of local government before a hamlet', async () => {
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			const got = placeRecords(dump, 'za.txt', 'Test source');
			expect(got.leftOut).toBe(1); // the airfield
			await replacePlaces(client, 'town-test', got.records);
			const malmesbury = (await search(viewer, 'Malmesbury')).body;
			expect(malmesbury.hits.map((h: SearchHit) => `${h.feature} ${h.admin1}`)).toEqual(['P.PPLA3 11', 'S.FRM 09', 'S.FRM 09']);
			expect(malmesbury.placesLoaded).toBe(true);
			const kuruman = (await search(viewer, 'kuruman')).body;
			expect(kuruman.hits.map((h: SearchHit) => `${h.feature} ${h.admin1}`)).toEqual(['P.PPLA2 08', 'P.PPL 03']);
		} finally {
			await client.query(`DELETE FROM gazetteer_reference WHERE dataset = 'town-test'`);
			await client.end();
		}
	});

	it('says when no gazetteer is loaded, so an empty answer is not read as "no such town"', async () => {
		const pool = new pg.Pool({ connectionString: OWNER_URL(), max: 1 });
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query('DELETE FROM gazetteer_reference');
			expect(await searchMap(client, 'Malmesbury')).toEqual({ q: 'Malmesbury', hits: [], truncated: false, placesLoaded: false });
			await client.query('ROLLBACK');
			// Positive control: with the synthetic places back, the flag is set even when nothing matches.
			expect((await search(viewer, 'zzqx')).body).toMatchObject({ hits: [], placesLoaded: true });
		} finally {
			client.release();
			await pool.end();
		}
	});
});

describe('towns over the border (the basemap labels Kanye, Lobatse and Gaborone in Botswana; ad hoc testing 2026-10-13)', () => {
	// SYNTHETIC lines in GeoNames' dump format, one file per country as GeoNames
	// publishes them. Kanye is a real name in both countries (a Botswana district
	// seat, an Eastern Cape hamlet), which is the case the ranking decides; the
	// ids, positions and the other names are made up.
	const line = (id: string, name: string, cls: string, code: string, cc: string, admin1: string, lat: number, lon: number, pop = 0) =>
		[id, name, name, '', String(lat), String(lon), cls, code, cc, '', admin1, '', '', '', String(pop), '', '0', 'Africa/Johannesburg', '2026-10-13'].join('\t');
	const za = [line('9200001', 'Kanye', 'P', 'PPL', 'ZA', '05', -31.6, 28.0), line('9200002', 'Grensbult', 'P', 'PPL', 'ZA', '10', -25.8, 25.6)].join('\n');
	const bw = [
		line('9200101', 'Kanye', 'P', 'PPLA', 'BW', '09', -24.97, 25.33, 48028),
		line('9200102', 'Lobatse', 'P', 'PPL', 'BW', '09', -25.22, 25.68),
		// Grensbult: a town of the name on each side, neither a seat, no population: the true tie South Africa's wins.
		line('9200103', 'Grensbult', 'P', 'PPL', 'BW', '09', -25.0, 25.5),
		// North of the basemap: nothing to show it on, so left out.
		line('9200104', 'Grensbult Noord', 'P', 'PPL', 'BW', '01', -21.2, 27.5)
	].join('\n');
	const ke = line('9200201', 'Grensbult Kenia', 'P', 'PPL', 'KE', '05', -1.3, 36.8);
	let dir: string;
	const file = (name: string, text: string) => {
		const p = join(dir, name);
		writeFileSync(p, text);
		return p;
	};
	const countriesOf = (body: { hits: SearchHit[] }) => body.hits.map((h) => `${h.name} ${h.country}`);

	it('South Africa’s and Botswana’s dumps load as one dataset: both found, the larger town first on a shared name, South Africa’s on a tie, the country on every place', async () => {
		dir = mkdtempSync(join(tmpdir(), 'gazetteer-border-'));
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			const got = await importGazetteer(OWNER_URL(), { files: [file('ZA.txt', za), file('BW.txt', bw)], dataset: 'border-test', source: 'Test source' });
			expect(got).toMatchObject({ written: 5, outsideMap: 1, otherCountry: 0, countries: { ZA: 2, BW: 3 } });
			expect(countriesOf((await search(viewer, 'Lobatse')).body)).toEqual(['Lobatse BW']);
			// Botswana's Kanye is a district seat (PPLA) of 48 028, the Eastern Cape's a hamlet of no recorded population (PPL): Botswana's, on the basemap's label, first (237). Grensbult ties: South Africa's first.
			expect(countriesOf((await search(viewer, 'Kanye')).body)).toEqual(['Kanye BW', 'Kanye ZA']);
			expect(countriesOf((await search(viewer, 'Grensbult')).body)).toEqual(['Grensbult ZA', 'Grensbult BW']);
		} finally {
			await client.query(`DELETE FROM gazetteer_reference WHERE dataset = 'border-test'`);
			await client.end();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a neighbour loaded as its own dataset sits beside South Africa’s, and reloading it leaves South Africa’s alone', async () => {
		dir = mkdtempSync(join(tmpdir(), 'gazetteer-border-'));
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			await importGazetteer(OWNER_URL(), { files: [file('ZA.txt', za)], dataset: 'border-za', source: 'Test source' });
			await importGazetteer(OWNER_URL(), { files: [file('BW.txt', bw)], dataset: 'border-bw', source: 'Test source' });
			await importGazetteer(OWNER_URL(), { files: [file('BW.txt', bw)], dataset: 'border-bw', source: 'Test source' });
			expect(countriesOf((await search(viewer, 'Kanye')).body)).toEqual(['Kanye BW', 'Kanye ZA']);
		} finally {
			await client.query(`DELETE FROM gazetteer_reference WHERE dataset IN ('border-za', 'border-bw')`);
			await client.end();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('a country off the list (Kenya) loads nothing, beside a dump that does (positive control)', async () => {
		dir = mkdtempSync(join(tmpdir(), 'gazetteer-border-'));
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			expect(await importGazetteer(OWNER_URL(), { files: [file('KE.txt', ke)], dataset: 'border-ke', source: 'Test source' })).toMatchObject({ written: 0, otherCountry: 1 });
			expect(await importGazetteer(OWNER_URL(), { files: [file('KE.txt', ke), file('BW.txt', bw)], dataset: 'border-ke', source: 'Test source' })).toMatchObject({ written: 3, otherCountry: 1 });
			expect(countriesOf((await search(viewer, 'Grensbult')).body)).toEqual(['Grensbult BW']);
			// The table holds the same list: even the schema owner can't write another country.
			await expect(
				client.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, country, lon, lat, source) VALUES ('border-ke', 'x', 'x', 'x', 'P.PPL', 'KE', 36.8, -1.3, 'x')`)
			).rejects.toThrow(/gazetteer_reference_country_check/);
		} finally {
			await client.query(`DELETE FROM gazetteer_reference WHERE dataset = 'border-ke'`);
			await client.end();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('alternate names and the larger place first (the basemap’s "Tsabong" is GeoNames’ Tshabong; "Windhoek" listed hamlets before Namibia’s capital; ad hoc testing 2026-10-13, 237)', () => {
	// SYNTHETIC lines in GeoNames' dump format that mirror the real cases: the
	// feature codes, populations and alternate names follow GeoNames'
	// 2026-10-13 dumps; the ids and positions are made up, and the farms, the
	// hill's alternate and the "…test" places are invented.
	const line = (id: string, name: string, cls: string, code: string, cc: string, pop: number, alts: string, lat = -25.5, lon = 25.5) =>
		[id, name, name, alts, String(lat), String(lon), cls, code, cc, '', '01', '', '', '', String(pop), '', '0', 'Africa/Johannesburg', '2026-10-13'].join('\t');
	const dump = [
		line('9300001', 'Tshabong', 'P', 'PPLA', 'BW', 11651, 'TBY,Tsabong,Tshabong,Chabong,chabwnګ', -26.05, 22.45),
		// Namibia's capital and South African places of its name, none with a population: a hamlet, a section of a town, a farm, and a hill named so only by an alternate.
		line('9300101', 'Windhoek', 'P', 'PPLC', 'NA', 386219, 'WDH,Windhuk,Vindhuk', -22.56, 17.08),
		line('9300102', 'Windhoek', 'P', 'PPL', 'ZA', 0, '', -24.4, 30.0),
		line('9300103', 'Windhoek', 'P', 'PPLX', 'ZA', 0, '', -33.5, 21.7),
		line('9300104', 'Windhoek', 'S', 'FRM', 'ZA', 0, '', -27.2, 27.3),
		line('9300105', 'Windhoek se Berg', 'T', 'HLL', 'ZA', 0, 'Windhoek,Windhoek se Berg', -29.3, 18.7),
		// An old name (Polokwane's Pietersburg, renamed): the town by its alternate before a farm of that main name, kind first.
		line('9300201', 'Polokwanetest', 'P', 'PPLA', 'ZA', 272461, 'Pietersburgtest,Ou Klipdorp,Vaal Plaas', -23.9, 29.45),
		line('9300202', 'Pietersburgtest', 'S', 'FRM', 'ZA', 0, '', -26.0, 28.0)
	].join('\n');
	let client: pg.Client;
	const listed = (body: { hits: SearchHit[] }) => body.hits.map((h) => `${h.name} ${h.feature} ${h.country}${h.alias ? ` (also ${h.alias})` : ''}`);

	beforeAll(async () => {
		client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		await replacePlaces(client, 'alt-test', placeRecords(dump, 'alt.txt', 'Test source').records);
	});
	afterAll(async () => {
		await client.query(`DELETE FROM gazetteer_reference WHERE dataset = 'alt-test'`);
		await client.end();
	});

	it('an alternate name finds the place, listed by its main name with the spelling it matched', async () => {
		const res = (await search(viewer, 'Tsabong')).body;
		expect(listed(res)).toEqual(['Tshabong P.PPLA BW (also Tsabong)']);
		expect(res.hits[0]).toMatchObject({ kind: 'place', name: 'Tshabong', alias: 'Tsabong', country: 'BW' });
		// The main name typed: no alias. The start of an alternate finds it too.
		expect(listed((await search(viewer, 'tshabong')).body)).toEqual(['Tshabong P.PPLA BW']);
		expect(listed((await search(viewer, 'tsabo')).body)).toEqual(['Tshabong P.PPLA BW (also Tsabong)']);
		// What the loader left out isn't searched: the airport code.
		expect((await search(viewer, 'TBY')).body.hits).toEqual([]);
	});

	it('Windhoek: Namibia’s capital first, then the South African places of the name by kind, the hill named so by an alternate last', async () => {
		expect(listed((await search(viewer, 'Windhoek')).body)).toEqual([
			'Windhoek P.PPLC NA',
			'Windhoek P.PPL ZA',
			'Windhoek P.PPLX ZA',
			'Windhoek S.FRM ZA',
			'Windhoek se Berg T.HLL ZA (also Windhoek)'
		]);
		// "windhu" starts only the capital's alternate Windhuk.
		expect(listed((await search(viewer, 'windhu')).body)).toEqual(['Windhoek P.PPLC NA (also Windhuk)']);
	});

	it('an old name finds the town before a farm of that name; words from two different alternates make no match', async () => {
		expect(listed((await search(viewer, 'Pietersburgtest')).body)).toEqual(['Polokwanetest P.PPLA ZA (also Pietersburgtest)', 'Pietersburgtest S.FRM ZA']);
		expect(listed((await search(viewer, 'klipdorp ou')).body)).toEqual(['Polokwanetest P.PPLA ZA (also Ou Klipdorp)']);
		// "klip" starts a word of Ou Klipdorp and "plaas" one of Vaal Plaas: no one name has both.
		expect((await search(viewer, 'klip plaas')).body.hits).toEqual([]);
		// Positive control: both words in one alternate.
		expect(listed((await search(viewer, 'vaal plaas')).body)).toEqual(['Polokwanetest P.PPLA ZA (also Vaal Plaas)']);
	});

	it('stores the alternate names, folded beside them, and the population; the table refuses lists of different lengths and a negative population', async () => {
		const row = await client.query(`SELECT alt_names, alt_search, population FROM gazetteer_reference WHERE dataset = 'alt-test' AND place_id = '9300001'`);
		expect(row.rows).toEqual([{ alt_names: ['Tsabong', 'Chabong'], alt_search: 'tsabong | chabong', population: '11651' }]);
		await expect(
			client.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, lon, lat, source, alt_names, alt_search) VALUES ('alt-test', 'bad', 'x', 'x', 'P.PPL', 25, -25, 'x', '{A,B}', 'a')`)
		).rejects.toThrow(/gazetteer_reference_alt_names_check/);
		await expect(
			client.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, lon, lat, source, population) VALUES ('alt-test', 'bad', 'x', 'x', 'P.PPL', 25, -25, 'x', -1)`)
		).rejects.toThrow(/gazetteer_reference_population_check/);
		// More than 200 alternate names (the loader's MAX_ALTERNATES) is refused.
		const many = Array.from({ length: 201 }, (_, i) => `n${i}`);
		await expect(
			client.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, lon, lat, source, alt_names, alt_search) VALUES ('alt-test', 'bad', 'x', 'x', 'P.PPL', 25, -25, 'x', $1, $2)`, [many, many.join(' | ')])
		).rejects.toThrow(/gazetteer_reference_alt_names_check/);
		// Positive control: a place written as a loader of the previous release writes it (no alternates, no population) passes, with the defaults: an empty alt_search is no alternate names.
		await client.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, lon, lat, source) VALUES ('alt-test', 'old', 'Oudorp', 'oudorp', 'P.PPL', 25, -25, 'x')`);
		expect((await client.query(`SELECT alt_names, alt_search, population FROM gazetteer_reference WHERE dataset = 'alt-test' AND place_id = 'old'`)).rows).toEqual([{ alt_names: [], alt_search: '', population: '0' }]);
		expect(listed((await search(viewer, 'oudorp')).body)).toEqual(['Oudorp P.PPL ZA']);
	});
});

describe('the gazetteer table', () => {
	it('is read-only to the app', async () => {
		await expect(withUser(owner.id, (db) => db.query(`UPDATE gazetteer_reference SET name = 'x'`))).rejects.toThrow(/permission denied/);
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO gazetteer_reference (dataset, place_id, name, search_name, feature, lon, lat, source) VALUES ('x', '1', 'x', 'x', 'P.PPL', 21, -33, 'x')`))
		).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM gazetteer_reference`))).rejects.toThrow(/permission denied/);
	});

	it('a load replaces its own dataset only, and records its bucket file with it (reference_load), which a local load clears', async () => {
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			const line = (id: string, name: string) => [id, name, name, '', '-33.5', '20.7', 'P', 'PPL', 'ZA', '', '11', '', '', '', '0', '', '0', 'Africa/Johannesburg', '2026-10-12'].join('\t');
			const one = placeRecords(`${line('1', 'Testdorp Een')}\n${line('2', 'Testdorp Twee')}\n`, 'a.txt', 'Test source').records;
			const origin = { key: 'reference/gazetteer/za.txt.gz', sha256: 'f'.repeat(64) };
			expect(await replacePlaces(client, 'search-test', one, origin)).toBe(2);
			expect(hitsOf((await search(viewer, 'testdorp')).body)).toEqual(['place:Testdorp Een', 'place:Testdorp Twee']);
			const recorded = await client.query(`SELECT source_key FROM reference_load WHERE kind = 'gazetteer' AND dataset = 'search-test'`);
			expect(recorded.rows).toEqual([{ source_key: origin.key }]);
			// A second load of the dataset replaces it; the synthetic places stay.
			expect(await replacePlaces(client, 'search-test', placeRecords(line('3', 'Testdorp Drie'), 'b.txt', 'Test source').records)).toBe(1);
			expect(hitsOf((await search(viewer, 'testdorp')).body)).toEqual(['place:Testdorp Drie']);
			expect((await client.query(`SELECT 1 FROM reference_load WHERE kind = 'gazetteer' AND dataset = 'search-test'`)).rowCount).toBe(0);
			expect((await search(viewer, 'kwartsvallei')).body.hits.length).toBe(3);
			await client.query(`DELETE FROM gazetteer_reference WHERE dataset = 'search-test'`);
		} finally {
			await client.end();
		}
	});
});
