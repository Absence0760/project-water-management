// A tile archive's provenance (248_reference_load_provenance; geo/referenceOrigin.ts):
//  - the schema owner records it (recordTileProvenance), one row per archive,
//    the next upload replacing it and returning the record it replaced;
//  - the table holds a tiles row to its archive's served key, an https
//    upstream and a list of originals;
//  - a production `tiles` load (referenceLoad.ts) records the provenance file
//    tiles-upload.ts writes, the licence from TILE_ARCHIVES, never the file's;
//  - water_app reads it only through app_reference_provenance(): version,
//    upstream date and licence, never a key, hash or ETag; it can't read the
//    table itself (positive control: it can call the function), and PUBLIC
//    can't execute the function;
//  - the Map's dataset lines (the DEM grid's, delineation's and tracing's)
//    show the recorded version and dates, and nothing extra before any is
//    recorded (the positive control for the label).
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { FIXTURE_CELLS, FIXTURE_FILE, fixtureLonLat } from '../delineation/fixture.js';
import { WATER_FIXTURE_FILE } from '../delineation/waterFixture.js';
import { loadReferenceText, parseLoadRequest, readReferenceText } from './referenceLoad.js';
import { recordTileProvenance, referenceProvenance, TILE_ARCHIVES, tileProvenanceFile, type TileProvenance } from './referenceOrigin.js';
import { createHash } from 'node:crypto';

const APP_URL = process.env.DATABASE_URL!;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const today = new Date().toISOString().slice(0, 10);

const terrain: TileProvenance = {
	archive: 'terrain',
	sha256: sha('terrain archive'),
	bytes: 2_200_000_000,
	upstream: { url: 'https://download.mapterhorn.com/planet.pmtiles', version: '0.0.13', etag: '"abc-123"', lastModified: '2026-09-30T08:00:00Z' },
	originals: [{ key: 'originals/terrain/0.0.13-terrain.pmtiles', sha256: sha('terrain archive'), bytes: 2_200_000_000 }]
};

let owner: pg.Client;
/** Rows of reference_load this file overwrites, put back after. */
let saved: Record<string, unknown>[] = [];
const ARCHIVES = ['terrain', 'water', 'basemap'];

beforeAll(async () => {
	owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await owner.connect();
	saved = (await owner.query(`SELECT * FROM reference_load WHERE kind = 'tiles' AND dataset = ANY($1::text[])`, [ARCHIVES])).rows;
	await owner.query(`DELETE FROM reference_load WHERE kind = 'tiles' AND dataset = ANY($1::text[])`, [ARCHIVES]);
});

afterAll(async () => {
	await owner.query(`DELETE FROM reference_load WHERE kind = 'tiles' AND dataset = ANY($1::text[])`, [ARCHIVES]);
	for (const r of saved) {
		const cols = Object.keys(r);
		await owner.query(
			`INSERT INTO reference_load (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
			cols.map((c) => (c === 'originals' && r[c] !== null ? JSON.stringify(r[c]) : r[c]))
		);
	}
	await owner.end();
});

describe('recording a tile archive', () => {
	it('records it as the owner, with the licence from the table, and the next upload replaces it', async () => {
		expect(await recordTileProvenance(owner, terrain)).toBeNull();
		const [row] = (await owner.query(`SELECT * FROM reference_load WHERE kind = 'tiles' AND dataset = 'terrain'`)).rows;
		expect(row).toMatchObject({
			source_key: 'tiles/terrain.pmtiles',
			source_sha256: terrain.sha256,
			upstream_url: terrain.upstream.url,
			upstream_version: '0.0.13',
			upstream_etag: '"abc-123"',
			licence: TILE_ARCHIVES.terrain.licence,
			originals: terrain.originals
		});
		expect((row.upstream_last_modified as Date).toISOString()).toBe('2026-09-30T08:00:00.000Z');
		const next = { ...terrain, sha256: sha('the next build'), upstream: { ...terrain.upstream, version: '0.0.14' }, originals: [] };
		const replaced = await recordTileProvenance(owner, next);
		expect(replaced).toMatchObject({ key: 'tiles/terrain.pmtiles', sha256: terrain.sha256 });
		const after = (await owner.query(`SELECT source_sha256, upstream_version, originals FROM reference_load WHERE kind = 'tiles' AND dataset = 'terrain'`)).rows;
		expect(after).toEqual([{ source_sha256: next.sha256, upstream_version: '0.0.14', originals: null }]);
		await recordTileProvenance(owner, terrain);
	});

	it('holds a tiles row to its archive’s served key, an https upstream and a list of originals', async () => {
		const insert = (dataset: string, key: string, extra = '') =>
			owner.query(`INSERT INTO reference_load (kind, dataset, source_key, source_sha256${extra ? ', upstream_url' : ''}) VALUES ('tiles', $1, $2, $3${extra ? ', $4' : ''})`, [
				dataset,
				key,
				'a'.repeat(64),
				...(extra ? [extra] : [])
			]);
		await expect(insert('water', 'tiles/terrain.pmtiles')).rejects.toThrow(/reference_load_tiles_archive/);
		await expect(insert('rivers', 'tiles/rivers.pmtiles')).rejects.toThrow(/reference_load_tiles_archive/);
		await expect(insert('water', 'tiles/water.pmtiles', 'http://example.com/x')).rejects.toThrow(/upstream_url/);
		await expect(
			owner.query(`UPDATE reference_load SET originals = '{"key": "x"}' WHERE kind = 'tiles' AND dataset = 'terrain'`)
		).rejects.toThrow(/originals/);
		// Positive control: the right key goes in.
		await insert('water', 'tiles/water.pmtiles', 'https://example.com/occurrence.tif');
		await owner.query(`DELETE FROM reference_load WHERE kind = 'tiles' AND dataset = 'water'`);
	});

	it('a production `tiles` load records the provenance file, for the archive it names only', async () => {
		const water: TileProvenance = { ...terrain, archive: 'water', upstream: { url: 'https://example.com/occurrence.tif', version: '1.5', etag: null, lastModified: null }, originals: [] };
		const bytes = Buffer.from(JSON.stringify(tileProvenanceFile(water)));
		const req = parseLoadRequest({ kind: 'tiles', key: 'reference/tiles/water-20261027.json', sha256: sha(bytes), dataset: 'water' });
		const read = async () => ({ contentLength: bytes.byteLength, bytes: async () => new Uint8Array(bytes) });
		const result = await loadReferenceText(owner, req, await readReferenceText(req, read));
		expect(result).toMatchObject({ kind: 'tiles', dataset: 'water', written: 1, replaced: null });
		const [row] = (await owner.query(`SELECT source_key, upstream_version, licence FROM reference_load WHERE kind = 'tiles' AND dataset = 'water'`)).rows;
		expect(row).toEqual({ source_key: 'tiles/water.pmtiles', upstream_version: '1.5', licence: TILE_ARCHIVES.water.licence });
		// The same file named as another archive is refused, and records nothing.
		const wrong = parseLoadRequest({ kind: 'tiles', key: 'reference/tiles/water-20261027.json', sha256: sha(bytes), dataset: 'basemap' });
		await expect(loadReferenceText(owner, wrong, bytes.toString())).rejects.toMatchObject({ code: 'refused' });
		expect((await owner.query(`SELECT 1 FROM reference_load WHERE kind = 'tiles' AND dataset = 'basemap'`)).rows).toEqual([]);
		await owner.query(`DELETE FROM reference_load WHERE kind = 'tiles' AND dataset = 'water'`);
	});
});

describe('what the app may read', () => {
	it('water_app reads the version, dates and licence through app_reference_provenance(), and the table not at all', async () => {
		const app = new pg.Client({ connectionString: APP_URL });
		await app.connect();
		try {
			const lines = await referenceProvenance(app);
			expect(lines.find((l) => l.kind === 'tiles' && l.dataset === 'terrain')).toEqual({
				kind: 'tiles',
				dataset: 'terrain',
				version: '0.0.13',
				upstreamDate: '2026-09-30',
				licence: TILE_ARCHIVES.terrain.licence,
				recordedOn: today
			});
			const { fields } = await app.query('SELECT * FROM app_reference_provenance()');
			expect(fields.map((f) => f.name)).toEqual(['kind', 'dataset', 'upstream_version', 'upstream_last_modified', 'licence', 'loaded_at']);
			await expect(app.query('SELECT source_key FROM reference_load')).rejects.toThrow(/permission denied/);
		} finally {
			await app.end();
		}
		const [grants] = await asOwner(
			`SELECT has_function_privilege('water_app', 'app_reference_provenance()', 'EXECUTE') AS app,
			        bool_or(acl.grantee = 0) AS public
			 FROM pg_proc p LEFT JOIN LATERAL aclexplode(p.proacl) acl ON true WHERE p.proname = 'app_reference_provenance'`
		);
		expect(grants).toEqual({ app: true, public: false });
	});
});

describe('the Map’s dataset lines', () => {
	type User = Awaited<ReturnType<typeof signUp>>;
	let user: User;
	let projectId: string;
	const env = { DEM_URL: process.env.DEM_URL, WATER_URL: process.env.WATER_URL };

	beforeAll(async () => {
		process.env.DEM_URL = fileURLToPath(FIXTURE_FILE);
		process.env.WATER_URL = fileURLToPath(WATER_FIXTURE_FILE);
		user = await signUp('ProvenanceLines');
		projectId = (await user.call('POST', '/projects', { name: 'Provenance lines' })).body.project.id;
	}, 60_000);

	afterAll(() => {
		for (const [k, v] of Object.entries(env)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	const [w, n] = fixtureLonLat(FIXTURE_CELLS / 4, FIXTURE_CELLS / 4);
	const [e, s] = fixtureLonLat((3 * FIXTURE_CELLS) / 4, (3 * FIXTURE_CELLS) / 4);
	const demGrid = () => user.call('GET', `/projects/${projectId}/map/dem-grid?bbox=${encodeURIComponent(`${w},${s},${e},${n}`)}`);

	it('show the DEM’s recorded version and dates on the DEM grid and the delineation sheet', async () => {
		const line = `(version 0.0.13, upstream file of 2026-09-30, recorded ${today})`;
		const grid = await demGrid();
		expect(grid.status).toBe(200);
		expect(grid.body.dataset.label).toMatch(/^Synthetic DEM/);
		expect(grid.body.dataset.label.endsWith(line)).toBe(true);
		const del = await user.call('GET', `/projects/${projectId}/map/delineation`);
		expect(del.status).toBe(200);
		expect(del.body.dataset.label.endsWith(line)).toBe(true);
		// The rest of the dataset is the archive's own.
		expect(del.body.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('show the water occurrence’s recorded version on the trace sheet, and nothing extra before one is recorded', async () => {
		const before = await user.call('GET', `/projects/${projectId}/map/dam-trace`);
		expect(before.status).toBe(200);
		expect(before.body.dataset.label).not.toMatch(/version|recorded/);
		await recordTileProvenance(owner, { ...terrain, archive: 'water', upstream: { url: 'https://example.com/occurrence.tif', version: '1.5', etag: null, lastModified: null }, originals: [] });
		const after = await user.call('GET', `/projects/${projectId}/map/dam-trace`);
		expect(after.body.dataset.label).toBe(`${before.body.dataset.label} (version 1.5, recorded ${today})`);
	});
});
