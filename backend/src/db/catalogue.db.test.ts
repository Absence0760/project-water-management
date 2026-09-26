// Schema invariants read from the Postgres catalogue. Each one guards a rule in
// CLAUDE.md so a future migration can't silently break it.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
/** Tables deliberately without RLS: app_user is needed before sign-in. */
const NO_RLS = new Set(['app_user', 'schema_migrations']);
/**
 * Tables water_app may UPDATE only column by column, and the only columns it
 * may update. A run is evidence: everything but its note (007_run_notes.sql)
 * and its pin (015_run_pinned.sql) is immutable.
 */
const COLUMN_ONLY_UPDATE: Record<string, string[]> = {
	model_run: ['notes', 'pinned'],
	// An ensemble is completed once with its result; its seed and options never change (014_run_uncertainty.sql).
	run_uncertainty: ['accepted', 'completed_at', 'result', 'status', 'summary']
};
/**
 * Append-only tables: water_app may read and add rows, never change or remove
 * them. The evidence-nomination history is tamper evidence
 * (010_run_nomination.sql). A job's row changes only through the queue's
 * SECURITY DEFINER claim / finish / purge functions (016_jobs.sql). An import
 * report is the record of what the importer flagged (017_project_import.sql).
 * A run's stored inputs are immutable: a reference goes only with its run
 * (cascade) and a blob only when no run references it, through the
 * series_blob_gc trigger (020_series_blob.sql).
 */
const APPEND_ONLY = new Set(['run_nomination', 'job', 'project_import', 'series_blob', 'run_input_series']);
/**
 * Keep-forever tables: water_app may never remove a row (it goes only with
 * its run or project). Every uncertainty ensemble started is kept, so a band
 * can't be cherry-picked (014_run_uncertainty.sql).
 */
const NO_DELETE = new Set(['run_uncertainty']);

let db: pg.Client;
beforeAll(async () => {
	db = new pg.Client({ connectionString: OWNER_URL });
	await db.connect();
});
afterAll(() => db.end());

const tables = async () =>
	(await db.query<{ relname: string; relrowsecurity: boolean }>(
		`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind = 'r'`
	)).rows;

describe('schema catalogue', () => {
	it('enables RLS on every table except the allowlist', async () => {
		const missing = (await tables()).filter((t) => !t.relrowsecurity && !NO_RLS.has(t.relname)).map((t) => t.relname);
		expect(missing).toEqual([]);
	});

	it('has at least one policy on every RLS table', async () => {
		const { rows } = await db.query<{ relname: string }>(
			`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
			   AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`
		);
		expect(rows.map((r) => r.relname)).toEqual([]);
	});

	it('grants every app table to water_app, which owns nothing and cannot bypass RLS', async () => {
		// Each privilege on its own: has_table_privilege with a list is true if *any* is held.
		const missing = [];
		for (const t of await tables()) {
			if (t.relname === 'schema_migrations') continue;
			for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
				if (COLUMN_ONLY_UPDATE[t.relname] && priv === 'UPDATE') continue;
				if (APPEND_ONLY.has(t.relname) && (priv === 'UPDATE' || priv === 'DELETE')) continue;
				if (NO_DELETE.has(t.relname) && priv === 'DELETE') continue;
				const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('water_app', $1, $2) AS ok`, [`public.${t.relname}`, priv]);
				if (!rows[0]!.ok) missing.push(`${t.relname} ${priv}`);
			}
		}
		expect(missing).toEqual([]);
		const { rows: role } = await db.query(
			`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'water_app'`
		);
		expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
		const { rows: owned } = await db.query(
			`SELECT relname FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'water_app')`
		);
		expect(owned).toEqual([]);
	});

	it('limits water_app UPDATE to the listed columns on column-only tables (model_run: notes, pinned)', async () => {
		for (const [table, allowed] of Object.entries(COLUMN_ONLY_UPDATE)) {
			const { rows: tableLevel } = await db.query<{ ok: boolean }>(
				`SELECT EXISTS (SELECT 1 FROM information_schema.table_privileges
				 WHERE grantee = 'water_app' AND table_schema = 'public' AND table_name = $1 AND privilege_type = 'UPDATE') AS ok`,
				[table]
			);
			expect(tableLevel[0]!.ok, `${table} has a table-level UPDATE grant`).toBe(false);
			const { rows } = await db.query<{ column_name: string }>(
				`SELECT a.attname AS column_name FROM pg_attribute a
				 WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
				   AND has_column_privilege('water_app', a.attrelid, a.attnum, 'UPDATE')
				 ORDER BY a.attname`,
				[`public.${table}`]
			);
			expect(rows.map((r) => r.column_name)).toEqual(allowed);
		}
	});

	it('grants water_app no DELETE or TRUNCATE, and has no delete policy, on keep-forever tables (run_uncertainty)', async () => {
		for (const table of NO_DELETE) {
			for (const priv of ['DELETE', 'TRUNCATE']) {
				const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('water_app', $1, $2) AS ok`, [`public.${table}`, priv]);
				expect(rows[0]!.ok, `${table} ${priv}`).toBe(false);
			}
			const { rows: policies } = await db.query<{ polname: string }>(`SELECT polname FROM pg_policy WHERE polrelid = $1::regclass AND polcmd IN ('d', '*')`, [
				`public.${table}`
			]);
			expect(policies.map((p) => p.polname), `${table} delete policies`).toEqual([]);
		}
	});

	it('grants water_app no UPDATE, DELETE or TRUNCATE, table or column, on append-only tables (run_nomination, job)', async () => {
		for (const table of APPEND_ONLY) {
			for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
				const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('water_app', $1, $2) AS ok`, [`public.${table}`, priv]);
				expect(rows[0]!.ok, `${table} ${priv}`).toBe(false);
			}
			const { rows: cols } = await db.query<{ attname: string }>(
				`SELECT a.attname FROM pg_attribute a
				 WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
				   AND has_column_privilege('water_app', a.attrelid, a.attnum, 'UPDATE')`,
				[`public.${table}`]
			);
			expect(cols.map((c) => c.attname), `${table} column UPDATE`).toEqual([]);
			// Nor any policy that would let a future grant through.
			const { rows: policies } = await db.query<{ polname: string }>(
				`SELECT polname FROM pg_policy WHERE polrelid = $1::regclass AND polcmd IN ('w', 'd', '*')`,
				[`public.${table}`]
			);
			expect(policies.map((p) => p.polname), `${table} update/delete policies`).toEqual([]);
		}
	});

	it('pins search_path on every function in public', async () => {
		const { rows } = await db.query<{ proname: string }>(
			`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			 LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
			 WHERE n.nspname = 'public' AND d.objid IS NULL
			   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`
		);
		expect(rows.map((r) => r.proname)).toEqual([]);
	});

	it('has a covering index for every foreign key', async () => {
		const { rows } = await db.query<{ fk: string }>(
			`SELECT c.conrelid::regclass || '.' || c.conname AS fk
			 FROM pg_constraint c
			 WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
			   AND NOT EXISTS (
				 SELECT 1 FROM pg_index i
				 WHERE i.indrelid = c.conrelid
				   AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
				   AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey
			   )`
		);
		expect(rows.map((r) => r.fk)).toEqual([]);
	});
});
