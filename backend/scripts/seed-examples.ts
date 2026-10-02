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
//   applicant@example.com is a contributor (a licence applicant, WP-3.3) on
//     Sandspruit, also linked to Klipdrift (an irrigator applying to raise
//     their own dam), with a submitted application that doubles its dam, so
//     the analyst's Applications tab has one to assess
// Each project gets one model run, published by its owner (WP-2.3; Sandspruit
// with an advisory notice), so results and the farm views show immediately. Building the
// examples runs Kleinberg's automatic GR4J calibration for its stored fit
// (several seconds). What each example shows: docs/run-locally.md
// § Example catchments; catchments.test.ts keeps them current.
import { createHash } from 'node:crypto';
import { closePool } from '../src/db/pool.js';
import { actAsUser, type Db, withoutUser, withUser } from '../src/db/tx.js';
import { publishRun } from '../src/publish/publish.js';
import { recordAudit } from '../src/history/record.js';
import { executeRun } from '../src/runs/execute.js';
import { loadScenario, runScenario } from '../src/scenarios/execute.js';
import { opsSha256 } from '../src/scenarios/schema.js';
import { applicationOf, APPLICATION_FARM } from './examples/application.js';
import { buildExamples, buildRiverExample } from './examples/catchments.js';
import { SANDSPRUIT_MAP_FILE, sandspruitMap, type ExampleMapFeature } from './examples/map.js';
import { ORANJE_MAP_FILE, oranjeMap } from './examples/oranjeMap.js';
import { findOwnedProject, importProjectData } from './import-project.js';
import { hashPassword } from '../src/auth/password.js';
import { checkGeometry } from '../src/geo/geojson.js';
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { loadDevEnv } from '../src/config/devEnv.js';


// DEV-ONLY demo credentials — these users exist only in local docker Postgres.
export const DEMO = { email: 'demo@example.com', password: 'demo-password', displayName: 'Demo Hydrologist' };
export const ANALYST = { email: 'analyst@example.com', password: 'demo-password', displayName: 'Demo Analyst' };

// DEV-ONLY demo farmers (WP-2.1): each sees only the farms linked to them.
export const FARMERS = [
	{ email: 'farmer1@example.com', password: 'demo-password', displayName: 'Demo Farmer', farms: [['Sandspruit', 'Vaalbank']] },
	{ email: 'farmer2@example.com', password: 'demo-password', displayName: 'Demo Farmer Two', farms: [['Sandspruit', 'Rietspruit'], ['Droëvlei', 'Kareebos']] }
] as const;

// DEV-ONLY demo applicant (WP-3.3): a contributor on Sandspruit, linked to one farm.
export const APPLICANT = { email: 'applicant@example.com', password: 'demo-password', displayName: 'Demo Applicant', catchment: 'Sandspruit', farm: APPLICATION_FARM } as const;

/** A verified demo account, created once (a re-seed finds it). */
async function ensureUser(u: { email: string; password: string; displayName: string }) {
	const hash = await hashPassword(u.password);
	// app_user is under RLS (068_app_user_rls.sql): its SECURITY DEFINER sign-up and lookup.
	return withoutUser(async (db) => {
		const { rows } = await db.query<{ id: string | null }>('SELECT app_register($1, $2, $3, NULL) AS id', [u.email, u.displayName, hash]);
		const created = rows[0]?.id;
		if (!created) return (await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [u.email])).rows[0]!.id;
		await actAsUser(db, created);
		await db.query('UPDATE app_user SET email_verified_at = now() WHERE id = $1', [created]);
		return created;
	});
}

/**
 * The demo accounts accept the terms in force (LEGAL_VERSION), as a person
 * signing up does: otherwise the app puts the re-acceptance step in front of
 * every page, and a scheduled report's editor shows it to nobody. Run on
 * every seed, so a re-seed after a terms change brings them up to date.
 */
async function acceptCurrentTerms(emails: readonly string[]) {
	for (const email of emails) {
		const id = await withoutUser(async (db) => (await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [email])).rows[0]?.id);
		if (!id) continue;
		await withUser(id, (db) => db.query('UPDATE app_user SET terms_version = $2 WHERE id = $1 AND terms_version IS DISTINCT FROM $2', [id, LEGAL_VERSION]));
	}
}
const SEEDED = () => [DEMO.email, ANALYST.email, ...FARMERS.map((f) => f.email), APPLICANT.email];

/** Make `email` a farmer (or a contributor) on the project, linked to the named farm, as the project's owner would. */
async function linkFarmer(ownerEmail: string, projectId: string, farmerId: string, farm: string, role: 'farmer' | 'contributor' = 'farmer') {
	const owner = await userId(ownerEmail);
	await withUser(owner, async (db) => {
		await db.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [projectId, farmerId, role]);
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
	return withoutUser(async (db) => (await db.query<{ id: string }>('SELECT id FROM app_auth_account($1)', [email])).rows[0]!.id);
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
	notice: {
		en: 'The river is low. Please irrigate at night and check your pipes for leaks. (Demo notice.)',
		af: 'Die rivier is laag. Besproei asseblief snags en kyk jou pype vir lekke. (Demonstrasie-kennisgewing.)'
	}
};

/** Publish the seeded run as the project's owner (WP-2.3), so farmers and viewers see it straight away. */
async function publish(email: string, projectId: string, runId: string, restriction?: typeof SANDSPRUIT_NOTICE) {
	await withUser(await userId(email), (db) => publishRun(db, projectId, { runId, note: 'Seeded example run', ...(restriction ? { restriction } : {}) }));
}

/**
 * The examples are one bundle (a team, a share, farmer links and an
 * application tie them together), so a database that already has them is left
 * as it is, and one that has only some of them is refused rather than patched:
 * running the seed again never makes copies. Returns the existing ids, or null
 * when none of them exist yet.
 */
async function existingExamples(names: [string, string][]): Promise<string[] | null> {
	const found = await Promise.all(names.map(([name, email]) => findOwnedProject(email, name)));
	if (found.every((id) => id === null)) return null;
	if (found.some((id) => id === null)) {
		throw new Error(
			'some of the example catchments exist and some don’t: the seed won’t patch a partial set. Reset the database (pnpm dev:db:reset) and seed again.'
		);
	}
	return found as string[];
}

export async function seedExamples(): Promise<string[]> {
	const [kleinberg, droevlei, sandspruit] = buildExamples();
	const existing = await existingExamples([
		[kleinberg!.name, DEMO.email],
		[droevlei!.name, DEMO.email],
		[sandspruit!.name, ANALYST.email]
	]);
	if (existing) {
		await seedRiverExample();
		await acceptCurrentTerms(SEEDED());
		console.log('✓ the example catchments already exist: skipped');
		return existing;
	}
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
	await seedApplication(byName[APPLICANT.catchment]);
	await seedMap(ANALYST.email, ids[2]!, SANDSPRUIT_MAP_FILE, sandspruitMap(sandspruit!.model));
	await seedRiverExample();
	await acceptCurrentTerms(SEEDED());
	return ids;
}

/**
 * The river-abstractions example (catchments.ts ORANJE, #342 items 4–5),
 * owned by the demo user with its map. Apart from the bundle, so a database
 * seeded before it gains it on the next `pnpm seed:examples`; skipped once it
 * exists.
 */
async function seedRiverExample() {
	const ex = buildRiverExample();
	if (await findOwnedProject(DEMO.email, ex.name)) return;
	const id = await importProjectData(ex, DEMO.email, { password: DEMO.password, displayName: DEMO.displayName });
	await publish(DEMO.email, id, await run(DEMO.email, id));
	await seedMap(DEMO.email, id, ORANJE_MAP_FILE, oranjeMap(ex.model));
	console.log(`seeded ${ex.name} (${DEMO.email})`);
}

/**
 * An example's invented map (examples/map.ts, examples/oranjeMap.ts),
 * recorded as one imported file the way `POST /map/import` records one, with
 * each parcel, dam, gauge and pump point linked to its node. It only draws:
 * no node's area comes from it until an editor uses **Use … km²**.
 */
async function seedMap(ownerEmail: string, projectId: string, fileName: string, features: ExampleMapFeature[]) {
	await withUser(await userId(ownerEmail), async (db) => {
		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: features.map((f) => ({ type: 'Feature', properties: { name: f.name }, geometry: f.geometry }))
		});
		const { rows: src } = await db.query<{ id: string }>(
			`INSERT INTO geo_source (project_id, file_name, sha256, crs, imported_by) VALUES ($1, $2, $3, 'EPSG:4326', app_current_user_id()) RETURNING id`,
			[projectId, fileName, createHash('sha256').update(text, 'utf8').digest('hex')]
		);
		const { rows: nodes } = await db.query<{ id: string; name: string }>('SELECT id, name FROM node WHERE project_id = $1', [projectId]);
		for (const f of features) {
			const checked = checkGeometry(f.geometry);
			if ('problem' in checked) throw new Error(`the example map's ${f.name} ${checked.problem}`);
			await db.query(
				`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, area_m2, source_id, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, app_current_user_id())`,
				[projectId, f.kind, f.name, f.node ? (nodes.find((n) => n.name === f.node)?.id ?? null) : null, JSON.stringify(checked.geometry), checked.areaM2, src[0]!.id]
			);
		}
	});
}

/**
 * The demo applicant's submitted application (WP-3.3, docs/scenarios.md
 * § Applications): double their dam on the published baseline, keeping the
 * EWR in the river (examples/application.ts), run it, submit it, as the
 * applicant would through the API.
 */
async function seedApplication(project: { id: string; owner: string }) {
	const applicant = await ensureUser(APPLICANT);
	await linkFarmer(project.owner, project.id, applicant, APPLICANT.farm, 'contributor');
	const sid = await withUser(applicant, async (db) => {
		const { rows: pub } = await db.query<{ run_id: string }>('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [project.id]);
		const { rows: own } = await db.query<{ id: string }>('SELECT app_farm_nodes($1) AS id', [project.id]);
		const { rows: dam } = await db.query<{ capacity: number }>(
			`SELECT (n->>'damCapacityM3')::float8 AS capacity FROM app_published_run_input($1, $2) r, jsonb_array_elements(r.inputs->'model'->'nodes') n WHERE n->>'id' = $3`,
			[project.id, pub[0]!.run_id, own[0]!.id]
		);
		const { name, description, ops } = applicationOf(own[0]!.id, dam[0]!.capacity);
		const { rows } = await db.query<{ id: string }>(
			// Appendix C's prompts (129): two answered, mitigation left for the demo to show "Not given".
			`INSERT INTO scenario (project_id, name, description, base_run_id, ops, ops_sha256, owned_node_ids, purpose_need, monitoring)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
			[
				project.id,
				name,
				description,
				pub[0]!.run_id,
				JSON.stringify(ops),
				opsSha256(ops),
				own.map((r) => r.id),
				'Invented: winter storage so the orchard can be irrigated through the dry months without pumping from the river.',
				'Invented: a gauge plate on the dam wall, read weekly, and the outflow below the dam logged daily.'
			]
		);
		await recordAudit(db, project.id, 'scenario.created', { scenarioId: rows[0]!.id, application: true, baseRunId: pub[0]!.run_id, ops: ops.length });
		return rows[0]!.id;
	});
	// As the route runs it: no transaction open while the engine runs.
	const authorize = async (db: Db) => ({ role: 'contributor' as const, scenario: await loadScenario(db, project.id, sid) });
	await runScenario(applicant, project.id, undefined, authorize, async () => undefined);
	await withUser(applicant, async (db) => {
		const s = await loadScenario(db, project.id, sid);
		await db.query(`UPDATE scenario SET status = 'submitted' WHERE id = $1`, [sid]);
		await recordAudit(db, project.id, 'scenario.submitted', { scenarioId: sid, application: true, opsSha256: s.opsSha256 });
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	// CLI only: importing this module must not load dev env (the DB tests once ran against the dev database that way).
	loadDevEnv();
	seedExamples()
		.then(() =>
			console.log(
				`\nSign in as ${DEMO.email} or ${ANALYST.email}, as a farmer, ${FARMERS.map((f) => f.email).join(' or ')}, or as an applicant, ${APPLICANT.email} (password: ${DEMO.password})`
			)
		)
		.catch((err) => {
			console.error(err.message);
			process.exitCode = 1;
		})
		.finally(closePool);
}
