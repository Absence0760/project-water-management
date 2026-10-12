// The operator's confirmation that someone acts for a project's responsible
// authority (229_authority_delegates, issue #523 G5), locally:
//
//   pnpm dev:authority:confirm <project-id> <email> --reference "<the authority's letter>"
//
// The authority, not the project's host, decides who acts for it: a member
// already acting for it confirms a proposal in the app, but with nobody
// acting for it yet only the operator can confirm the first, on the
// authority's written request. This runs authority_confirm_by_operator as the
// schema owner (MIGRATION_DATABASE_URL) on this checkout's dev database; in
// production the operator runs the same function as the schema owner
// (docs/deployment.md, runbook "The responsible authority confirms who acts
// for it"). It confirms the person's proposal, or adds them confirmed; they
// must be an editor or owner of the project, directly or through its team.
// The History records it (authority.confirmed, via operator, with the
// reference).
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';

export interface ConfirmArgs {
	projectId: string;
	email: string;
	reference: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const USAGE = 'usage: pnpm dev:authority:confirm <project-id> <email> --reference "<the authority’s letter or request>"';

/** The arguments, or why they can't be taken. */
export function parseArgs(argv: string[]): ConfirmArgs | string {
	const at = argv.indexOf('--reference');
	const reference = at >= 0 ? (argv[at + 1] ?? '').trim() : '';
	const positional = argv.filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1));
	const [projectId, email] = positional;
	if (!projectId || !UUID.test(projectId)) return 'give the project’s id (a uuid; the address bar shows it)';
	if (!email || !email.includes('@')) return 'give the person’s email address';
	if (!reference) return 'give the authority’s letter or request with --reference (it goes into the History)';
	if (reference.length > 200) return 'keep --reference to 200 characters';
	if (positional.length > 2) return `unexpected argument ${positional[2]}`;
	return { projectId, email: email.trim().toLowerCase(), reference };
}

/** Confirm the person at `url` (the schema owner's connection); returns their name. */
export async function confirmDelegate(url: string, args: ConfirmArgs): Promise<string> {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const { rows } = await client.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM app_user WHERE lower(email::text) = $1', [args.email]);
		if (!rows[0]) throw new Error(`no account with the address ${args.email}`);
		await client.query('SELECT authority_confirm_by_operator($1, $2, $3)', [args.projectId, rows[0].id, args.reference]);
		return rows[0].name;
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	const url = process.env.MIGRATION_DATABASE_URL;
	const args = parseArgs(process.argv.slice(2));
	if (!url) {
		console.error('MIGRATION_DATABASE_URL is not set');
		process.exit(1);
	}
	if (typeof args === 'string') {
		console.error(`${args}\n${USAGE}`);
		process.exit(2);
	}
	confirmDelegate(url, args)
		.then((name) => {
			console.log(`${name} now acts for the project’s responsible authority (confirmed on: ${args.reference}).`);
			process.exit(0);
		})
		.catch((err: Error & { code?: string }) => {
			// The database's own words for its refusals (not an editor, no such project): the operator's terminal, never an API response.
			console.error(err.message);
			process.exit(1);
		});
}
