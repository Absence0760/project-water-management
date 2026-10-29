// The GR4J donor basins (269_gr4j_donors.sql; issue #622 step 3): `pnpm
// import:gr4j-donors` loads the committed synthetic donors with the SHA-256
// of their canonical form; they read back exactly as loaded (so the hash can
// be taken again from the table) and build a regional prior whose soil x1
// relation is used (the fixture's x1 follows its PAWC); a production load of
// the same file records its file and stores the recorded attribution; the
// table refuses a basin that is no donor; signed-in users read the set (the
// positive control), a session with no user reads none, water_app never
// writes it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { regionalPrior } from '@water-management/engine';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticDonors, parseDonorsArgs, readDonorsFile, SYNTHETIC_DONORS_FILE } from '../../scripts/import-gr4j-donors.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { donorDatasets, donorSetSha256, GR4J_DONORS, readDonors, SYNTHETIC_DONOR_DATASET, toEngineDonor } from './gr4jDonors.js';
import { loadReferenceText, parseLoadRequest, readReferenceText } from './referenceLoad.js';

const URL_ = () => process.env.TEST_MIGRATION_DATABASE_URL!;
const PROD = 'test-donors-prod';
const FILE = readDonorsFile({ file: SYNTHETIC_DONORS_FILE, dataset: SYNTHETIC_DONOR_DATASET });
let user: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
	expect(await loadSyntheticDonors(URL_())).toBe(FILE.donors.length);
	user = await signUp('Donors');
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM gr4j_donor_dataset WHERE dataset = $1', [PROD]);
	await asOwner(`DELETE FROM reference_load WHERE kind = 'gr4j-donors' AND dataset = $1`, [PROD]);
});

describe('the synthetic donors', () => {
	it('load every donor, idempotently, with the set’s SHA-256', async () => {
		expect(FILE.skipped).toEqual([]);
		expect(FILE.donors.length).toBe(14);
		expect(await loadSyntheticDonors(URL_())).toBe(14);
		const [d] = await withUser(user.id, (db) => donorDatasets(db).then((all) => all.filter((x) => x.dataset === SYNTHETIC_DONOR_DATASET)));
		expect(d).toMatchObject({ donors: 14, engineVersion: '1.106.0', synthetic: true, donorSetSha256: donorSetSha256(FILE.donors) });
	});

	it('read back exactly as loaded, so the hash can be taken again from the table', async () => {
		const back = await withUser(user.id, (db) => readDonors(db, SYNTHETIC_DONOR_DATASET));
		expect(back).toEqual([...FILE.donors].sort((a, b) => (a.id < b.id ? -1 : 1)));
		expect(donorSetSha256(back)).toBe(donorSetSha256(FILE.donors));
	});

	it('build a regional prior whose soil x1 relation has skill', async () => {
		const donors = (await withUser(user.id, (db) => readDonors(db, SYNTHETIC_DONOR_DATASET))).map(toEngineDonor);
		const p = regionalPrior({ lon: 21.35, lat: -33.65, attributes: { aridity: 0.4, mapMm: 600, slopeDeg: 6, clayPct: 20, sandPct: 60, forestPct: 5, areaKm2: 150 }, pawcMm: 120 }, donors);
		if (!p.ok) throw new Error(p.reason);
		expect(p.donors).toHaveLength(7);
		expect(p.soil.status).toBe('used');
		expect(p.soilX1!.p50).toBeGreaterThan(200);
		expect(p.soilX1!.p50).toBeLessThan(260);
		expect(p.leaveOneOut?.n).toBe(14);
		expect(p.params.x1.p10).toBeLessThanOrEqual(p.params.x1.p50);
		expect(p.params.x1.p50).toBeLessThanOrEqual(p.params.x1.p90);
	});
});

describe('a production load of the same file', () => {
	it('loads through the reference load, records the file and stores the recorded attribution', async () => {
		const bytes = readFileSync(SYNTHETIC_DONORS_FILE);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const req = parseLoadRequest({ kind: 'gr4j-donors', key: 'reference/gr4j-donors/d1.json', sha256, dataset: PROD });
		const client = new pg.Client({ connectionString: URL_() });
		await client.connect();
		try {
			const result = await loadReferenceText(client, req, await readReferenceText(req, async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes })));
			expect(result).toEqual({ kind: 'gr4j-donors', dataset: PROD, written: 14, skipped: 0, belowOrder: 0, replaced: null });
		} finally {
			await client.end();
		}
		expect(await asOwner(`SELECT source_key, source_sha256 FROM reference_load WHERE kind = 'gr4j-donors' AND dataset = $1`, [PROD])).toEqual([{ source_key: 'reference/gr4j-donors/d1.json', source_sha256: sha256 }]);
		expect(await asOwner('SELECT attribution FROM gr4j_donor_dataset WHERE dataset = $1', [PROD])).toEqual([{ attribution: GR4J_DONORS.attribution }]);
		expect((await withUser(user.id, (db) => donorDatasets(db)))[0]!.dataset).toBe(PROD);
	});

	it('a file with no donor fails and leaves the dataset as it was', async () => {
		const bytes = Buffer.from(JSON.stringify({ kind: 'gr4j-donors', source: 's', version: 'v', method: 'm', engineVersion: '1.106.0', donors: [{ id: 'SYN-X', dorPct: 12 }] }));
		const req = parseLoadRequest({ kind: 'gr4j-donors', key: 'reference/gr4j-donors/none.json', sha256: createHash('sha256').update(bytes).digest('hex'), dataset: PROD });
		const client = new pg.Client({ connectionString: URL_() });
		await client.connect();
		try {
			await expect(loadReferenceText(client, req, await readReferenceText(req, async () => ({ contentLength: bytes.byteLength, bytes: async () => bytes })))).rejects.toMatchObject({ code: 'empty' });
		} finally {
			await client.end();
		}
		expect(await asOwner('SELECT count(*)::int AS n FROM gr4j_donor WHERE dataset = $1', [PROD])).toEqual([{ n: 14 }]);
	});
});

describe('the table', () => {
	it('refuses a basin that is no donor (regulated, or too short a record)', async () => {
		const row = (dor: number, years: number) =>
			asOwner(
				`INSERT INTO gr4j_donor (dataset, basin_id, lon, lat, area_km2, dor_pct, flow_years, x1, x2, x3, x4, kge_fit) VALUES ('synthetic', 'SYN-BAD', 21, -33, 100, $1, $2, 300, 0, 90, 1.7, 0.7)`,
				[dor, years]
			);
		await expect(row(5, 10)).rejects.toThrow(/check constraint/);
		await expect(row(1, 7.9)).rejects.toThrow(/check constraint/);
	});

	it('a signed-in user reads it, a session with no user reads none, and water_app never writes it', async () => {
		const read = await withUser(user.id, (db) => db.query(`SELECT count(*)::int AS n FROM gr4j_donor WHERE dataset = 'synthetic'`));
		expect(read.rows[0]).toEqual({ n: 14 });
		const none = await withoutUser((db) => db.query(`SELECT (SELECT count(*)::int FROM gr4j_donor_dataset) AS d, (SELECT count(*)::int FROM gr4j_donor) AS n`));
		expect(none.rows[0]).toEqual({ d: 0, n: 0 });
		await expect(withUser(user.id, (db) => db.query(`UPDATE gr4j_donor SET x1 = 500 WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(user.id, (db) => db.query(`DELETE FROM gr4j_donor_dataset WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
	});
});

describe('the command line', () => {
	it('loads the fixture with no argument and needs a label for a file', () => {
		expect(parseDonorsArgs([])).toEqual({ file: SYNTHETIC_DONORS_FILE, dataset: 'synthetic' });
		expect(parseDonorsArgs(['d.json'])).toMatch(/--dataset/);
		expect(parseDonorsArgs(['d.json', '--dataset', 'synthetic'])).toMatch(/pick another/);
		expect(parseDonorsArgs(['--dataset', 'x'])).toMatch(/donor file/);
		expect(parseDonorsArgs(['--only', 'x'])).toBe('unknown option --only');
	});
});
