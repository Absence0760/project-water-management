// Migration 233 (issue #523 G9 (b)): the project's licence record says its
// outcome in the authority's words (D14). 161's granted, refused and
// withdrawn become licence_issued, licence_refused and application_withdrawn,
// each keeping its date, expiry and closing date; a project with no outcome
// keeps none. This builds a throwaway database at the schema before 233,
// records outcomes the old way, applies 233 and checks (docs/data-model.md
// § Licence record).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DIR = join(import.meta.dirname, '..', '..', 'migrations');
const dbName = `water_test_m233_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = OWNER_URL.replace(/\/[^/]+$/, `/${dbName}`);

let admin: pg.Client;
let db: pg.Client;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [GRANTED, REFUSED, WITHDRAWN, NONE] = [id(1), id(2), id(3), id(4)];

beforeAll(async () => {
	admin = new pg.Client({ connectionString: OWNER_URL.replace(/\/[^/]+$/, '/water') });
	await admin.connect();
	await admin.query(`CREATE DATABASE "${dbName}" OWNER water`);
	db = new pg.Client({ connectionString: scratchUrl });
	await db.connect();
	const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	for (const f of files.filter((x) => x < '233')) await db.query(await readFile(join(DIR, f), 'utf8'));

	const user = (await db.query<{ id: string }>(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('o@example.com', 'O', 'x') RETURNING id`)).rows[0]!.id;
	const project = (pid: string, outcome: string | null, on: string | null, expires: string | null) =>
		db.query(
			`INSERT INTO project (id, name, created_by, licence_outcome, licence_outcome_on, licence_expires_on, licence_outcome_reason, record_review_due_on)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, '2031-01-01')`,
			[pid, `P ${pid.slice(-1)}`, user, outcome, on, expires, outcome ? 'the letter' : '']
		);
	await project(GRANTED, 'granted', '2026-03-01', '2046-02-28');
	await project(REFUSED, 'refused', '2026-03-01', null);
	await project(WITHDRAWN, 'withdrawn', '2025-06-30', null);
	await project(NONE, null, null, null);
	for (const f of files.filter((x) => x >= '233')) await db.query(await readFile(join(DIR, f), 'utf8'));
});

afterAll(async () => {
	await db?.end().catch(() => {});
	await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
	await admin?.end().catch(() => {});
});

const recordOf = async (pid: string) =>
	(
		await db.query(
			`SELECT licence_outcome AS outcome, to_char(licence_outcome_on, 'YYYY-MM-DD') AS "on", to_char(licence_expires_on, 'YYYY-MM-DD') AS expires,
				to_char(record_closes_on, 'YYYY-MM-DD') AS closes, licence_outcome_reason AS reason, to_char(record_review_due_on, 'YYYY-MM-DD') AS review
			 FROM project WHERE id = $1`,
			[pid]
		)
	).rows[0];

describe('migration 233: the licence record in the authority’s words', () => {
	it('maps granted to licence_issued, closing 3 years after the expiry as before', async () => {
		expect(await recordOf(GRANTED)).toEqual({ outcome: 'licence_issued', on: '2026-03-01', expires: '2046-02-28', closes: '2049-02-28', reason: 'the letter', review: '2031-01-01' });
	});

	it('maps refused and withdrawn, closing 3 years after their date', async () => {
		expect(await recordOf(REFUSED)).toMatchObject({ outcome: 'licence_refused', on: '2026-03-01', expires: null, closes: '2029-03-01' });
		expect(await recordOf(WITHDRAWN)).toMatchObject({ outcome: 'application_withdrawn', on: '2025-06-30', expires: null, closes: '2028-06-30' });
	});

	it('leaves a project with no outcome without one', async () => {
		expect(await recordOf(NONE)).toEqual({ outcome: null, on: null, expires: null, closes: null, reason: '', review: '2031-01-01' });
	});

	it('takes only the new words from now on', async () => {
		await expect(db.query(`UPDATE project SET licence_outcome = 'refused' WHERE id = $1`, [REFUSED])).rejects.toMatchObject({ code: '23514' });
		// Control: a new word is taken.
		await db.query(`UPDATE project SET licence_outcome = 'application_rejected' WHERE id = $1`, [REFUSED]);
		expect(await recordOf(REFUSED)).toMatchObject({ outcome: 'application_rejected', closes: '2029-03-01' });
	});
});
