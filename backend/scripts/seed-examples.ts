// Seed the invented example catchments (scripts/examples) for local demos and
// e2e. Unlike the client workbooks these are synthetic and committed, so this
// works on any fresh clone:
//
//   pnpm seed:examples                      (root script; needs `pnpm dev:db:up`)
//
// Creates two demo users and shows both ways of sharing:
//   team "Demo Catchment Consultants" (demo = admin, analyst = member) owns
//     Kleinberg + Droëvlei → analyst gets editor on both through the team
//   analyst@example.com personally owns Sandspruit and shares it with demo as viewer
// Each project gets one model run so results show immediately.
import { config } from 'dotenv';
import { closePool } from '../src/db/pool.js';
import { withoutUser, withUser } from '../src/db/tx.js';
import { executeRun } from '../src/runs/execute.js';
import { buildExamples } from './examples/catchments.js';
import { importProjectData } from './import-project.js';


// DEV-ONLY demo credentials — these users exist only in local docker Postgres.
export const DEMO = { email: 'demo@example.com', password: 'demo-password', displayName: 'Demo Hydrologist' };
export const ANALYST = { email: 'analyst@example.com', password: 'demo-password', displayName: 'Demo Analyst' };

async function userId(email: string) {
	return withoutUser(async (db) => (await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [email])).rows[0]!.id);
}

async function share(ownerEmail: string, projectId: string, email: string, role: 'viewer' | 'editor') {
	const [owner, member] = [await userId(ownerEmail), await userId(email)];
	await withUser(owner, (db) =>
		db.query('INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [projectId, member, role])
	);
}

async function run(email: string, projectId: string) {
	await withUser(await userId(email), (db) => executeRun(db, projectId, 'Initial run (seed)'));
}

export async function seedExamples(): Promise<string[]> {
	const [kleinberg, droevlei, sandspruit] = buildExamples();
	const ids: string[] = [];
	for (const [ex, who] of [
		[kleinberg!, DEMO],
		[droevlei!, DEMO],
		[sandspruit!, ANALYST]
	] as const) {
		const id = await importProjectData(ex, who.email, { password: who.password, displayName: who.displayName });
		await run(who.email, id);
		ids.push(id);
		console.log(`seeded ${ex.name} (${who.email})`);
	}
	// Both users exist now: set up the team and the direct share.
	const [demo, analyst] = [await userId(DEMO.email), await userId(ANALYST.email)];
	const teamId = crypto.randomUUID();
	await withUser(demo, async (db) => {
		await db.query('INSERT INTO team (id, name, created_by) VALUES ($1, $2, $3)', [teamId, 'Demo Catchment Consultants', demo]);
		await db.query(`INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, analyst]);
		await db.query('UPDATE project SET team_id = $1 WHERE id = ANY($2::uuid[])', [teamId, [ids[0], ids[1]]]);
	});
	await share(ANALYST.email, ids[2]!, DEMO.email, 'viewer');
	return ids;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// CLI only: importing this module must not load dev env (see scripts/migrate.ts).
	config({ path: ['.env.development.local', '.env.development'] });
	seedExamples()
		.then(() => console.log(`\nSign in as ${DEMO.email} or ${ANALYST.email} (password: ${DEMO.password})`))
		.catch((err) => {
			console.error(err.message);
			process.exitCode = 1;
		})
		.finally(closePool);
}
