// Import a project.json (produced by scripts/wbt-import/extract_project.py from
// a WBT workbook) as a new project owned by an existing or new user.
//
//   pnpm import:project <project.json> --email you@example.com [--name "…"] [--password …] [--run] [--skip-existing]
//                       [--settings <patch.json>] [--transfers <patch.json>] [--fit [--fit-seed <n>] [--fit-starts <n>] [--fit-budget <n>]]
//
// With --password, the user is created if missing (local demo seeding only).
// With --skip-existing, a project the user already owns under the same name
// is left as it is and nothing is imported (so `pnpm seed:demo` can run again
// without making copies). --settings applies a settings patch (a JSON object,
// validated like a PATCH of the project's settings) to the file before
// importing; --transfers applies a transfer patch (a list of { from, to, set }
// naming rules by their end nodes, ./fit-project.ts withTransferPatch), for
// what the workbook doesn't hold (an off-take's capacity); --fit then fits GR4J to the file's calibration record with the
// engine's calibrate() and stores the parameters and their fit record, as
// Settings → Fit automatically → Apply does (./fit-project.ts, docs/model.md
// §2.10b "Fit at import"). Both happen before the import, so --run runs the
// fitted project.
// Runs through the same RLS-bound path and validation as POST /projects/import
// (src/projects/import.ts).
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/auth/password.js';
import { closePool } from '../src/db/pool.js';
import { actAsUser, withoutUser, withUser } from '../src/db/tx.js';
// The same validation and transaction as POST /projects/import.
import { importProjectFile, parseProjectFile } from '../src/projects/import.js';
import { fitDocument, fitSummary, withSettingsPatch, withTransferPatch, type FitOptions, type ProjectDocument } from './fit-project.js';
import { loadDevEnv } from '../src/config/devEnv.js';

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
		// app_user is under RLS (068_app_user_rls.sql): its SECURITY DEFINER lookups.
		const { rows } = await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [email.toLowerCase()]);
		if (rows[0]) return rows[0].id;
		if (!opts.password) throw new Error(`no user ${email} — register first or pass --password to create one`);
		const hash = await hashPassword(opts.password);
		const { rows: created } = await db.query<{ id: string | null }>('SELECT app_register($1, $2, $3, NULL) AS id', [
			email.toLowerCase(),
			opts.displayName ?? email.split('@')[0],
			hash
		]);
		const id = created[0]?.id;
		if (!id) throw new Error(`${email} was registered a moment ago — run the import again`);
		// Created by an operator script (demo/seed users), not self-service
		// sign-up, so no verification email: the address starts verified.
		await actAsUser(db, id);
		await db.query('UPDATE app_user SET email_verified_at = now() WHERE id = $1', [id]);
		return id;
	});

	const { projectId, runError } = await importProjectFile(userId, data, { name: opts.name, run: opts.run });
	if (runError) throw new Error(`imported project ${projectId}, but ${runError}`);
	return projectId;
}

/**
 * The id of a project the user with this email owns under this exact name, or
 * null (no such user, or no such project). The oldest, if there are several.
 */
export async function findOwnedProject(email: string, name: string): Promise<string | null> {
	const userId = await withoutUser(
		async (db) => (await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [email.toLowerCase()])).rows[0]?.id ?? null
	);
	if (!userId) return null;
	return withUser(userId, async (db) => {
		const { rows } = await db.query<{ id: string }>(
			`SELECT p.id FROM project p JOIN project_member m ON m.project_id = p.id
			 WHERE m.user_id = $1 AND m.role = 'owner' AND p.name = $2 ORDER BY p.created_at LIMIT 1`,
			[userId, name]
		);
		return rows[0]?.id ?? null;
	});
}

/** The CLI's changes to the document before the import: a settings patch, then a fit. */
export interface PrepareOptions {
	/** A settings patch file (a JSON object). */
	settings?: string;
	/** A transfer patch file (a JSON list of { from, to, set }). */
	transfers?: string;
	/** Fit GR4J and store the fit (./fit-project.ts). */
	fit?: FitOptions | null;
}

/** The CLI: import, or with --skip-existing leave an owned project of the same name alone. */
async function main(file: string, email: string, opts: ImportOptions & PrepareOptions & { skipExisting?: boolean }): Promise<string> {
	let raw = JSON.parse(await readFile(file, 'utf8')) as ProjectDocument;
	const name = opts.name ?? (typeof raw.name === 'string' ? raw.name : undefined);
	if (opts.skipExisting) {
		const existing = name ? await findOwnedProject(email, name) : null;
		if (existing) return `✓ ${name} already exists for ${email} (project ${existing}): skipped`;
	}
	if (opts.settings) raw = withSettingsPatch(raw, JSON.parse(await readFile(opts.settings, 'utf8')));
	if (opts.transfers) raw = withTransferPatch(raw, JSON.parse(await readFile(opts.transfers, 'utf8')));
	if (opts.fit) {
		console.log(`fitting GR4J for ${name ?? file} (the engine's calibrate(), with validation; minutes on a long record)…`);
		const fitted = fitDocument(raw, opts.fit);
		for (const l of fitSummary(fitted.report)) console.log(l);
		raw = fitted.doc;
	}
	return `imported project ${await importProjectData(raw, email, opts)}`;
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
	// CLI only: importing this module must not load dev env (the DB tests once ran against the dev database that way).
	loadDevEnv();
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			email: { type: 'string' },
			name: { type: 'string' },
			password: { type: 'string' },
			run: { type: 'boolean' },
			'skip-existing': { type: 'boolean' },
			settings: { type: 'string' },
			transfers: { type: 'string' },
			fit: { type: 'boolean' },
			'fit-seed': { type: 'string' },
			'fit-starts': { type: 'string' },
			'fit-budget': { type: 'string' }
		}
	});
	const file = positionals[0];
	if (!file || !values.email) {
		console.error(
			'usage: import-project <project.json> --email <email> [--name <name>] [--password <pw>] [--run] [--skip-existing] [--settings <patch.json>] [--transfers <patch.json>] [--fit [--fit-seed <n>] [--fit-starts <n>] [--fit-budget <n>]]'
		);
		process.exit(1);
	}
	const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));
	const fit: FitOptions | null = values.fit
		? {
				...(values['fit-seed'] !== undefined ? { seed: int(values['fit-seed']) } : {}),
				...(values['fit-starts'] !== undefined ? { starts: int(values['fit-starts']) } : {}),
				...(values['fit-budget'] !== undefined ? { budget: int(values['fit-budget']) } : {})
			}
		: null;
	main(file, values.email, { name: values.name, password: values.password, run: values.run, skipExisting: values['skip-existing'], settings: values.settings, transfers: values.transfers, fit })
		.then((line) => console.log(line))
		.catch((err) => {
			console.error(describe(err));
			process.exitCode = 1;
		})
		.finally(closePool);
}
