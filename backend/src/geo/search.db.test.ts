// GET /projects/:id/map/search (issue #523 C5; docs/api.md § Catchment map,
// docs/maps.md § Search) over the committed synthetic datasets: the map's
// own layers first (gauges, the register's dams, quaternaries), then the
// gazetteer (225), each place with its credit. A viewer reads it (positive
// control); a farmer gets 403, a stranger 404, a signed-out caller 401;
// water_app can't write the gazetteer; a load replaces its dataset and
// records nothing of a local import in reference_load.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { importGaugeStations, parseArgs as stationArgs } from '../../scripts/import-gauge-stations.js';
import { importGazetteer, parseArgs as gazetteerArgs } from '../../scripts/import-gazetteer.js';
import { importQuaternaries, parseArgs as quaternaryArgs } from '../../scripts/import-quaternaries.js';
import { loadSyntheticDamRegister } from '../../scripts/import-dam-register.js';
import { anon, asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { SEARCH_LAYER_LIMIT } from './gazetteer.js';
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
