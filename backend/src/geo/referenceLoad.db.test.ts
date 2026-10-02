// A production reference load end to end against Postgres, as the migrate
// Lambda runs it (geo/referenceLoad.ts; docs/deployment.md § Reference
// datasets), minus S3: the operator's file, prepared the documented way,
// read through readReferenceText (hash checked, gunzipped) and written by
// loadReferenceText as the schema owner.
//  - land cover: the synthetic grid through `pnpm import:land-cover --out`
//    (writeLandCoverJson, gzipped) loads as its own dataset, cell for cell the
//    same as the direct load of the fixture, with the file's own source and
//    attribution; a second load replaces it;
//  - evaporation: the synthetic grid through `pnpm import:evaporation --out`
//    (writeEvaporationJson, gzipped) loads cell for cell the same as the
//    direct load, with its dataset row; an A-pan grid is refused;
//  - rivers: the synthetic network loads with the source given, minOrder
//    leaves the small reaches out;
//  - a file with nothing loadable fails and leaves the dataset as it was.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticEvaporation, parseEvaporationArgs, writeEvaporationJson } from '../../scripts/import-evaporation.js';
import { loadSyntheticLandCover, parseLandCoverArgs, writeLandCoverJson } from '../../scripts/import-land-cover.js';
import { SYNTHETIC_RIVERS_FILE } from '../../scripts/import-rivers.js';
import { asOwner } from '../__tests__/helpers.js';
import { LoadError, loadReferenceText, parseLoadRequest, readReferenceText, type ReadObject } from './referenceLoad.js';

const LC = 'test-reference-load-lc';
const RV = 'test-reference-load-rv';
const EV = 'test-reference-load-ev';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const object = (bytes: Uint8Array): ReadObject => async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes });
let dir: string;
let client: pg.Client;

/** Read `bytes` as `load`'s file and load it, as the Lambda does. */
async function load(load: Record<string, unknown>, bytes: Uint8Array) {
	const req = parseLoadRequest({ ...load, sha256: sha(bytes) });
	return loadReferenceText(client, req, await readReferenceText(req, object(bytes)));
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'reference-load-'));
	await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!);
	await loadSyntheticEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!);
	client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
});

afterAll(async () => {
	await client.query('DELETE FROM cropland_dataset WHERE dataset = $1', [LC]);
	await client.query('DELETE FROM river_reference WHERE dataset = $1', [RV]);
	await client.query('DELETE FROM evaporation_dataset WHERE dataset = $1', [EV]);
	await client.end();
	rmSync(dir, { recursive: true, force: true });
});

describe('land cover, from the file `import:land-cover --out` writes', () => {
	it('loads cell for cell what the direct load of the same grid holds, with the file’s own source', async () => {
		const args = parseLandCoverArgs([]);
		if (typeof args === 'string') throw new Error(args);
		const out = join(dir, 'grid.json.gz');
		const { written: wrote } = writeLandCoverJson({ ...args, out });
		const bytes = readFileSync(out);
		const result = await load({ kind: 'land-cover', key: 'reference/land-cover/grid.json.gz', dataset: LC }, bytes);
		expect(result).toEqual({ kind: 'land-cover', dataset: LC, written: wrote, skipped: 0, belowOrder: 0 });

		const cells = async (dataset: string) =>
			(await asOwner('SELECT row_idx, col_idx, round(fraction::numeric, 4) AS f FROM cropland_cell_reference WHERE dataset = $1 ORDER BY row_idx, col_idx', [dataset])).map((r) => `${r.row_idx}:${r.col_idx}:${r.f}`);
		const loaded = await cells(LC);
		expect(loaded.length).toBe(wrote);
		expect(loaded).toEqual(await cells('synthetic'));
		const [d] = await asOwner('SELECT source, version, attribution, cell_deg, classes FROM cropland_dataset WHERE dataset = $1', [LC]);
		const [s] = await asOwner(`SELECT source, version, attribution, cell_deg, classes FROM cropland_dataset WHERE dataset = 'synthetic'`);
		expect(d).toEqual(s);
	});

	it('a second load replaces the dataset', async () => {
		const bytes = gzipSync(JSON.stringify({ cellDeg: 0.005, source: 'Second', cells: [[21.3025, -33.6575, 0.25]] }));
		expect((await load({ kind: 'land-cover', key: 'reference/land-cover/second.json.gz', dataset: LC }, bytes)).written).toBe(1);
		expect(await asOwner('SELECT fraction FROM cropland_cell_reference WHERE dataset = $1', [LC])).toEqual([{ fraction: 0.25 }]);
		expect((await asOwner('SELECT source FROM cropland_dataset WHERE dataset = $1', [LC]))[0]!.source).toBe('Second');
	});

	it('a grid with no cell to load fails and leaves the dataset as it was', async () => {
		const bytes = gzipSync(JSON.stringify({ cellDeg: 0.005, cells: [[21.3, -33.6, 0]] }));
		const err = await load({ kind: 'land-cover', key: 'reference/land-cover/empty.json.gz', dataset: LC }, bytes).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('empty');
		expect(await asOwner('SELECT count(*)::int AS n FROM cropland_cell_reference WHERE dataset = $1', [LC])).toEqual([{ n: 1 }]);
	});
});

describe('evaporation, from the file `import:evaporation --out` writes', () => {
	const grid = (kind: string, cells: unknown[]) => gzipSync(JSON.stringify({ kind, cellDeg: 0.1, firstYear: 1991, lastYear: 2020, cells }));
	const twelve = (v: number) => Array.from({ length: 12 }, () => v);

	it('loads cell for cell what the direct load of the same grid holds, with its dataset row', async () => {
		const args = parseEvaporationArgs([]);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const out = join(dir, 'evap.json.gz');
		const { written: wrote } = await writeEvaporationJson({ ...args, out });
		const result = await load({ kind: 'evaporation', key: 'reference/evaporation/evap.json.gz', dataset: EV }, readFileSync(out));
		expect(result).toEqual({ kind: 'evaporation', dataset: EV, written: wrote, skipped: 0, belowOrder: 0 });

		const cells = async (dataset: string) =>
			(await asOwner('SELECT row_idx, col_idx, monthly_mm FROM evaporation_cell_reference WHERE dataset = $1 ORDER BY row_idx, col_idx', [dataset])).map(
				(r) => `${r.row_idx}:${r.col_idx}:${(r.monthly_mm as number[]).join(',')}`
			);
		const loaded = await cells(EV);
		expect(loaded.length).toBe(wrote);
		expect(loaded).toEqual(await cells('synthetic'));
		const row = 'SELECT kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat FROM evaporation_dataset WHERE dataset = $1';
		expect((await asOwner(row, [EV]))[0]).toEqual((await asOwner(row, ['synthetic']))[0]);
	});

	it('the source given overrides the file’s own; a second load replaces the dataset', async () => {
		const bytes = grid('et0', [[21.25, -33.75, twelve(100)]]);
		expect((await load({ kind: 'evaporation', key: 'reference/evaporation/second.json.gz', dataset: EV, source: 'Second' }, bytes)).written).toBe(1);
		expect(await asOwner('SELECT count(*)::int AS n FROM evaporation_cell_reference WHERE dataset = $1', [EV])).toEqual([{ n: 1 }]);
		expect((await asOwner('SELECT source, version FROM evaporation_dataset WHERE dataset = $1', [EV]))[0]).toEqual({ source: 'Second', version: 'hPET v3 (University of Bristol data.bris)' });
	});

	it('an A-pan grid is refused (no allowed source yet), and a grid with no cell fails; the dataset stays as it was', async () => {
		const apan = await load({ kind: 'evaporation', key: 'reference/evaporation/apan.json.gz', dataset: EV }, grid('apan', [[21.25, -33.75, twelve(150)]])).catch((e: unknown) => e);
		expect(apan).toBeInstanceOf(LoadError);
		expect((apan as LoadError).code).toBe('refused');
		expect((apan as LoadError).publicReason).toMatch(/only a reference-ET grid/);
		const empty = await load({ kind: 'evaporation', key: 'reference/evaporation/empty.json.gz', dataset: EV }, grid('et0', [[21.25, -33.75, twelve(-1)]])).catch((e: unknown) => e);
		expect((empty as LoadError).code).toBe('empty');
		const notGrid = await load({ kind: 'evaporation', key: 'reference/evaporation/x.json', dataset: EV }, Buffer.from('{"cells":[]}')).catch((e: unknown) => e);
		expect((notGrid as LoadError).code).toBe('unreadable');
		expect(await asOwner('SELECT source FROM evaporation_dataset WHERE dataset = $1', [EV])).toEqual([{ source: 'Second' }]);
	});
});

describe('rivers', () => {
	// The synthetic network without its per-reach sources, as ogr2ogr writes HydroRIVERS (no source field).
	const fc = JSON.parse(readFileSync(SYNTHETIC_RIVERS_FILE, 'utf8')) as { features: { properties: Record<string, unknown> }[] };
	for (const f of fc.features) delete f.properties.source;
	const network = Buffer.from(JSON.stringify(fc));

	it('loads the reaches with the source given, and minOrder leaves the small ones out', async () => {
		const all = await load({ kind: 'rivers', key: 'reference/rivers/net.geojson', dataset: RV, source: 'Test source line' }, network);
		expect(all).toMatchObject({ kind: 'rivers', dataset: RV, skipped: 0, belowOrder: 0 });
		expect(all.written).toBe(11);
		expect(await asOwner('SELECT DISTINCT source FROM river_reference WHERE dataset = $1', [RV])).toEqual([{ source: 'Test source line' }]);

		const big = await load({ kind: 'rivers', key: 'reference/rivers/net.geojson.gz', dataset: RV, source: 'Test source line', minOrder: 2 }, gzipSync(network));
		expect(big.belowOrder).toBeGreaterThan(0);
		expect(big.written + big.belowOrder).toBe(11);
		expect(await asOwner('SELECT count(*)::int AS n FROM river_reference WHERE dataset = $1', [RV])).toEqual([{ n: big.written }]);
	});

	it('a file with no reach to load fails and leaves the dataset as it was', async () => {
		const before = await asOwner('SELECT count(*)::int AS n FROM river_reference WHERE dataset = $1', [RV]);
		const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] }));
		const err = await load({ kind: 'rivers', key: 'reference/rivers/none.geojson', dataset: RV, source: 'x' }, bytes).catch((e: unknown) => e);
		expect((err as LoadError).code).toBe('empty');
		expect(await asOwner('SELECT count(*)::int AS n FROM river_reference WHERE dataset = $1', [RV])).toEqual(before);
	});
});
