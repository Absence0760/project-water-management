// The soil water capacity grid (268_soil_grid.sql; issue #622 step 2):
// `pnpm import:soils` loads the committed synthetic grid; a polygon's PAWC is
// the area-weighted mean of its cells (the DB tests' boundary sits on four
// cells of exactly 120 mm, so its mean is 120 whatever the shares); a
// production load of the same file through the reference load records its
// file; signed-in users read the grid (the positive control), a session
// with no user reads none, and water_app never writes it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importSoils, loadSyntheticSoils, parseSoilsArgs, SYNTHETIC_SOILS_FILE } from '../../scripts/import-soils.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import type { Geometry } from './geojson.js';
import { loadReferenceText, parseLoadRequest, readReferenceText } from './referenceLoad.js';
import { MIN_SOIL_COVERAGE, soilDatasets, summariseSoil, SYNTHETIC_SOIL_DATASET } from './soilGrid.js';

const URL_ = () => process.env.TEST_MIGRATION_DATABASE_URL!;
const PROD = 'test-soils-prod';
const box = (w: number, s: number, e: number, n: number): Geometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});
// The boundary the other grids' DB tests use: inside the four 120 mm cells.
const BOUNDARY = box(21.26, -33.74, 21.44, -33.56);
const CELLS = (JSON.parse(readFileSync(SYNTHETIC_SOILS_FILE, 'utf8')) as { cells: unknown[] }).cells.length;
let user: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
	expect(await loadSyntheticSoils(URL_())).toBe(CELLS);
	user = await signUp('Soils');
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM soil_dataset WHERE dataset = $1', [PROD]);
	await asOwner(`DELETE FROM reference_load WHERE kind = 'soils' AND dataset = $1`, [PROD]);
});

describe('the synthetic grid', () => {
	it('loads every cell, idempotently, with its own source and the method in words', async () => {
		expect(await loadSyntheticSoils(URL_())).toBe(CELLS);
		const [d] = await asOwner('SELECT source, version, method, cell_deg, origin_lon, origin_lat FROM soil_dataset WHERE dataset = $1', [SYNTHETIC_SOIL_DATASET]);
		expect(d).toMatchObject({ source: expect.stringMatching(/^Synthetic/), version: 'synthetic 1', cell_deg: 0.1 });
		expect((d as { method: string }).method).toMatch(/min\(200 cm, iSDAsoil’s depth to bedrock\)/);
		expect((d as { origin_lon: number }).origin_lon).toBeCloseTo(0.05, 9);
		const [n] = await asOwner('SELECT count(*)::int AS n FROM soil_cell_reference WHERE dataset = $1', [SYNTHETIC_SOIL_DATASET]);
		expect(n).toEqual({ n: CELLS });
	});

	it('gives a polygon the area-weighted mean of its cells', async () => {
		const ds = await withUser(user.id, (db) => soilDatasets(db));
		const syn = ds.find((d) => d.dataset === SYNTHETIC_SOIL_DATASET)!;
		expect(syn.synthetic).toBe(true);
		const got = await withUser(user.id, (db) => summariseSoil(db, syn, BOUNDARY));
		expect(got).toEqual({ pawcMm: 120, rootDepthCm: 200, coverage: 1, cells: 4 });
		// Two cells, 21.3 and 21.4 E at 33.0 S (south of the 'bedrock' line): (80 + 40 × 0.8 + 30 × 1.5) and (+ 4), equal areas.
		const two = await withUser(user.id, (db) => summariseSoil(db, syn, box(21.25, -33.05, 21.45, -32.95)));
		expect(two).toMatchObject({ pawcMm: 159, rootDepthCm: 200, cells: 2 });
	});

	it('says why when the polygon is off the grid or mostly so', async () => {
		const syn = (await withUser(user.id, (db) => soilDatasets(db))).find((d) => d.synthetic)!;
		expect(await withUser(user.id, (db) => summariseSoil(db, syn, box(30, -30, 30.2, -29.8)))).toEqual({ problem: expect.stringMatching(/no value inside/) });
		// The grid ends at 22.55 E: a box mostly east of it.
		const edge = await withUser(user.id, (db) => summariseSoil(db, syn, box(22.45, -33.7, 23.45, -33.6)));
		expect(edge).toEqual({ problem: expect.stringMatching(/only \d+ % of the boundary/) });
		expect(MIN_SOIL_COVERAGE).toBe(0.5);
	});
});

describe('a production load of the same file', () => {
	it('loads the gzipped grid through the reference load and records the file', async () => {
		const bytes = gzipSync(readFileSync(SYNTHETIC_SOILS_FILE));
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const req = parseLoadRequest({ kind: 'soils', key: 'reference/soils/d1.json.gz', sha256, dataset: PROD });
		const client = new pg.Client({ connectionString: URL_() });
		await client.connect();
		try {
			const read = async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes });
			const result = await loadReferenceText(client, req, await readReferenceText(req, read));
			expect(result).toEqual({ kind: 'soils', dataset: PROD, written: CELLS, skipped: 0, belowOrder: 0, replaced: null });
		} finally {
			await client.end();
		}
		expect(await asOwner(`SELECT source_key, source_sha256 FROM reference_load WHERE kind = 'soils' AND dataset = $1`, [PROD])).toEqual([{ source_key: 'reference/soils/d1.json.gz', source_sha256: sha256 }]);
		// The real grid comes first, before the synthetic one.
		expect((await withUser(user.id, (db) => soilDatasets(db)))[0]!.dataset).toBe(PROD);
		// A local replace of the same label names no file: the record goes.
		const args = parseSoilsArgs([SYNTHETIC_SOILS_FILE, '--dataset', PROD]);
		if (typeof args === 'string') throw new Error(args);
		expect((await importSoils(URL_(), args)).written).toBe(CELLS);
		expect(await asOwner(`SELECT 1 FROM reference_load WHERE kind = 'soils' AND dataset = $1`, [PROD])).toEqual([]);
	});
});

describe('who reads and writes it', () => {
	it('a signed-in user reads it, a session with no user reads none, and water_app never writes it', async () => {
		const read = await withUser(user.id, (db) => db.query(`SELECT count(*)::int AS n FROM soil_cell_reference WHERE dataset = 'synthetic'`));
		expect(read.rows[0]).toEqual({ n: CELLS });
		const none = await withoutUser((db) => db.query(`SELECT count(*)::int AS n FROM soil_dataset`));
		expect(none.rows[0]).toEqual({ n: 0 });
		await expect(withUser(user.id, (db) => db.query(`INSERT INTO soil_dataset (dataset, source, version, method, attribution, cell_deg, origin_lon, origin_lat) VALUES ('x', 's', 'v', 'm', 'a', 0.1, 0, 0)`))).rejects.toThrow(/permission denied/);
		await expect(withUser(user.id, (db) => db.query(`UPDATE soil_cell_reference SET pawc_mm = 1 WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(user.id, (db) => db.query(`DELETE FROM soil_dataset WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
	});
});

describe('the command line', () => {
	it('loads the fixture with no argument and needs a label for a file', () => {
		expect(parseSoilsArgs([])).toMatchObject({ file: SYNTHETIC_SOILS_FILE, dataset: 'synthetic' });
		expect(parseSoilsArgs(['grid.json'])).toMatch(/--dataset/);
		expect(parseSoilsArgs(['grid.json', '--dataset', 'synthetic'])).toMatch(/pick another/);
		expect(parseSoilsArgs(['grid.tif', '--dataset', 'x'])).toMatch(/\.json/);
		expect(parseSoilsArgs(['--bbox', '1'])).toBe('unknown option --bbox');
	});
});
