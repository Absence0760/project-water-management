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
//  - gazetteer: the synthetic GeoNames-format places (gzipped) load with
//    GeoNames' attribution unless a source is given, the kinds the search
//    leaves out dropped;
//  - MAP grid: the synthetic grid through `pnpm import:map-grid --out`
//    (writeMapGridJson, gzipped) loads as the one allowed dataset
//    (WAAS-SWCape-2007), cell for cell the same as the direct load, stored
//    with the recorded credit line, never the file's own;
//  - a file with nothing loadable fails and leaves the dataset as it was;
//  - each load records the file's key and SHA-256 with the dataset
//    (reference_load, 192), returns the one it replaced, keeps it on a failed
//    load, and a local replace (no file) clears it.
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
import { SYNTHETIC_GAZETTEER_FILE } from '../../scripts/import-gazetteer.js';
import { loadSyntheticMapGrid, parseMapGridArgs, writeMapGridJson } from '../../scripts/import-map-grid.js';
import { POLYGONS_FILE as SYNTHETIC_WATERBODIES_FILE } from '../../scripts/waterbodies-fixture.js';
import { replaceRainMapDataset, WAAS_MAP } from './rainMap.js';
import { GEONAMES_SOURCE } from './gazetteer.js';
import { asOwner } from '../__tests__/helpers.js';
import { replaceCroplandDataset } from './croplandGrid.js';
import { LoadError, loadReferenceText, parseLoadRequest, readReferenceText, type ReadObject } from './referenceLoad.js';

const LC = 'test-reference-load-lc';
const RV = 'test-reference-load-rv';
const EV = 'test-reference-load-ev';
const GZ = 'test-reference-load-gz';
const GZN = 'test-reference-load-gz-neighbours';
// The one MAP grid label production allows (REFERENCE_KINDS['map-grid'].datasets): only this file writes it in water_test.
const MG = WAAS_MAP.dataset;
const WB = 'Test-Waterbodies';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const object = (bytes: Uint8Array): ReadObject => async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes });
let dir: string;
let client: pg.Client;

/** Read `bytes` as `load`'s file and load it, as the Lambda does. */
async function load(load: Record<string, unknown>, bytes: Uint8Array) {
	const req = parseLoadRequest({ ...load, sha256: sha(bytes) });
	return loadReferenceText(client, req, await readReferenceText(req, object(bytes)));
}

/** The file reference_load records for a dataset, or undefined. */
const recorded = async (kind: string, dataset: string) =>
	(await asOwner('SELECT source_key AS key, source_sha256 AS sha256 FROM reference_load WHERE kind = $1 AND dataset = $2', [kind, dataset]))[0];

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'reference-load-'));
	await loadSyntheticLandCover(process.env.TEST_MIGRATION_DATABASE_URL!);
	await loadSyntheticEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!);
	await loadSyntheticMapGrid(process.env.TEST_MIGRATION_DATABASE_URL!);
	client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
});

afterAll(async () => {
	await client.query('DELETE FROM cropland_dataset WHERE dataset = $1', [LC]);
	await client.query('DELETE FROM river_reference WHERE dataset = $1', [RV]);
	await client.query('DELETE FROM evaporation_dataset WHERE dataset = $1', [EV]);
	await client.query('DELETE FROM gazetteer_reference WHERE dataset = ANY($1::text[])', [[GZ, GZN]]);
	await client.query('DELETE FROM rain_map_dataset WHERE dataset = $1', [MG]);
	await client.query('DELETE FROM waterbody_reference WHERE dataset = $1', [WB]);
	await client.query('DELETE FROM reference_load WHERE dataset = ANY($1::text[])', [[LC, `${LC}-other`, RV, EV, GZ, GZN, MG, WB]]);
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
		expect(result).toEqual({ kind: 'land-cover', dataset: LC, written: wrote, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('land-cover', LC)).toEqual({ key: 'reference/land-cover/grid.json.gz', sha256: sha(bytes) });

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
		const first = await recorded('land-cover', LC);
		const second = await load({ kind: 'land-cover', key: 'reference/land-cover/second.json.gz', dataset: LC }, bytes);
		expect(second.written).toBe(1);
		// The file it replaced, to restore for an undo; the record now names the new one.
		expect(second.replaced).toEqual({ ...first, loadedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
		expect(await recorded('land-cover', LC)).toEqual({ key: 'reference/land-cover/second.json.gz', sha256: sha(bytes) });
		expect(await asOwner('SELECT fraction FROM cropland_cell_reference WHERE dataset = $1', [LC])).toEqual([{ fraction: 0.25 }]);
		expect((await asOwner('SELECT source FROM cropland_dataset WHERE dataset = $1', [LC]))[0]!.source).toBe('Second');
	});

	it('a grid with no cell to load fails and leaves the dataset as it was', async () => {
		const bytes = gzipSync(JSON.stringify({ cellDeg: 0.005, cells: [[21.3, -33.6, 0]] }));
		const err = await load({ kind: 'land-cover', key: 'reference/land-cover/empty.json.gz', dataset: LC }, bytes).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('empty');
		expect(await asOwner('SELECT count(*)::int AS n FROM cropland_cell_reference WHERE dataset = $1', [LC])).toEqual([{ n: 1 }]);
		// The record stays with the data it describes.
		expect(await recorded('land-cover', LC)).toMatchObject({ key: 'reference/land-cover/second.json.gz' });
	});

	it('a replace that names no file (a local import) clears the record, so it never outlives its data', async () => {
		expect(await recorded('land-cover', LC)).toBeDefined();
		const [meta] = await asOwner('SELECT dataset, source, version, method, attribution, cell_deg AS "cellDeg", classes FROM cropland_dataset WHERE dataset = $1', [LC]);
		// Positive control: another dataset's record, and the same label's under another kind, are left alone.
		const other = { key: 'reference/land-cover/other.json.gz', sha256: 'c'.repeat(64) };
		await asOwner('INSERT INTO reference_load (kind, dataset, source_key, source_sha256) VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)', ['land-cover', `${LC}-other`, other.key, other.sha256, 'rivers', LC]);
		await replaceCroplandDataset(client, meta as never, [[{ row: 1, col: 1, fraction: 0.5 }]]);
		expect(await recorded('land-cover', LC)).toBeUndefined();
		expect(await recorded('land-cover', `${LC}-other`)).toEqual(other);
		expect(await recorded('rivers', LC)).toEqual(other);
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
		expect(result).toEqual({ kind: 'evaporation', dataset: EV, written: wrote, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('evaporation', EV)).toEqual({ key: 'reference/evaporation/evap.json.gz', sha256: sha(readFileSync(out)) });

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
		expect(all.replaced).toBeNull();
		expect(await recorded('rivers', RV)).toEqual({ key: 'reference/rivers/net.geojson', sha256: sha(network) });
		expect(await asOwner('SELECT DISTINCT source FROM river_reference WHERE dataset = $1', [RV])).toEqual([{ source: 'Test source line' }]);

		const big = await load({ kind: 'rivers', key: 'reference/rivers/net.geojson.gz', dataset: RV, source: 'Test source line', minOrder: 2 }, gzipSync(network));
		expect(big.belowOrder).toBeGreaterThan(0);
		expect(big.replaced).toMatchObject({ key: 'reference/rivers/net.geojson', sha256: sha(network) });
		expect(await recorded('rivers', RV)).toEqual({ key: 'reference/rivers/net.geojson.gz', sha256: sha(gzipSync(network)) });
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

describe('gazetteer', () => {
	const dump = readFileSync(SYNTHETIC_GAZETTEER_FILE);

	it('loads the places of a GeoNames dump with GeoNames’ attribution, leaving out the kinds the search doesn’t keep', async () => {
		const gz = gzipSync(dump);
		const result = await load({ kind: 'gazetteer', key: 'reference/gazetteer/za.txt.gz', dataset: GZ }, gz);
		expect(result).toEqual({ kind: 'gazetteer', dataset: GZ, written: 9, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('gazetteer', GZ)).toEqual({ key: 'reference/gazetteer/za.txt.gz', sha256: sha(gz) });
		expect(await asOwner('SELECT DISTINCT source FROM gazetteer_reference WHERE dataset = $1', [GZ])).toEqual([{ source: GEONAMES_SOURCE }]);
		// A source given overrides it; the load replaces the dataset and returns the file it replaced.
		const again = await load({ kind: 'gazetteer', key: 'reference/gazetteer/za.txt', dataset: GZ, source: 'GeoNames, CC BY 4.0, 2026-10-12' }, dump);
		expect(again.replaced).toMatchObject({ key: 'reference/gazetteer/za.txt.gz', sha256: sha(gz) });
		expect(await asOwner('SELECT count(*)::int AS n, min(source) AS source FROM gazetteer_reference WHERE dataset = $1', [GZ])).toEqual([{ n: 9, source: 'GeoNames, CC BY 4.0, 2026-10-12' }]);
	});

	it('a file with no place to load fails and leaves the dataset as it was', async () => {
		const err = await load({ kind: 'gazetteer', key: 'reference/gazetteer/none.txt', dataset: GZ }, Buffer.from('# nothing\n')).catch((e: unknown) => e);
		expect((err as LoadError).code).toBe('empty');
		expect(await asOwner('SELECT count(*)::int AS n FROM gazetteer_reference WHERE dataset = $1', [GZ])).toEqual([{ n: 9 }]);
	});

	it('South Africa’s neighbours load as a dataset of their own beside South Africa’s; a dump of another country (Kenya) is refused', async () => {
		// SYNTHETIC lines in GeoNames' format: Lesotho and Botswana dumps gzipped as one file, as deployment.md § Reference datasets has the operator upload them.
		const line = (id: string, name: string, cc: string, lat: number, lon: number) =>
			[id, name, name, '', String(lat), String(lon), 'P', 'PPL', cc, '', '01', '', '', '', '0', '', '0', 'Africa/Maseru', '2026-10-13'].join('\t');
		const neighbours = gzipSync([line('9300001', 'Grenshoek', 'LS', -29.3, 27.5), line('9300002', 'Grenspos', 'BW', -25.2, 25.7), line('9300003', 'Verweg', 'BW', -19.0, 24.0)].join('\n'));
		const result = await load({ kind: 'gazetteer', key: 'reference/gazetteer/neighbours-2026-10-13.txt.gz', dataset: GZN }, neighbours);
		expect(result).toEqual({ kind: 'gazetteer', dataset: GZN, written: 2, skipped: 0, belowOrder: 0, replaced: null });
		expect(await asOwner('SELECT country, count(*)::int AS n FROM gazetteer_reference WHERE dataset = $1 GROUP BY country ORDER BY country', [GZN])).toEqual([
			{ country: 'BW', n: 1 },
			{ country: 'LS', n: 1 }
		]);
		// South Africa's dataset is untouched.
		expect(await asOwner('SELECT count(*)::int AS n FROM gazetteer_reference WHERE dataset = $1', [GZ])).toEqual([{ n: 9 }]);
		const err = await load({ kind: 'gazetteer', key: 'reference/gazetteer/ke.txt', dataset: GZN }, Buffer.from(line('9300009', 'Elders', 'KE', -1.3, 36.8))).catch((e: unknown) => e);
		expect((err as LoadError).code).toBe('empty');
		expect((err as LoadError).publicReason).toMatch(/South Africa and its neighbours/);
		expect(await asOwner('SELECT count(*)::int AS n FROM gazetteer_reference WHERE dataset = $1', [GZN])).toEqual([{ n: 2 }]);
	});
});

describe('MAP grid, from the file `import:map-grid --out` writes (issue #560)', () => {
	it('loads cell for cell what the direct load of the same grid holds, stored with the recorded credit line, not the file’s', async () => {
		const args = parseMapGridArgs([]);
		if (typeof args === 'string') throw new Error(args);
		const out = join(dir, 'map-grid.json.gz');
		const wrote = await writeMapGridJson({ ...args, out });
		const bytes = readFileSync(out);
		const result = await load({ kind: 'map-grid', key: 'reference/map-grid/waas.json.gz', dataset: MG }, bytes);
		expect(result).toEqual({ kind: 'map-grid', dataset: MG, written: wrote, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('map-grid', MG)).toEqual({ key: 'reference/map-grid/waas.json.gz', sha256: sha(bytes) });

		const cells = async (dataset: string) =>
			(await asOwner('SELECT row_idx, col_idx, map_mm FROM rain_map_cell_reference WHERE dataset = $1 ORDER BY row_idx, col_idx', [dataset])).map((r) => `${r.row_idx}:${r.col_idx}:${r.map_mm}`);
		const loaded = await cells(MG);
		expect(loaded.length).toBe(wrote);
		expect(loaded).toEqual(await cells('synthetic'));
		const [d] = await asOwner('SELECT source, version, attribution, cell_deg, origin_lon, origin_lat, cell_count FROM rain_map_dataset WHERE dataset = $1', [MG]);
		const [s] = await asOwner(`SELECT cell_deg, origin_lon, origin_lat, cell_count FROM rain_map_dataset WHERE dataset = 'synthetic'`);
		// The file carries the synthetic grid's own lines; the load stores the recorded ones.
		expect(d).toEqual({ ...s, source: WAAS_MAP.source, version: WAAS_MAP.version, attribution: WAAS_MAP.attribution });
	});

	it('a file that is not a MAP grid fails and leaves the dataset as it was; a local replace clears the record', async () => {
		const before = await asOwner('SELECT count(*)::int AS n FROM rain_map_cell_reference WHERE dataset = $1', [MG]);
		const err = await load({ kind: 'map-grid', key: 'reference/map-grid/bad.json.gz', dataset: MG }, gzipSync(JSON.stringify({ cellDeg: 0.01, cells: [] }))).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('unreadable');
		expect(await asOwner('SELECT count(*)::int AS n FROM rain_map_cell_reference WHERE dataset = $1', [MG])).toEqual(before);
		expect(await recorded('map-grid', MG)).toMatchObject({ key: 'reference/map-grid/waas.json.gz' });
		// A local import of the same label names no file: the record goes.
		await replaceRainMapDataset(client, { dataset: MG, source: 'local', version: 'local', attribution: 'local' }, { cellDeg: 0.01, originLon: 0.005, originLat: 0.005, cells: [{ row: 1, col: 1, mapMm: 500 }] });
		expect(await recorded('map-grid', MG)).toBeUndefined();
	});
});

describe('DE Africa Waterbodies polygons (257, issue #604 R5)', () => {
	it('loads the polygons of a GeoJSON clip, gzipped, with the default source, and records the file', async () => {
		const bytes = gzipSync(readFileSync(SYNTHETIC_WATERBODIES_FILE));
		const result = await load({ kind: 'waterbodies', key: 'reference/waterbodies/d1.geojson.gz', dataset: WB }, bytes);
		const n = (JSON.parse(readFileSync(SYNTHETIC_WATERBODIES_FILE, 'utf8')) as { features: unknown[] }).features.length;
		expect(result).toEqual({ kind: 'waterbodies', dataset: WB, written: n, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('waterbodies', WB)).toEqual({ key: 'reference/waterbodies/d1.geojson.gz', sha256: sha(bytes) });
		const rows = await asOwner('SELECT count(*)::int AS n, min(source) AS source FROM waterbody_reference WHERE dataset = $1', [WB]);
		expect(rows[0]).toEqual({ n, source: expect.stringContaining('Digital Earth Africa Waterbodies') });
	});

	it('a file with no waterbody fails and leaves the dataset as it was', async () => {
		const before = await asOwner('SELECT count(*)::int AS n FROM waterbody_reference WHERE dataset = $1', [WB]);
		const err = await load({ kind: 'waterbodies', key: 'reference/waterbodies/none.geojson', dataset: WB }, Buffer.from('{"type":"FeatureCollection","features":[]}')).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('empty');
		expect(await asOwner('SELECT count(*)::int AS n FROM waterbody_reference WHERE dataset = $1', [WB])).toEqual(before);
	});
});
