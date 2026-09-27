// Applies backend/migrations/*.sql in filename order, once each, recording
// them in schema_migrations. Each file runs in its own transaction. Then it
// syncs the `language` table (080_language.sql) from the engine's language
// table, so a language is added in one place (LANGUAGES) and the database's
// foreign keys accept it on the next deploy. It only adds: a language that
// left the list stays, since stored locales may still name it.
//
// Runs as the schema owner (MIGRATION_DATABASE_URL), never as water_app.
//   pnpm dev:db:migrate                     — dev database
//   MIGRATION_DATABASE_URL=… tsx scripts/migrate.ts
import { config } from 'dotenv';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { LOCALES } from '@water-management/engine/languages';

export async function migrate(databaseUrl: string, log = console.log): Promise<string[]> {
	const dir = join(import.meta.dirname, '..', 'migrations');
	const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	const applied: string[] = [];
	try {
		await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
			name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
		// Serialise concurrent migrators (e.g. parallel test workers).
		await client.query('SELECT pg_advisory_lock(727274)');
		const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
		for (const file of files) {
			if (done.has(file)) continue;
			const sql = await readFile(join(dir, file), 'utf8');
			await client.query('BEGIN');
			try {
				await client.query(sql);
				await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
				await client.query('COMMIT');
			} catch (err) {
				await client.query('ROLLBACK');
				throw new Error(`migration ${file} failed: ${(err as Error).message}`);
			}
			applied.push(file);
			log(`applied ${file}`);
		}
		const added = await syncLanguages(client);
		if (added.length) log(`added language(s) ${added.join(', ')}`);
		await client.query('SELECT pg_advisory_unlock(727274)');
	} finally {
		await client.end();
	}
	return applied;
}

/** Insert every code in LOCALES the `language` table lacks (once 080 has made it); returns the codes added. */
export async function syncLanguages(client: pg.ClientBase, codes: readonly string[] = LOCALES): Promise<string[]> {
	const { rows: exists } = await client.query<{ ok: boolean }>(`SELECT to_regclass('public.language') IS NOT NULL AS ok`);
	if (!exists[0]?.ok) return [];
	const { rows } = await client.query<{ code: string }>('INSERT INTO language (code) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING code', [codes]);
	return rows.map((r) => r.code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// Only the CLI loads dev env files. Importing this module (tests, the
	// migrate Lambda) must never touch process.env — the DB tests once ran
	// against the dev database because this lived at module top level.
	config({ path: ['.env.development.local', '.env.development'] });
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	migrate(url)
		.then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date'))
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
