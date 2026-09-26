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
//   farmer1@example.com is a farmer on Sandspruit linked to Vaalbank; farmer2@
//     example.com is linked to Rietspruit (Sandspruit) and Kareebos (Droëvlei),
//     so the farm-scoped views (WP-2.1, docs/design/farmer-view.md) have a
//     one-farm and a several-farm user
// Each project gets one model run, published by its owner (WP-2.3; Sandspruit
// with an advisory notice), so results and the farm views show immediately. Building the
// examples runs Kleinberg's automatic GR4J calibration for its stored fit
// (several seconds). What each example shows: docs/run-locally.md
// § Example catchments; catchments.test.ts keeps them current.
import { config } from 'dotenv';
import { closePool } from '../src/db/pool.js';
import { withoutUser, withUser } from '../src/db/tx.js';
import { publishRun } from '../src/publish/publish.js';
import { executeRun } from '../src/runs/execute.js';
import { buildExamples } from './examples/catchments.js';
import { importProjectData } from './import-project.js';
import { hashPassword } from '../src/auth/password.js';


// DEV-ONLY demo credentials — these users exist only in local docker Postgres.
export const DEMO = { email: 'demo@example.com', password: 'demo-password', displayName: 'Demo Hydrologist' };
export const ANALYST = { email: 'analyst@example.com', password: 'demo-password', displayName: 'Demo Analyst' };

// DEV-ONLY demo farmers (WP-2.1): each sees only the farms linked to them.
export const FARMERS = [
	{ email: 'farmer1@example.com', password: 'demo-password', displayName: 'Demo Farmer', farms: [['Sandspruit', 'Vaalbank']] },
	{ email: 'farmer2@example.com', password: 'demo-password', displayName: 'Demo Farmer Two', farms: [['Sandspruit', 'Rietspruit'], ['Droëvlei', 'Kareebos']] }
] as const;

/** A verified demo account, created once (a re-seed finds it). */
async function ensureUser(u: { email: string; password: string; displayName: string }) {
	const hash = await hashPassword(u.password);
	return withoutUser(async (db) => {
		await db.query(
			`INSERT INTO app_user (email, display_name, password_hash, email_verified_at) VALUES ($1, $2, $3, now())
			 ON CONFLICT (email) DO NOTHING`,
			[u.email, u.displayName, hash]
		);
		return (await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [u.email])).rows[0]!.id;
	});
}

/** Make `email` a farmer on the project, linked to the named farm, as the project's owner would. */
async function linkFarmer(ownerEmail: string, projectId: string, farmerId: string, farm: string) {
	const owner = await userId(ownerEmail);
	await withUser(owner, async (db) => {
		await db.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer') ON CONFLICT DO NOTHING`, [projectId, farmerId]);
		const { rowCount } = await db.query(
			`INSERT INTO farm_link (project_id, node_id, user_id, added_by)
			 SELECT $1, id, $2, $4 FROM node WHERE project_id = $1 AND kind = 'farm' AND name = $3
			 ON CONFLICT DO NOTHING`,
			[projectId, farmerId, farm, owner]
		);
		if (!rowCount) throw new Error(`no farm ${farm} to link`);
	});
}

async function userId(email: string) {
	return withoutUser(async (db) => (await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [email])).rows[0]!.id);
}

async function share(ownerEmail: string, projectId: string, email: string, role: 'viewer' | 'editor') {
	const [owner, member] = [await userId(ownerEmail), await userId(email)];
	await withUser(owner, (db) =>
		db.query('INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [projectId, member, role])
	);
}

async function run(email: string, projectId: string): Promise<string> {
	return withUser(await userId(email), async (db) => (await executeRun(db, projectId, 'Initial run (seed)')).id);
}

/**
 * The WUA's notice seeded on Sandspruit, so a demo farmer sees the official
 * answer first (docs/design/farmer-view.md §6.1). Invented wording; the app
 * never writes restriction text itself, only the WUA does.
 */
export const SANDSPRUIT_NOTICE = {
	level: 'advisory' as const,
	pct: null,
	noticeEn: 'The river is low. Please irrigate at night and check your pipes for leaks. (Demo notice.)',
	noticeAf: 'Die rivier is laag. Besproei asseblief snags en kyk jou pype vir lekke. (Demonstrasie-kennisgewing.)'
};

/** Publish the seeded run as the project's owner (WP-2.3), so farmers and viewers see it straight away. */
async function publish(email: string, projectId: string, runId: string, restriction?: typeof SANDSPRUIT_NOTICE) {
	await withUser(await userId(email), (db) => publishRun(db, projectId, { runId, note: 'Seeded example run', ...(restriction ? { restriction } : {}) }));
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
		const runId = await run(who.email, id);
		await publish(who.email, id, runId, ex === sandspruit ? SANDSPRUIT_NOTICE : undefined);
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
	const byName = { Droëvlei: { id: ids[1]!, owner: DEMO.email }, Sandspruit: { id: ids[2]!, owner: ANALYST.email } };
	for (const f of FARMERS) {
		const id = await ensureUser(f);
		for (const [catchment, farm] of f.farms) await linkFarmer(byName[catchment].owner, byName[catchment].id, id, farm);
	}
	return ids;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// CLI only: importing this module must not load dev env (see scripts/migrate.ts).
	config({ path: ['.env.development.local', '.env.development'] });
	seedExamples()
		.then(() =>
			console.log(`\nSign in as ${DEMO.email} or ${ANALYST.email}, or as a farmer, ${FARMERS.map((f) => f.email).join(' or ')} (password: ${DEMO.password})`)
		)
		.catch((err) => {
			console.error(err.message);
			process.exitCode = 1;
		})
		.finally(closePool);
}
