// Import a project.json (produced by scripts/wbt-import/extract_project.py from
// a WBT workbook) as a new project owned by an existing or new user.
//
//   pnpm import:project <project.json> --email you@example.com [--name "…"] [--password …] [--run]
//
// With --password, the user is created if missing (local demo seeding only).
// Runs through the same RLS-bound path and validation as the API.
import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { hashPassword } from '../src/auth/password.js';
import { closePool } from '../src/db/pool.js';
import { withoutUser, withUser } from '../src/db/tx.js';
import { saveModel } from '../src/model/store.js';
import { executeRun } from '../src/runs/execute.js';
import { ModelBody, modelProblems } from '../src/model/validate.js';
// Shared with GET /projects/:id/export.json, so an export re-imports as-is.
import { ProjectFile } from '../src/projects/document.js';

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

/** Validate and create a project from an in-memory project document. Returns its id. */
export async function importProjectData(raw: unknown, email: string, opts: ImportOptions = {}): Promise<string> {
	const data = ProjectFile.parse(raw);
	const problems = modelProblems(data.model);
	if (problems.length) throw new Error(`invalid model:\n  ${problems.join('\n  ')}`);

	const userId = await withoutUser(async (db) => {
		const { rows } = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [email.toLowerCase()]);
		if (rows[0]) return rows[0].id;
		if (!opts.password) throw new Error(`no user ${email} — register first or pass --password to create one`);
		const hash = await hashPassword(opts.password);
		const { rows: created } = await db.query<{ id: string }>(
			'INSERT INTO app_user (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
			[email.toLowerCase(), opts.displayName ?? email.split('@')[0], hash]
		);
		return created[0]!.id;
	});

	const projectId = await withUser(userId, async (db) => {
		const id = crypto.randomUUID();
		await db.query(
			'INSERT INTO project (id, name, description, settings, created_by) VALUES ($1, $2, $3, $4, $5)',
			[id, opts.name ?? data.name, data.description, JSON.stringify(data.settings), userId]
		);
		// Imported ids are deterministic per workbook; give each import its own
		// so the same workbook can be imported more than once.
		await saveModel(db, id, freshIds(data.model));
		for (const s of data.series) {
			await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values") VALUES ($1, $2, $3, $4, $5, $6)`,
				[id, s.kind, s.name, s.unit, s.startDate, s.values]
			);
		}
		return id;
	});
	if (opts.run) await withUser(userId, (db) => executeRun(db, projectId, 'Initial run (import)'));
	return projectId;
}

function freshIds(m: z.infer<typeof ModelBody>) {
	const map = new Map<string, string>();
	const id = (old: string) => map.get(old) ?? (map.set(old, crypto.randomUUID()), map.get(old)!);
	return {
		nodes: m.nodes.map((n) => ({ ...n, id: id(n.id), downstreamNodeId: n.downstreamNodeId && id(n.downstreamNodeId) })),
		crops: m.crops.map((c) => ({ ...c, id: id(c.id) })),
		cropAreas: m.cropAreas.map((a) => ({ ...a, nodeId: id(a.nodeId), cropId: id(a.cropId) })),
		transfers: m.transfers.map((t) => ({ ...t, id: id(t.id), fromNodeId: id(t.fromNodeId), toNodeId: id(t.toNodeId) }))
	};
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
			console.error(err.message);
			process.exitCode = 1;
		})
		.finally(closePool);
}
