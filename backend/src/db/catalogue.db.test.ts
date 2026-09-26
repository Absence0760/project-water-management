// Schema invariants read from the Postgres catalogue. Each one guards a rule in
// CLAUDE.md so a future migration can't silently break it.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const APP_URL = process.env.DATABASE_URL!;
/** Tables deliberately without RLS: app_user is needed before sign-in. */
const NO_RLS = new Set(['app_user', 'schema_migrations']);
/**
 * Tables water_app may UPDATE only column by column, and the only columns it
 * may update. A run is evidence: everything but its note (007_run_notes.sql)
 * and its pin (015_run_pinned.sql) is immutable.
 */
const COLUMN_ONLY_UPDATE: Record<string, string[]> = {
	model_run: ['notes', 'pinned'],
	// A note's author, target and visibility are fixed; its author edits the body, and it is soft-deleted (037_notes.sql).
	note: ['body', 'deleted_at', 'deleted_by', 'edited_at'],
	// An ensemble is completed once with its result; its seed and options never change (014_run_uncertainty.sql).
	run_uncertainty: ['accepted', 'completed_at', 'result', 'status', 'summary'],
	// A report's project, run, job, requester and recipients are fixed at insert; only its outcome changes (023_reports.sql).
	report: ['bytes', 'error', 'finished_at', 'pages', 'status'],
	// A publication's run, projection and publisher never change; the notice, the note, the next date and the supersession do (022_publication.sql).
	run_publication: [
		'next_expected_on',
		'note',
		'notice_af',
		'notice_en',
		'restriction_level',
		'restriction_pct',
		'superseded_at',
		'updated_at',
		'updated_by'
	],
	// A share link is withdrawn, never edited: who revoked it and when (025_share_links.sql).
	share_link: ['revoked_at', 'revoked_by'],
	// An API key likewise: never its hash, scopes or series, only its revocation (039_api_keys.sql).
	api_key: ['revoked_at', 'revoked_by']
};
/**
 * Append-only tables: water_app may read and add rows, never change or remove
 * them. The evidence-nomination history is tamper evidence
 * (010_run_nomination.sql). A job's row changes only through the queue's
 * SECURITY DEFINER claim / finish / purge functions (016_jobs.sql). An import
 * report is the record of what the importer flagged (017_project_import.sql).
 * A run's stored inputs are immutable: a reference goes only with its run
 * (cascade) and a blob only when no run references it, through the
 * series_blob_gc trigger (021_series_blob.sql). A farm's projection is what
 * its farmers were shown (022_publication.sql). A render token is issued,
 * then consumed or purged only through app_consume_render_token
 * (023_reports.sql). The change history is the record of who changed what: a
 * model revision and an audit event go only with their project, a series
 * revision also through its retention trim (030_history.sql). A sign-off
 * is a professional's signature on a run, never changed (035_signoff.sql).
 */
const APPEND_ONLY = new Set([
	'run_nomination',
	'job',
	'project_import',
	'series_blob',
	'run_input_series',
	'publication_farm',
	'render_token',
	'model_revision',
	'series_revision',
	'audit_event',
	'signoff'
]);
/**
 * Keep-forever tables: water_app may never remove a row (it goes only with
 * its run or project). Every uncertainty ensemble started is kept, so a band
 * can't be cherry-picked (014_run_uncertainty.sql). A share link is revoked,
 * not deleted: the row is the record of who made and withdrew it until the
 * audit log (WP-2.4) has events for both (025_share_links.sql). A note is
 * soft-deleted: the body stays for the audit trail, hidden from all but
 * editors (037_notes.sql). An API key too: audit events name it
 * (audit_event.actor_api_key_id, 039_api_keys.sql).
 */
const NO_DELETE = new Set(['run_uncertainty', 'share_link', 'note', 'api_key']);
/**
 * Tables with a node column that farmers never read (020_farm_scope.sql).
 * invite_node is a pending farmer invite's farms, owners only like invite
 * (034_farmer_invites.sql). Every table with a node column needs a
 * farmer-aware SELECT policy (one that calls app_farm_nodes) or a place here,
 * so a new per-farm table can't ship without a decision about farmers.
 */
const FARMERS_NEVER_READ = new Set<string>(['invite_node']);
/** farm_link is the link itself: a farmer reads their own rows by user id, not through app_farm_nodes. */
const FARMER_SCOPED_BY_USER = new Set(['farm_link']);

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

	it('gives every table with a node column a farmer-aware SELECT policy, or lists it as never read by farmers', async () => {
		const { rows } = await db.query<{ table_name: string; farmer_aware: boolean }>(
			`SELECT c.table_name,
				EXISTS (
					SELECT 1 FROM pg_policy p
					WHERE p.polrelid = ('public.' || c.table_name)::regclass AND p.polcmd IN ('r', '*')
					  AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app_farm_nodes%'
				) AS farmer_aware
			 FROM information_schema.columns c
			 WHERE c.table_schema = 'public' AND c.column_name ~ 'node_id$'
			 GROUP BY c.table_name`
		);
		expect(rows.length).toBeGreaterThan(3);
		const undecided = rows
			.filter((r) => !r.farmer_aware && !FARMERS_NEVER_READ.has(r.table_name) && !FARMER_SCOPED_BY_USER.has(r.table_name))
			.map((r) => r.table_name);
		expect(undecided).toEqual([]);
		// And a table on the list really is closed to farmers.
		const listedButOpen = rows.filter((r) => r.farmer_aware && FARMERS_NEVER_READ.has(r.table_name)).map((r) => r.table_name);
		expect(listedButOpen).toEqual([]);
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

	it('lets no role but the owner and water_app execute a SECURITY DEFINER function (028_definer_grants)', async () => {
		// A SECURITY DEFINER function runs as its owner, so a PUBLIC EXECUTE grant
		// (Postgres's default) hands the owner's rights to any role that can log in.
		const { rows } = await db.query<{ fn: string; grantee: string }>(
			`SELECT p.oid::regprocedure::text AS fn, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
			 FROM pg_proc p
			 LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
			 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
			 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND d.objid IS NULL
			   AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
			   AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) <> 'water_app')
			 ORDER BY 1, 2`
		);
		expect(rows.map((r) => `${r.fn} → ${r.grantee}`)).toEqual([]);
	});

	it('lets water_app execute every non-trigger SECURITY DEFINER function, and call one (positive control)', async () => {
		const { rows } = await db.query<{ fn: string; ok: boolean }>(
			`SELECT p.oid::regprocedure::text AS fn, has_function_privilege('water_app', p.oid, 'EXECUTE') AS ok
			 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.prorettype <> 'trigger'::regtype`
		);
		// The guard above must have something to look at: the auth, invite and farm-scope helpers at least.
		expect(rows.map((r) => r.fn)).toEqual(expect.arrayContaining(['app_has_role(uuid,project_role)', 'app_accept_invites(uuid)', 'app_farm_nodes(uuid)']));
		expect(rows.filter((r) => !r.ok).map((r) => r.fn)).toEqual([]);
		// And water_app really can call one (RLS policies call app_has_role as water_app).
		const app = new pg.Client({ connectionString: APP_URL });
		await app.connect();
		try {
			const { rows: called } = await app.query<{ ok: boolean }>(`SELECT app_has_role(gen_random_uuid(), 'viewer') AS ok`);
			expect(called[0]!.ok).toBe(false);
		} finally {
			await app.end();
		}
	});

	it('closes new functions to PUBLIC by default: the owner’s default privileges grant EXECUTE to water_app only', async () => {
		await db.query('BEGIN');
		try {
			await db.query(`CREATE FUNCTION catalogue_probe() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`);
			const { rows } = await db.query<{ pub: boolean; app: boolean }>(
				`SELECT has_function_privilege('public', 'catalogue_probe()', 'EXECUTE') AS pub,
				        has_function_privilege('water_app', 'catalogue_probe()', 'EXECUTE') AS app`
			);
			expect(rows[0]).toEqual({ pub: false, app: true });
		} finally {
			await db.query('ROLLBACK');
		}
	});

	it('positive control: the two guards above see a recent migration’s objects (018_feeds)', async () => {
		// If a migration's objects landed outside `public`, both guards would pass vacuously.
		const { rows: fns } = await db.query<{ proname: string; pinned: boolean; secdef: boolean }>(
			`SELECT p.proname, p.prosecdef AS secdef,
				EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%') AS pinned
			 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'app\\_%feed%' OR p.proname = 'data_feed_stamp')
			 ORDER BY p.proname`
		);
		expect(fns).toEqual([
			{ proname: 'app_begin_feed_fetch', pinned: true, secdef: true },
			{ proname: 'app_claim_feed', pinned: true, secdef: true },
			{ proname: 'app_due_feeds', pinned: true, secdef: true },
			{ proname: 'app_feed_fetch_job', pinned: true, secdef: true },
			{ proname: 'app_feed_fetch_now', pinned: true, secdef: true },
			{ proname: 'app_feed_is_due', pinned: true, secdef: false },
			{ proname: 'app_feed_replace_done', pinned: true, secdef: true },
			{ proname: 'app_feed_schedule_failed', pinned: true, secdef: true },
			{ proname: 'app_record_feed_checked', pinned: true, secdef: true },
			{ proname: 'app_record_feed_result', pinned: true, secdef: true },
			{ proname: 'app_take_feed_fetch', pinned: true, secdef: true },
			{ proname: 'data_feed_stamp', pinned: true, secdef: false }
		]);
		// And only water_app may call the SECURITY DEFINER ones (018, 027, 029 and 032 revoke PUBLIC).
		for (const f of fns.filter((f) => f.secdef)) {
			const { rows } = await db.query<{ pub: boolean; app: boolean }>(
				`SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('water_app', p.oid, 'EXECUTE') AS app
				 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
				[f.proname]
			);
			expect(rows[0], f.proname).toEqual({ pub: false, app: true });
		}
		const { rows: fks } = await db.query<{ cols: string }>(
			`SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_constraint c
			 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 WHERE c.contype = 'f' AND c.conrelid = 'public.data_feed'::regclass GROUP BY c.oid ORDER BY 1`
		);
		expect(fks.map((f) => f.cols)).toEqual(['acting_user_id', 'created_by', 'project_id']);
	});
});
