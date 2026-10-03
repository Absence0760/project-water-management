// Map feature names are one line (192_feature_names_reference_load, issue
// #385's follow-up): the routes refuse a line break or other control
// character in a name typed in, the stored ones are cleaned by the migration,
// and a CHECK keeps any path that skips the API (a script, the bulk readers'
// own bug) from storing one again. The river network's reach names, which a
// reach added to a project carries, are cleaned and held the same way. The
// bulk readers' cleaning is unit-tested beside them (geojson.test.ts,
// loadRivers.test.ts). Needs Postgres (pnpm dev:db:up).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

const MIGRATION = readFileSync(new URL('../../migrations/192_feature_names_reference_load.sql', import.meta.url), 'utf8');
/** The migration's name cleaning (its two UPDATEs), without the CHECKs and the table that follow. */
const CLEANING = MIGRATION.slice(0, MIGRATION.indexOf('ALTER TABLE map_feature ADD CONSTRAINT'));
const CHECK = (t: string) => MIGRATION.split('\n').find((l) => l.startsWith(`ALTER TABLE ${t} ADD CONSTRAINT`))!;
const POINT = { type: 'Point', coordinates: [21.3, -33.6] };

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let pid: string;

beforeAll(async () => {
	owner = await signUp('FeatureNames');
	pid = (await owner.call('POST', '/projects', { name: 'FeatureNames' })).body.project.id as string;
});

describe('192: stored feature and reach names', () => {
	it('the cleaning is two UPDATEs, one per table', () => {
		expect(CLEANING.match(/^UPDATE (\w+)/gm)).toEqual(['UPDATE map_feature', 'UPDATE river_reference']);
	});

	it('makes stored names one line, cut to 100 characters, and leaves an empty or clean one as it is', async () => {
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			// As the data was before 192: no CHECK.
			await client.query('ALTER TABLE map_feature DROP CONSTRAINT map_feature_name_one_line');
			await client.query('ALTER TABLE river_reference DROP CONSTRAINT river_reference_name_one_line');
			const feature = async (name: string) =>
				(await client.query<{ id: string }>(`INSERT INTO map_feature (project_id, kind, name, geometry) VALUES ($1, 'gauge', $2, $3) RETURNING id`, [pid, name, JSON.stringify(POINT)])).rows[0]!.id;
			const weir = await feature('Weir\r\non the\tKlein');
			const blank = await feature('\u0007\n');
			const long = await feature(`${'x'.repeat(98)} y`);
			const clean = await feature('Mid weir');
			const empty = await feature('');
			const line = { type: 'LineString', coordinates: [[21.3, -33.6], [21.4, -33.7]] };
			await client.query(
				`INSERT INTO river_reference (dataset, reach_id, name, geometry, min_lon, min_lat, max_lon, max_lat, source)
				 VALUES ('test-192', 1, $1, $2, 21.3, -33.7, 21.4, -33.6, 'Test'), ('test-192', 2, 'Klein River', $2, 21.3, -33.7, 21.4, -33.6, 'Test')`,
				['Klein\u0085River', JSON.stringify(line)]
			);

			await client.query(CLEANING);

			const name = async (id: string) => (await client.query<{ name: string }>('SELECT name FROM map_feature WHERE id = $1', [id])).rows[0]!.name;
			expect(await name(weir)).toBe('Weir on the Klein');
			expect(await name(blank)).toBe('');
			expect(await name(long)).toBe(`${'x'.repeat(98)} y`.slice(0, 100));
			expect(await name(clean)).toBe('Mid weir');
			expect(await name(empty)).toBe('');
			const reaches = await client.query(`SELECT reach_id::int AS id, name FROM river_reference WHERE dataset = 'test-192' ORDER BY reach_id`);
			expect(reaches.rows).toEqual([
				{ id: 1, name: 'Klein River' },
				{ id: 2, name: 'Klein River' }
			]);

			// Every name now passes the CHECKs the migration adds.
			await client.query(CHECK('map_feature'));
			await client.query(CHECK('river_reference'));
		} finally {
			await client.query('ROLLBACK');
			await client.end();
		}
	});

	it('the CHECKs refuse a control character in a stored name (positive control: one line is stored)', async () => {
		const insert = (name: string) => asOwner(`INSERT INTO map_feature (project_id, kind, name, geometry) VALUES ($1, 'gauge', $2, $3) RETURNING name`, [pid, name, JSON.stringify(POINT)]);
		for (const bad of ['Weir\nA', 'Weir\u0085A', 'Weir A', 'Weir\tA']) await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
		expect(await insert('Weir A')).toEqual([{ name: 'Weir A' }]);
		await expect(
			asOwner(
				`INSERT INTO river_reference (dataset, reach_id, name, geometry, min_lon, min_lat, max_lon, max_lat, source) VALUES ('test-192-check', 1, $1, $2, 0, 0, 1, 1, 'Test')`,
				['Klein\nRiver', JSON.stringify({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })]
			)
		).rejects.toMatchObject({ code: '23514' });
	});
});

describe('the feature routes refuse a name that is not one line', () => {
	const at = (p: string) => `/projects/${pid}${p}`;

	it('POST and PATCH /map/features: 400 for a line break or control character, 201/200 for one line', async () => {
		for (const name of ['Weir\nA', 'Weir A', 'Weir\u0007A']) {
			const r = await owner.call('POST', at('/map/features'), { kind: 'gauge', name, lon: 21.3, lat: -33.6 });
			expect(r.status, JSON.stringify(name)).toBe(400);
			expect(JSON.stringify(r.body)).toMatch(/cannot contain line breaks or control characters/);
		}
		// Leading and trailing whitespace is trimmed, as before, not refused.
		const ok = await owner.call('POST', at('/map/features'), { kind: 'gauge', name: '  Weir A\n', lon: 21.3, lat: -33.6 });
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
		expect(ok.body.feature.name).toBe('Weir A');
		const fid = ok.body.feature.id as string;
		expect((await owner.call('PATCH', at(`/map/features/${fid}`), { name: 'Weir\r\nB' })).status).toBe(400);
		const renamed = await owner.call('PATCH', at(`/map/features/${fid}`), { name: 'Weir B' });
		expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
		expect(renamed.body.feature.name).toBe('Weir B');
	});

	it('the GeoJSON import makes a file’s names one line rather than refusing the file', async () => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [{ type: 'Feature', properties: { name: 'Lower\nweir' }, geometry: { type: 'Point', coordinates: [21.31, -33.61] } }]
		});
		const r = await owner.call('POST', at('/map/import'), { kind: 'gauge', fileName: 'weirs.geojson', text });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const names = (await asOwner(`SELECT name FROM map_feature WHERE project_id = $1 AND source_id IS NOT NULL`, [pid])).map((x) => x.name);
		expect(names).toEqual(['Lower weir']);
	});
});
