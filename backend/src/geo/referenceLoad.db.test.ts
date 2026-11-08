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
//    direct load, with its dataset row; an A-pan grid is refused under any
//    label but the WRC Atlas's (Atlas-Apan-2007), whose grid, built from 12
//    monthly ASCII grids (`--apan-asc`), loads stored with its recorded,
//    modelled lines; a PenPan grid or a reference-ET file under that label is
//    refused;
//  - rivers: the synthetic network loads with the source given, minOrder
//    leaves the small reaches out;
//  - gazetteer: the synthetic GeoNames-format places (gzipped) load with
//    GeoNames' attribution unless a source is given, the kinds the search
//    leaves out dropped;
//  - MAP grid: the synthetic grid through `pnpm import:map-grid --out`
//    (writeMapGridJson, gzipped) loads as the one allowed dataset
//    (WAAS-SWCape-2007, and Lynch-2004 since 2026-11-08), cell for cell the
//    same as the direct load, stored with the recorded credit line, never the
//    file's own;
//  - quaternaries (the operator's decision, 2026-11-02): the outlines with
//    their values, through `pnpm import:quaternaries --out`
//    (writeQuaternariesJson, gzipped), load with the recorded DWS and WR2012
//    credit on every row (or the load's own source), never the file's;
//  - a file with nothing loadable fails and leaves the dataset as it was;
//  - DWS flow (issue #618 step 6b): the synthetic reply loads into the gauge
//    record store through gauge_record_write as dws-request rows, origin dws,
//    with the source as their reference; a re-load writes the same rows, two
//    windows of a station merge into one span, the station comes from the
//    file or the request (and must agree), and a file the reader or the store
//    refuses writes nothing, its earlier chunks included;
//  - each load records the file's key and SHA-256 with the dataset
//    (reference_load, 192), returns the one it replaced, keeps it on a failed
//    load, and a local replace (no file) clears it;
//  - reference_load's kind check takes every kind production allows, so a
//    migration that redefines it can't drop one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticEvaporation, parseEvaporationArgs, SYNTHETIC_APAN_ASC_FILES, SYNTHETIC_PENPAN_FILE, writeEvaporationJson } from '../../scripts/import-evaporation.js';
import { loadSyntheticLandCover, parseLandCoverArgs, writeLandCoverJson } from '../../scripts/import-land-cover.js';
import { SYNTHETIC_RIVERS_FILE } from '../../scripts/import-rivers.js';
import { SYNTHETIC_GAZETTEER_FILE } from '../../scripts/import-gazetteer.js';
import { SYNTHETIC_DWS_REPLY } from '../../scripts/import-dws.js';
import { loadSyntheticMapGrid, parseMapGridArgs, writeMapGridJson } from '../../scripts/import-map-grid.js';
import { POLYGONS_FILE as SYNTHETIC_WATERBODIES_FILE } from '../../scripts/waterbodies-fixture.js';
import { writeQuaternariesJson } from '../../scripts/import-quaternaries.js';
import { QUATERNARY_SOURCE, replaceDataset as replaceQuaternaries } from './loadQuaternaries.js';
import { QUATERNARY_EVAPORATION_SOURCE } from './loadQuaternaryEvaporation.js';
import { LYNCH_MAP, replaceRainMapDataset, WAAS_MAP } from './rainMap.js';
import { ATLAS_APAN } from './evaporationGrid.js';
import { GEONAMES_SOURCE } from './gazetteer.js';
import { asOwner } from '../__tests__/helpers.js';
import { replaceCroplandDataset } from './croplandGrid.js';
import { LoadError, loadReferenceText, parseLoadRequest, readReferenceText, REFERENCE_KINDS, type ReadObject } from './referenceLoad.js';

const LC = 'test-reference-load-lc';
const RV = 'test-reference-load-rv';
const EV = 'test-reference-load-ev';
const GZ = 'test-reference-load-gz';
const GZN = 'test-reference-load-gz-neighbours';
// The one MAP grid label production allows (REFERENCE_KINDS['map-grid'].datasets): only this file writes it in water_test.
const MG = WAAS_MAP.dataset;
const LY = LYNCH_MAP.dataset;
// The one A-pan label production allows (REFERENCE_KINDS.evaporation.apanDatasets): only this file writes it in water_test.
const AP = ATLAS_APAN.dataset;
const WB = 'Test-Waterbodies';
const QT = 'Test-Quaternaries';
const QE = 'Test-Quaternary-Evaporation';
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
	await client.query('DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [[EV, AP]]);
	await client.query('DELETE FROM gazetteer_reference WHERE dataset = ANY($1::text[])', [[GZ, GZN]]);
	await client.query('DELETE FROM rain_map_dataset WHERE dataset = ANY($1::text[])', [[MG, LY]]);
	await client.query('DELETE FROM waterbody_reference WHERE dataset = $1', [WB]);
	await client.query('DELETE FROM quaternary_reference WHERE dataset = $1', [QT]);
	await client.query('DELETE FROM quaternary_evaporation WHERE dataset = $1', [QE]);
	await client.query('DELETE FROM reference_load WHERE dataset = ANY($1::text[])', [[LC, `${LC}-other`, RV, EV, GZ, GZN, MG, LY, AP, WB, QT, QE]]);
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

	it('the WRC Atlas’s A-pan grid (12 monthly ASCII grids through --apan-asc --out) loads as Atlas-Apan-2007, stored with its recorded, modelled lines', async () => {
		const args = parseEvaporationArgs(['--apan-asc', ...SYNTHETIC_APAN_ASC_FILES, '--dataset', AP, '--years', '1950-1999']);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const out = join(dir, 'atlas-apan.json.gz');
		const { written: wrote } = await writeEvaporationJson({ ...args, out });
		// The file says something else: the load stores the recorded lines whatever it says.
		const doc = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
		const bytes = gzipSync(JSON.stringify({ ...doc, source: 'Not the Atlas', attribution: 'Someone else' }));
		const result = await load({ kind: 'evaporation', key: 'reference/evaporation/atlas-apan-2007.json.gz', dataset: AP }, bytes);
		expect(result).toEqual({ kind: 'evaporation', dataset: AP, written: wrote, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('evaporation', AP)).toEqual({ key: 'reference/evaporation/atlas-apan-2007.json.gz', sha256: sha(bytes) });
		const [d] = await asOwner('SELECT kind, source, version, attribution, method, first_year, last_year FROM evaporation_dataset WHERE dataset = $1', [AP]);
		expect(d).toMatchObject({ kind: 'apan', source: ATLAS_APAN.source, version: ATLAS_APAN.version, attribution: ATLAS_APAN.attribution, first_year: 1950, last_year: 1999 });
		expect(d!.method).toMatch(/^Modelled, not measured: the WRC Atlas’s A-pan equivalent/);
		expect(await asOwner('SELECT count(*)::int AS n FROM evaporation_cell_reference WHERE dataset = $1', [AP])).toEqual([{ n: 10 }]);
	});

	it('under the Atlas label, a PenPan grid or a reference-ET file is refused, a source too; another A-pan label stays refused; the dataset stays as it was', async () => {
		const penpan = gzipSync(readFileSync(SYNTHETIC_PENPAN_FILE));
		for (const [bytes, why] of [
			[penpan, /PenPan grid is not Atlas-Apan-2007/],
			[grid('et0', [[21.25, -33.75, twelve(100)]]), /an A-pan grid's label: this file is reference ET/]
		] as const) {
			const e = await load({ kind: 'evaporation', key: 'reference/evaporation/x.json.gz', dataset: AP }, bytes).catch((err: unknown) => err);
			expect(e, String(why)).toBeInstanceOf(LoadError);
			expect((e as LoadError).code).toBe('refused');
			expect((e as LoadError).publicReason).toMatch(why);
		}
		expect(() => parseLoadRequest({ kind: 'evaporation', key: 'reference/evaporation/x.json.gz', sha256: 'c'.repeat(64), dataset: AP, source: 'Mine' })).toThrow(/takes no source/);
		// The PenPan grid under a label of its own, and any A-pan grid under another label: refused, naming the allowed one.
		for (const dataset of ['PenPan-1991-2020', 'Atlas-Apan-2008']) {
			const e = await load({ kind: 'evaporation', key: 'reference/evaporation/x.json.gz', dataset }, penpan).catch((err: unknown) => err);
			expect((e as LoadError).publicReason, dataset).toMatch(/only a reference-ET grid .*or an A-pan grid under a label whose licence is recorded: Atlas-Apan-2007/);
		}
		expect(await asOwner('SELECT count(*)::int AS n FROM evaporation_dataset WHERE dataset = ANY($1::text[])', [['PenPan-1991-2020', 'Atlas-Apan-2008']])).toEqual([{ n: 0 }]);
		expect(await asOwner('SELECT source, first_year FROM evaporation_dataset WHERE dataset = $1', [AP])).toEqual([{ source: ATLAS_APAN.source, first_year: 1950 }]);
		expect(await recorded('evaporation', AP)).toMatchObject({ key: 'reference/evaporation/atlas-apan-2007.json.gz' });
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

	it('the Lynch (2004) grid loads as Lynch-2004 (the operator’s decision of 2026-11-08), stored with the Atlas’s citation, not the file’s', async () => {
		const args = parseMapGridArgs([]);
		if (typeof args === 'string') throw new Error(args);
		const out = join(dir, 'lynch.json.gz');
		const wrote = await writeMapGridJson({ ...args, out });
		const bytes = readFileSync(out);
		const result = await load({ kind: 'map-grid', key: 'reference/map-grid/lynch-2004.json.gz', dataset: LY }, bytes);
		expect(result).toEqual({ kind: 'map-grid', dataset: LY, written: wrote, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('map-grid', LY)).toEqual({ key: 'reference/map-grid/lynch-2004.json.gz', sha256: sha(bytes) });
		const [d] = await asOwner('SELECT source, version, attribution, cell_count FROM rain_map_dataset WHERE dataset = $1', [LY]);
		expect(d).toEqual({ source: LYNCH_MAP.source, version: LYNCH_MAP.version, attribution: LYNCH_MAP.attribution, cell_count: wrote });
	});
});

describe('quaternaries, from the file `import:quaternaries --out` writes (the operator’s decision, 2026-11-02)', () => {
	// Invented outlines in drainage region Y, out at sea: quaternary_reference is keyed by code across datasets, so these
	// never touch the synthetic fixture's region Z that the other DB files read. The WR2012-style values come from a CSV.
	const cell = (x: number, y: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.2, y], [x + 0.2, y + 0.2], [x, y + 0.2], [x, y]]] });
	const boundaries = {
		type: 'FeatureCollection',
		features: [
			{ type: 'Feature', properties: { QUATERNARY: 'Y01A' }, geometry: cell(5, -45) },
			{ type: 'Feature', properties: { QUATERNARY: 'Y01B' }, geometry: cell(5.2, -45) }
		]
	};
	const csv = ['code,area_km2,map_mm,mar_mm3,oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep,period_start,period_end', 'Y01A,450,600,12,1,1,1,1,1,1,1,1,1,1,1,1,1920,2009'].join('\n');
	const file = (source: string) => {
		const [geojson, values, out] = ['b.geojson', 'v.csv', 'q.geojson.gz'].map((f) => join(dir, f)) as [string, string, string];
		writeFileSync(geojson, JSON.stringify(boundaries));
		writeFileSync(values, csv);
		expect(writeQuaternariesJson({ file: geojson, dataset: QT, source, values, out })).toEqual({ written: 2, problems: [] });
		return readFileSync(out);
	};
	const rows = () => asOwner('SELECT code, area_km2, map_mm, mar_mm3, monthly_mm3, period_start, period_end, source FROM quaternary_reference WHERE dataset = $1 ORDER BY code', [QT]);

	it('loads the outlines with their values, every row with the recorded DWS and WR2012 credit, not the file’s, and records the file', async () => {
		const bytes = file('the file’s own source line');
		const result = await load({ kind: 'quaternaries', key: 'reference/quaternaries/test.geojson.gz', dataset: QT }, bytes);
		expect(result).toEqual({ kind: 'quaternaries', dataset: QT, written: 2, skipped: 0, belowOrder: 0, replaced: null });
		expect(await recorded('quaternaries', QT)).toEqual({ key: 'reference/quaternaries/test.geojson.gz', sha256: sha(bytes) });
		const got = await rows();
		expect(got.map((r) => r.code)).toEqual(['Y01A', 'Y01B']);
		expect(got[0]).toMatchObject({ area_km2: 450, map_mm: 600, mar_mm3: 12, monthly_mm3: Array(12).fill(1), period_start: 1920, period_end: 2009 });
		// Y01B has no values in the CSV: its area is the polygon's own, the rest empty.
		expect(got[1]).toMatchObject({ map_mm: null, mar_mm3: null, monthly_mm3: null });
		expect(got[1]!.area_km2).toBeGreaterThan(0);
		for (const r of got) expect(r.source).toBe(QUATERNARY_SOURCE);
		expect(QUATERNARY_SOURCE).toMatch(/Department of Water and Sanitation/);
		expect(QUATERNARY_SOURCE).toMatch(/WR2012/);
	});

	it('the load’s own source replaces the recorded one; a second load replaces the dataset and names the file it replaced', async () => {
		// No --source: the file carries the recorded credit rather than skipping every feature.
		const bytes = file('');
		const result = await load({ kind: 'quaternaries', key: 'reference/quaternaries/test-2.geojson.gz', dataset: QT, source: 'WR2012 (WRC 2015), test volume' }, bytes);
		expect(result.replaced).toMatchObject({ key: 'reference/quaternaries/test.geojson.gz' });
		expect(new Set((await rows()).map((r) => r.source))).toEqual(new Set(['WR2012 (WRC 2015), test volume']));
	});

	it('a file with no quaternary fails and leaves the dataset as it was; a local replace clears the record', async () => {
		const before = await rows();
		const err = await load({ kind: 'quaternaries', key: 'reference/quaternaries/none.geojson', dataset: QT }, Buffer.from('{"type":"FeatureCollection","features":[]}')).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('empty');
		expect(await rows()).toEqual(before);
		expect(await recorded('quaternaries', QT)).toBeDefined();
		await replaceQuaternaries(client, QT, []);
		expect(await recorded('quaternaries', QT)).toBeUndefined();
	});
});

describe('quaternary-evaporation, from the CSV wrsm_evaporation.py writes (the operator’s decision, 2026-11-03)', () => {
	// Invented rows in drainage region Y: quaternary_evaporation is keyed by (dataset, code), so this dataset never
	// touches the synthetic one the other DB files read.
	const months = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
	const head = ['code', ...months.map((m) => `span_${m}`), ...months.map((m) => `apan_${m}`), 'span_modules', 'span_agree', 'span_files'].join(',');
	const S = [150, 180, 205, 210, 170, 150, 100, 70, 55, 55, 75, 110];
	const csv = [head, ['Y01A', ...S, ...S.map((v) => v + 40), 2, 2, 'Y1RU1.DAT Y1RU2.DAT'].join(','), ['bad', ...S, ...S].join(',')].join('\n');
	const rows = () => asOwner('SELECT code, span_modules, span_files, source FROM quaternary_evaporation WHERE dataset = $1 ORDER BY code', [QE]);

	it('loads the rows with the recorded credit, refuses a bad row by name, and records the file', async () => {
		const bytes = Buffer.from(csv);
		const result = await load({ kind: 'quaternary-evaporation', key: 'reference/quaternary-evaporation/test.csv', dataset: QE }, bytes);
		expect(result).toEqual({ kind: 'quaternary-evaporation', dataset: QE, written: 1, skipped: 1, belowOrder: 0, replaced: null });
		expect(await recorded('quaternary-evaporation', QE)).toEqual({ key: 'reference/quaternary-evaporation/test.csv', sha256: sha(bytes) });
		expect(await rows()).toEqual([{ code: 'Y01A', span_modules: 2, span_files: ['Y1RU1.DAT', 'Y1RU2.DAT'], source: QUATERNARY_EVAPORATION_SOURCE }]);
		expect(QUATERNARY_EVAPORATION_SOURCE).toMatch(/WR2012 \(WRC 2015\), WRSM2000 network configurations, WMAs 16–19/);
	});

	it('a file with no usable row fails and leaves the dataset as it was', async () => {
		const before = await rows();
		const err = await load({ kind: 'quaternary-evaporation', key: 'reference/quaternary-evaporation/none.csv', dataset: QE }, Buffer.from(head)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('empty');
		expect(await rows()).toEqual(before);
	});
});

describe('DE Africa Waterbodies polygons (261, issue #604 R5)', () => {
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

describe('DWS verified daily flow, into the gauge record store (issue #618 step 6b)', () => {
	// The synthetic reply's invented station, and one only this describe writes. The gauge store has no dataset of its own:
	// every row and span of these stations with origin dws is this describe's (DB files run one at a time).
	const STATIONS = ['X0H001', 'X9H901'];
	const LABELS = ['test-dws-jan-mar', 'test-dws-apr-jun', 'test-dws-bad', 'test-dws-future', 'test-dws-other', 'test-dws-given'];
	const REF = 'SYNTHETIC-REPLY-0001';
	const dws = (dataset: string, key = 'reference/dws/reply-01.txt.gz') => ({ kind: 'dws', key, dataset, source: REF });
	const reply = () => readFileSync(SYNTHETIC_DWS_REPLY);

	/** A DWS daily table (the HyData.aspx layout the feed reads) naming `named` before its header, with one row per day from `from`. */
	const table = (named: string | null, from: string, values: (number | null)[]) =>
		[
			'SYNTHETIC test table: invented values.',
			...(named ? [`${named} (SYNTHETIC WEIR)`] : []),
			'POS.  1-8   = Date of daily flow  CCYYMMDD',
			'POS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999',
			'POS. 20-24  = Quality code',
			'',
			'DATE     D AVG F/R  QUAL',
			...values.map((v, i) => `${fromEpochDay(toEpochDay(from) + i).replaceAll('-', '')}${(v === null ? '' : v.toFixed(3)).padStart(10)}${(v === null ? '170' : '1').padStart(6)}`)
		].join('\n');

	const rows = (station = 'X0H001') =>
		asOwner(
			`SELECT count(*)::int AS n, count(*) FILTER (WHERE source = 'dws-request' AND reference = $2)::int AS ours, count(*) FILTER (WHERE value IS NULL)::int AS gaps
			 FROM gauge_record WHERE origin = 'dws' AND station = $1`,
			[station, REF]
		);
	const spans = (station = 'X0H001') =>
		asOwner(
			`SELECT source, to_char(day_from, 'YYYY-MM-DD') AS f, to_char(day_to, 'YYYY-MM-DD') AS t, reference FROM gauge_record_span WHERE origin = 'dws' AND station = $1 ORDER BY day_from`,
			[station]
		);
	const clean = async () => {
		await asOwner(`DELETE FROM gauge_record WHERE origin = 'dws' AND station = ANY($1::text[])`, [STATIONS]);
		await asOwner(`DELETE FROM gauge_record_span WHERE origin = 'dws' AND station = ANY($1::text[])`, [STATIONS]);
		await asOwner(`DELETE FROM reference_load WHERE kind = 'dws' AND dataset = ANY($1::text[])`, [LABELS]);
	};
	beforeAll(clean);
	afterAll(clean);

	it('loads the synthetic reply (gzipped) as dws-request rows, origin dws, with its reference, and records the file', async () => {
		const bytes = gzipSync(reply());
		const got = await load(dws('test-dws-jan-mar'), bytes);
		expect(got).toEqual({ kind: 'dws', dataset: 'test-dws-jan-mar', written: 89, skipped: 0, belowOrder: 0, replaced: null });
		expect(await rows()).toEqual([{ n: 89, ours: 89, gaps: 1 }]);
		expect(await spans()).toEqual([{ source: 'dws-request', f: '2010-01-01', t: '2010-03-31', reference: REF }]);
		expect(await recorded('dws', 'test-dws-jan-mar')).toEqual({ key: 'reference/dws/reply-01.txt.gz', sha256: sha(bytes) });
		// What a feed reads: the reply is the best source for these days.
		expect(await asOwner(`SELECT DISTINCT source FROM gauge_record_current WHERE origin = 'dws' AND station = 'X0H001'`)).toEqual([{ source: 'dws-request' }]);
	});

	it('a re-load of the same file writes the same rows again, one span, and names the load it replaced', async () => {
		const got = await load(dws('test-dws-jan-mar'), gzipSync(reply()));
		expect(got.written).toBe(89);
		expect(got.replaced).toMatchObject({ key: 'reference/dws/reply-01.txt.gz' });
		expect(await rows()).toEqual([{ n: 89, ours: 89, gaps: 1 }]);
		expect(await spans()).toHaveLength(1);
	});

	it('the next window of the station (a second file, plain text) merges with the first into one span', async () => {
		const values = Array.from({ length: 91 }, (_, i) => 2 + i / 100);
		const got = await load(dws('test-dws-apr-jun', 'reference/dws/reply-02.txt'), Buffer.from(table('X0H001', '2010-04-01', values)));
		expect(got.written).toBe(91);
		expect(await rows()).toEqual([{ n: 180, ours: 180, gaps: 1 }]);
		expect(await spans()).toEqual([{ source: 'dws-request', f: '2010-01-01', t: '2010-06-30', reference: REF }]);
		// Each file is recorded under its own label.
		expect(await recorded('dws', 'test-dws-jan-mar')).toBeDefined();
		expect(await recorded('dws', 'test-dws-apr-jun')).toMatchObject({ key: 'reference/dws/reply-02.txt' });
	});

	it('a file the reader refuses (a date that doesn’t exist) writes nothing and records nothing', async () => {
		const bad = table('X0H001', '2010-07-01', [1, 2, 3]).replace('20100703', '20100231');
		const err = await load(dws('test-dws-bad', 'reference/dws/bad.txt'), Buffer.from(bad)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('unreadable');
		// Fixed text only: the public log never quotes the file.
		expect((err as LoadError).publicReason).toMatch(/^the file is not a DWS daily flow table/);
		expect((err as LoadError).publicReason).not.toContain('20100231');
		expect(await rows()).toEqual([{ n: 180, ours: 180, gaps: 1 }]);
		expect(await recorded('dws', 'test-dws-bad')).toBeUndefined();
	});

	it('a file the store refuses in a later chunk (a day after today) writes nothing, not even the earlier chunk', async () => {
		// 7 300 days ending tomorrow in South Africa: the first call (CHUNK_DAYS) is a good one, the second ends after today.
		const today = (await asOwner(`SELECT to_char((now() AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS d`))[0]!.d as string;
		const first = fromEpochDay(toEpochDay(today) - 7298);
		const tomorrow = fromEpochDay(toEpochDay(today) + 1).replaceAll('-', '');
		const future = `${table('X9H901', first, [1, 2, 3])}\n${tomorrow}${'4.000'.padStart(10)}${'1'.padStart(6)}`;
		const err = await load(dws('test-dws-future', 'reference/dws/future.txt'), Buffer.from(future)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LoadError);
		expect((err as LoadError).code).toBe('load_failed');
		expect((err as LoadError).publicReason).toMatch(/^the store refused a row/);
		expect(await rows('X9H901')).toEqual([{ n: 0, ours: 0, gaps: 0 }]);
		expect(await spans('X9H901')).toEqual([]);
		expect(await recorded('dws', 'test-dws-future')).toBeUndefined();
	});

	it('the station: the file’s, else the one the request gives; a request naming another than the file’s is refused', async () => {
		const values = [1.25, 1.5];
		const other = await load({ ...dws('test-dws-other', 'reference/dws/reply-03.txt'), station: 'X9H901' }, Buffer.from(table('X0H001', '2011-01-01', values))).catch((e: unknown) => e);
		expect(other).toBeInstanceOf(LoadError);
		expect((other as LoadError).publicReason).toBe('the file names another station than the one given');
		expect(await rows('X9H901')).toEqual([{ n: 0, ours: 0, gaps: 0 }]);

		const unnamed = Buffer.from(table(null, '2011-01-01', values));
		const none = await load(dws('test-dws-given', 'reference/dws/reply-04.txt'), unnamed).catch((e: unknown) => e);
		expect(none).toBeInstanceOf(LoadError);
		expect((none as LoadError).publicReason).toBe('the file names no station, or several: give the station');
		expect((await load({ ...dws('test-dws-given', 'reference/dws/reply-04.txt'), station: 'X9H901' }, unnamed)).written).toBe(2);
		expect(await spans('X9H901')).toEqual([{ source: 'dws-request', f: '2011-01-01', t: '2011-01-02', reference: REF }]);
	});
});

describe('reference_load takes every kind production allows', () => {
	it('a row of each allowed REFERENCE_KINDS kind passes reference_load_kind_check; a blocked kind does not', async () => {
		const allowed = Object.entries(REFERENCE_KINDS)
			.filter(([, spec]) => spec.status === 'allowed')
			.map(([kind]) => kind);
		expect(allowed).toContain('dws');
		expect(allowed).toContain('waterbodies');
		expect(allowed).toContain('quaternaries');
		expect(allowed).toContain('quaternary-evaporation');
		await client.query('BEGIN');
		try {
			for (const kind of allowed) {
				// A tiles row names one of the archives at its served key (248's reference_load_tiles_archive).
				const [dataset, key] = kind === 'tiles' ? ['basemap', 'tiles/south-africa.pmtiles'] : ['test-kind-check', `reference/${kind}/x`];
				await client.query('DELETE FROM reference_load WHERE kind = $1 AND dataset = $2', [kind, dataset]);
				await client.query('INSERT INTO reference_load (kind, dataset, source_key, source_sha256) VALUES ($1, $2, $3, $4)', [kind, dataset, key, 'a'.repeat(64)]);
			}
			await expect(
				client.query(`INSERT INTO reference_load (kind, dataset, source_key, source_sha256) VALUES ('dam-register', 'x', 'reference/dam-register/x', $1)`, ['a'.repeat(64)])
			).rejects.toMatchObject({ code: '23514' });
		} finally {
			await client.query('ROLLBACK');
		}
	});
});
