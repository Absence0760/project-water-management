// Import a project.json (produced by scripts/wbt-import/extract_project.py from
// a WBT workbook) as a new project owned by an existing or new user.
//
//   pnpm import:project <project.json> --email you@example.com [--name "…"] [--password …] [--run]
//
// With --password, the user is created if missing (local demo seeding only).
// Runs through the same RLS-bound path and validation as POST /projects/import
// (src/projects/import.ts).
import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth/password.js';
import { closePool } from '../src/db/pool.js';
import { withoutUser } from '../src/db/tx.js';
// The same validation and transaction as POST /projects/import.
import { importProjectFile, parseProjectFile } from '../src/projects/import.js';

export async function importProject(file: string, email: string, opts: ImportOptions = {}) {
	return importProjectData(JSON.parse(await readFile(file, 'utf8')), email, opts);
}

export interface ImportOptions {
	name?: string;
	/** Also execute one model run after importing. */
	run?: boolean;
	password?: string;
	displayName?: string;
}

/**
 * Validate and create a project from an in-memory project document as the
 * user with this email (created first when `password` is given). Returns its
 * id. A requested run that fails throws, after the import has committed.
 */
export async function importProjectData(raw: unknown, email: string, opts: ImportOptions = {}): Promise<string> {
	// Validate before touching users, so a bad file never creates a demo user.
	const data = parseProjectFile(raw);

	const userId = await withoutUser(async (db) => {
		const { rows } = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [email.toLowerCase()]);
		if (rows[0]) return rows[0].id;
		if (!opts.password) throw new Error(`no user ${email} — register first or pass --password to create one`);
		const hash = await hashPassword(opts.password);
		const { rows: created } = await db.query<{ id: string }>(
			// Created by an operator script (demo/seed users), not self-service
			// sign-up, so no verification email: the address starts verified.
			`INSERT INTO app_user (email, display_name, password_hash, email_verified_at)
			 VALUES ($1, $2, $3, now()) RETURNING id`,
			[email.toLowerCase(), opts.displayName ?? email.split('@')[0], hash]
		);
		return created[0]!.id;
	});

	const { projectId, runError } = await importProjectFile(userId, data, { name: opts.name, run: opts.run });
	if (runError) throw new Error(`imported project ${projectId}, but ${runError}`);
	return projectId;
}

/** An import failure as the CLI prints it: the message plus any listed problems. */
function describe(err: unknown): string {
	const e = err as { message?: string; details?: unknown; issues?: unknown };
	const list = (Array.isArray(e.details) ? e.details : Array.isArray(e.issues) ? e.issues : []) as { message?: string; path?: unknown[] }[];
	const lines = list.map((d) => `${Array.isArray(d.path) && d.path.length ? `${d.path.join('.')}: ` : ''}${d.message ?? ''}`);
	// A ZodError's own message is its issues as JSON; the list says it better.
	const head = Array.isArray(e.issues) ? 'invalid project file' : (e.message ?? String(err));
	return [head, ...lines.map((l) => `  ${l}`)].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// CLI only: importing this module must not load dev env (see scripts/migrate.ts).
	config({ path: ['.env.development.local', '.env.development'] });
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { email: { type: 'string' }, name: { type: 'string' }, password: { type: 'string' }, run: { type: 'boolean' } }
	});
	const file = positionals[0];
	if (!file || !values.email) {
		console.error('usage: import-project <project.json> --email <email> [--name <name>] [--password <pw>] [--run]');
		process.exit(1);
	}
	importProject(file, values.email, { name: values.name, password: values.password, run: values.run })
		.then((id) => console.log(`imported project ${id}`))
		.catch((err) => {
			console.error(describe(err));
			process.exitCode = 1;
		})
		.finally(closePool);
}
