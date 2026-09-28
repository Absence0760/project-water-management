// Cross-project references (docs/security.md § Authorization, "Same-project
// references"). A user who is an editor or owner of BOTH project A and
// project B must not be able to make a row of A point at a row of B: not
// through RLS as water_app, and not through a route. RLS alone can't stop
// it (the user may write both projects), and a foreign key doesn't check a
// project, so every reference between two project-scoped tables needs a
// composite foreign key on (project_id, …) or a same-project trigger/check.
//
// Built from the live inventory, so a new reference is covered the day its
// migration lands:
//
//   1. pg_constraint: every foreign key onto a table with a project_id is
//      composite on project_id, or has a case below, or is an exemption
//      with its reason. A new one fails the inventory test until it's
//      classified.
//   2. Each case is one INSERT (and, where water_app may UPDATE that column,
//      an UPDATE), run twice with identical SQL: with A's row (positive
//      control: accepted, and the reference is stored) and with B's (refused,
//      or stored as something other than B's row).
//   3. The routes that take a reference in their body, each with the same
//      pair, found from the source tree (every uuid field of a zod schema is
//      a route case or an exemption with its reason).
//   4. At the end, no row of A or B, in any of those tables, references a row
//      of the other project.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withApiKey, withUser, type Db } from './tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

interface World {
	projectId: string;
	outletId: string;
	farmId: string;
	/** A farm with no crop area, farmer link or alert rule, for rows that are unique per farm. */
	farm2Id: string;
	cropId: string;
	runId: string;
	run2Id: string;
	revisionId: string;
	apiKeyId: string;
	feedId: string;
	publicationId: string;
	inviteId: string;
	reportJobId: string;
	sweepJobId: string;
	outlookJobId: string;
	yieldJobId: string;
	scheduleId: string;
	scenarioId: string;
	applicationId: string;
	sweepId: string;
	outlookId: string;
	/** A complete outlook with one level, "0", and its current publication to farmers (103). */
	completeOutlookId: string;
	outlookPublicationId: string;
	ruleId: string;
	ensembleId: string;
	series: { id: string; sha256: string; kind: string; startDate: string };
}

/** The dual editor: owner of A and of B. */
let dual: User;
/** A viewer of both, whom an application can be shared with. */
let viewer: User;
/** A farmer of both. */
let farmer: User;
let A: World;
let B: World;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Arrange rows as the schema owner with triggers off: parents only, never the rows under test. */
async function arrange<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

async function world(name: string): Promise<World> {
	const projectId = (await dual.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id);
	const farm2 = node('Farm two', outlet.id);
	const crop = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm, farm2], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await dual.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await dual.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await dual.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const runs: string[] = [];
	for (const label of ['First', 'Second']) {
		const run = await dual.call('POST', `/projects/${projectId}/runs`, { label });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		runs.push(run.body.run.id);
	}
	const [runId, run2Id] = runs as [string, string];
	const key = await dual.call('POST', `/projects/${projectId}/api-keys`, { name: 'Key' });
	expect(key.status).toBe(201);
	expect((await dual.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await dual.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);

	const [rev] = await asOwner('SELECT max(id)::text AS id FROM model_revision WHERE project_id = $1', [projectId]);
	const [series] = await asOwner(
		`SELECT series_id AS id, sha256, kind, to_char(start_date, 'YYYY-MM-DD') AS "startDate" FROM run_input_series WHERE run_id = $1 AND series_id IS NOT NULL LIMIT 1`,
		[runId]
	);
	const u = dual.id;
	const ids = await arrange(async (q) => {
		const one = async (sql: string, params: unknown[]) => (await q(`${sql} RETURNING id::text`, params))[0]!.id as string;
		const job = (kind: string) => one(`INSERT INTO job (project_id, kind, payload, status, finished_at, acting_user_id) VALUES ($1, $2, '{}', 'done', now(), $3)`, [projectId, kind, u]);
		return {
			feedId: await one(`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, acting_user_id, created_by) VALUES ($1, 'chirps', '{}', 'rain_catchment_mm', 'feed', $2, $2)`, [projectId, u]),
			publicationId: await one('INSERT INTO run_publication (project_id, run_id, published_by) VALUES ($1, $2, $3)', [projectId, runId, u]),
			inviteId: await one(`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at) VALUES ($1, $2, 'farmer', $3, $4, now() + interval '7 days')`, [
				`invitee-${randomUUID()}@example.com`,
				projectId,
				u,
				randomBytes(32)
			]),
			reportJobId: await job('report_render'),
			sweepJobId: await job('sweep'),
			outlookJobId: await job('outlook'),
			yieldJobId: await job('yield'),
			scheduleId: await one(`INSERT INTO report_schedule (project_id, frequency, weekday, hour, timezone, acting_user_id, created_by) VALUES ($1, 'weekly', 1, 6, 'UTC', $2, $2)`, [projectId, u]),
			scenarioId: await one(`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin) VALUES ($1, 'Team scenario', $2, repeat('a', 64), $3, 'team')`, [projectId, runId, u]),
			applicationId: await one(`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin) VALUES ($1, 'Application', $2, repeat('a', 64), $3, 'applicant')`, [projectId, runId, u]),
			sweepId: await one(`INSERT INTO scenario_sweep (project_id, base_run_id, name, created_by, status) VALUES ($1, $2, 'Sweep', $3, 'pending')`, [projectId, runId, u]),
			outlookId: await one(
				`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels, created_by, status) VALUES ($1, $2, 'Outlook', '2012-10-01', '2013-04-30', '[{}]', $3, 'pending')`,
				[projectId, runId, u]
			),
			completeOutlookId: await one(
				`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels, created_by, status, result, engine_version, completed_at)
				 VALUES ($1, $2, 'Published outlook', '2012-10-01', '2013-04-30', '[{"id": "0", "label": "85 %", "ops": []}]', $3, 'complete', '{}', 'x', now())`,
				[projectId, runId, u]
			),
			ruleId: await one(`INSERT INTO alert_rule (project_id, kind, node_id, threshold, created_by) VALUES ($1, 'dam_below', $2, 0.3, $3)`, [projectId, farm.id, u]),
			ensembleId: await one(
				`INSERT INTO run_uncertainty (project_id, run_id, runoff_model, engine_version, method, seed, members, options, status, accepted, summary, result, completed_at, created_by)
				 VALUES ($1, $2, 'gr4j', 'x', 'lhs', 1, 30, '{}', 'complete', 30, '{}', '{}', now(), $3)`,
				[projectId, runId, u]
			)
		};
	});
	const [pub] = await arrange((q) =>
		q(
			`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version, published_by)
			 VALUES ($1, $2, '0', '85 %', '2012-10-01', '2013-04-30', 'x', $3) RETURNING id::text`,
			[projectId, ids.completeOutlookId, u]
		)
	);
	return {
		projectId,
		outletId: outlet.id,
		outlookPublicationId: pub!.id as string,
		farmId: farm.id,
		farm2Id: farm2.id,
		cropId: crop.id,
		runId,
		run2Id,
		revisionId: rev!.id as string,
		apiKeyId: key.body.key.id,
		series: series as World['series'],
		...ids
	};
}

// ---------------------------------------------------------------------------
// The inventory: every foreign key onto a project-scoped table
// ---------------------------------------------------------------------------

interface Fk {
	child: string;
	cols: string[];
	parent: string;
	parentCols: string[];
	childHasProject: boolean;
	/** water_app may UPDATE every column of it, and some policy lets it UPDATE a row. */
	updatable: boolean;
	/** The child has an INSERT, UPDATE or ALL policy (else RLS lets water_app write none of it). */
	writable: boolean;
}

const FK_SQL = `
	WITH scoped AS (
		SELECT c.oid FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped
		WHERE c.relkind = 'r'
	)
	SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
		array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
		array(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS "parentCols",
		con.conrelid IN (SELECT oid FROM scoped) AS "childHasProject",
		(SELECT bool_and(has_column_privilege('water_app', con.conrelid, a.attnum, 'UPDATE')) FROM unnest(con.conkey) k(n) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n)
			AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = con.conrelid AND p.polcmd IN ('w', '*')) AS updatable,
		EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = con.conrelid AND p.polcmd IN ('a', 'w', '*')) AS writable
	FROM pg_constraint con
	WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace
		AND con.confrelid <> 'project'::regclass AND con.confrelid IN (SELECT oid FROM scoped)
	ORDER BY 1, 3`;

/**
 * Foreign keys onto a project-scoped table that need no same-project check,
 * with the reason. The inventory test checks each reason's premise.
 */
const EXEMPT: Record<string, { reason: string; premise: 'no project_id' | 'not writable' | 'cross-project by design' }> = {
	'api_key_throttle.key_id': { reason: 'no project_id of its own: the row is its key’s, in the key’s project', premise: 'no project_id' },
	'report_schedule_recipient.schedule_id': {
		reason: 'no project_id of its own: the row is its schedule’s (report_schedule_recipient_check holds the recipient to that project’s members)',
		premise: 'no project_id'
	},
	// An impact report's baseline (082) may be another project's run, as in
	// Compare runs: not a same-project reference but a read. The trigger
	// checks the writer can READ it, under RLS, and the column is fixed at
	// insert (no UPDATE), so that check is the only way in. Tested in
	// reports/reports.db.test.ts "impact reports".
	'report.against_run_id': {
		reason: 'an impact report’s baseline, cross-project on purpose: report_enqueue requires the requester to read it (reports.db.test.ts)',
		premise: 'cross-project by design'
	},
	'render_token.against_run_id': {
		reason: 'the render session’s baseline, cross-project on purpose: render_token_issue requires the issuer to read it (reports.db.test.ts)',
		premise: 'cross-project by design'
	},
	'alert_delivery.event_id': {
		reason: 'water_app writes none of it (no INSERT or UPDATE policy); app_alert_fan_out, SECURITY DEFINER, copies the project from the event',
		premise: 'not writable'
	}
};

type Stmt = [sql: string, params: unknown[]];

interface Case {
	/** The referenced row, in a world. */
	ref: (w: World) => string;
	/** An INSERT into `home` whose column is `refId`; the harness appends RETURNING. */
	insert: (home: World, refId: string, db: Db) => Stmt | Promise<Stmt>;
	/** Run as `home`'s API key instead of the dual editor (no RETURNING: a key reads no audit event back). */
	asKey?: true;
	/** The stored value isn't the ref (a row the case makes): the control need only succeed, the attack must be refused. */
	mustRefuse?: true;
}

const u = () => dual.id;
const nonce = () => randomBytes(32);

/** Keyed `table.column`: one per non-composite foreign key of the inventory. */
const CASES: Record<string, Case> = {
	'node.downstream_node_id': {
		ref: (w) => w.outletId,
		insert: (h, ref) => [`INSERT INTO node (id, project_id, name, kind, downstream_node_id) VALUES ($1, $2, $3, 'farm', $4)`, [randomUUID(), h.projectId, `N ${randomUUID()}`, ref]]
	},
	'crop_area.crop_id': { ref: (w) => w.cropId, insert: (h, ref) => ['INSERT INTO crop_area (project_id, node_id, crop_id, area_m2) VALUES ($1, $2, $3, 1)', [h.projectId, h.farm2Id, ref]] },
	'crop_area.node_id': { ref: (w) => w.farm2Id, insert: (h, ref) => ['INSERT INTO crop_area (project_id, node_id, crop_id, area_m2) VALUES ($1, $2, $3, 1)', [h.projectId, ref, h.cropId]] },
	'transfer.from_node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => ['INSERT INTO transfer (id, project_id, from_node_id, to_node_id) VALUES ($1, $2, $3, $4)', [randomUUID(), h.projectId, ref, h.outletId]]
	},
	'transfer.to_node_id': {
		ref: (w) => w.outletId,
		insert: (h, ref) => ['INSERT INTO transfer (id, project_id, from_node_id, to_node_id) VALUES ($1, $2, $3, $4)', [randomUUID(), h.projectId, h.farmId, ref]]
	},
	'land_cover.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [`INSERT INTO land_cover (project_id, node_id, cover_class, area_km2, density_pct) VALUES ($1, $2, 'pine', 1, 0.5)`, [h.projectId, ref]]
	},
	'borehole.node_id': { ref: (w) => w.farmId, insert: (h, ref) => [`INSERT INTO borehole (project_id, node_id, name, capacity_m3_day) VALUES ($1, $2, 'Bore', 10)`, [h.projectId, ref]] },
	'demand_object.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [`INSERT INTO demand_object (project_id, node_id, name, monthly_m3_day) VALUES ($1, $2, 'Town', array_fill(1::float8, ARRAY[12]))`, [h.projectId, ref]]
	},
	'farm_link.node_id': { ref: (w) => w.farm2Id, insert: (h, ref) => ['INSERT INTO farm_link (project_id, node_id, user_id) VALUES ($1, $2, $3)', [h.projectId, ref, farmer.id]] },
	'invite_node.invite_id': { ref: (w) => w.inviteId, insert: (h, ref) => ['INSERT INTO invite_node (invite_id, project_id, node_id) VALUES ($1, $2, $3)', [ref, h.projectId, h.farmId]] },
	'invite_node.node_id': { ref: (w) => w.farmId, insert: (h, ref) => ['INSERT INTO invite_node (invite_id, project_id, node_id) VALUES ($1, $2, $3)', [h.inviteId, h.projectId, ref]] },
	'allocation.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [`INSERT INTO allocation (project_id, node_id, authorisation, water_source, volume_m3_year) VALUES ($1, $2, 'licence', 'surface', 1)`, [h.projectId, ref]]
	},
	'alert_rule.node_id': {
		ref: (w) => w.farm2Id,
		insert: (h, ref) => [`INSERT INTO alert_rule (project_id, kind, node_id, threshold) VALUES ($1, 'dam_below', $2, 0.3)`, [h.projectId, ref]]
	},
	'alert_rule.feed_id': {
		ref: (w) => w.feedId,
		insert: (h, ref) => [`INSERT INTO alert_rule (project_id, kind, threshold, feed_id) VALUES ($1, 'data_stale', 5, $2)`, [h.projectId, ref]]
	},
	'alert_subscription.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [
			`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce) VALUES ($1, $2, 'dam_below', $3, 'immediate', $4)`,
			[u(), h.projectId, ref, nonce()]
		]
	},
	'alert_event.rule_id': { ref: (w) => w.ruleId, insert: (h, ref) => [`INSERT INTO alert_event (rule_id, project_id, state, value) VALUES ($1, $2, 'firing', 1)`, [ref, h.projectId]] },
	// The guard takes the farm from the rule, whatever the insert says.
	'alert_event.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [`INSERT INTO alert_event (rule_id, project_id, state, value, node_id) VALUES ($1, $2, 'firing', 1, $3)`, [h.ruleId, h.projectId, ref]]
	},
	'alert_event.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [`INSERT INTO alert_event (rule_id, project_id, state, value, run_id) VALUES ($1, $2, 'firing', 1, $3)`, [h.ruleId, h.projectId, ref]]
	},
	'audit_event.actor_api_key_id': {
		asKey: true,
		mustRefuse: true,
		ref: (w) => w.apiKeyId,
		insert: (h, ref) => [`INSERT INTO audit_event (project_id, actor_api_key_id, actor_label, kind) VALUES ($1, $2, 'Key', 'series.put')`, [h.projectId, ref]]
	},
	'feed_stage.feed_id': {
		ref: (w) => w.feedId,
		insert: (h, ref) => [
			`INSERT INTO feed_stage (feed_id, project_id, start_date, "values", product, product_version, replace_from) VALUES ($1, $2, '2020-01-01', '{1}', 'p', 'v1', '')`,
			[ref, h.projectId]
		]
	},
	'model_revision.restored_from': {
		ref: (w) => w.revisionId,
		insert: (h, ref) => [`INSERT INTO model_revision (project_id, created_by, source, snapshot, restored_from) VALUES ($1, $2, 'restore', '{}', $3)`, [h.projectId, u(), ref]]
	},
	'model_run.scenario_id': {
		ref: (w) => w.scenarioId,
		insert: (h, ref) => [
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, 'x', '2020-01-01', '2020-01-02', '{}', $3)`,
			[h.projectId, u(), ref]
		]
	},
	'note.node_id': { ref: (w) => w.farmId, insert: (h, ref) => [`INSERT INTO note (project_id, author_id, body, node_id) VALUES ($1, $2, 'x', $3)`, [h.projectId, u(), ref]] },
	'note.run_id': { ref: (w) => w.runId, insert: (h, ref) => [`INSERT INTO note (project_id, author_id, body, run_id) VALUES ($1, $2, 'x', $3)`, [h.projectId, u(), ref]] },
	'publication_farm.node_id': {
		ref: (w) => w.farmId,
		insert: (h, ref) => [`INSERT INTO publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, '{}')`, [h.publicationId, h.projectId, ref]]
	},
	'publication_farm.publication_id': {
		ref: (w) => w.publicationId,
		insert: (h, ref) => [`INSERT INTO publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, '{}')`, [ref, h.projectId, h.farmId]]
	},
	// Ended, so it isn't a second current publication.
	'outlook_publication.outlook_id': {
		ref: (w) => w.completeOutlookId,
		insert: (h, ref) => [
			`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version, ended_at) VALUES ($1, $2, '0', 'x', '2012-10-01', '2013-04-30', 'x', now())`,
			[h.projectId, ref]
		]
	},
	'outlook_publication_farm.publication_id': {
		ref: (w) => w.outlookPublicationId,
		insert: (h, ref) => [`INSERT INTO outlook_publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, '{}')`, [ref, h.projectId, h.farmId]]
	},
	'outlook_publication_farm.node_id': {
		ref: (w) => w.farm2Id,
		insert: (h, ref) => [`INSERT INTO outlook_publication_farm (publication_id, project_id, node_id, view) VALUES ($1, $2, $3, '{}')`, [h.outlookPublicationId, h.projectId, ref]]
	},
	'render_token.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [`INSERT INTO render_token (token_hash, user_id, project_id, run_id, expires_at) VALUES ($1, $2, $3, $4, now())`, [nonce(), u(), h.projectId, ref]]
	},
	'report.job_id': { ref: (w) => w.reportJobId, insert: (h, ref) => ['INSERT INTO report (project_id, requested_by, job_id) VALUES ($1, $2, $3)', [h.projectId, u(), ref]] },
	'report.run_id': { ref: (w) => w.runId, insert: (h, ref) => ['INSERT INTO report (project_id, requested_by, run_id) VALUES ($1, $2, $3)', [h.projectId, u(), ref]] },
	'report.schedule_id': { ref: (w) => w.scheduleId, insert: (h, ref) => ['INSERT INTO report (project_id, requested_by, schedule_id) VALUES ($1, $2, $3)', [h.projectId, u(), ref]] },
	// Its policy wants a run made in this transaction: make one in the referenced project.
	'run_input_series.run_id': {
		mustRefuse: true,
		ref: (w) => w.runId,
		insert: async (h, ref, db) => {
			const refProject = ref === A.runId ? A.projectId : B.projectId;
			const { rows } = await db.query(
				`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, 'x', '2020-01-01', '2020-01-02', '{}') RETURNING id`,
				[refProject, u()]
			);
			return [
				'INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256, series_id) VALUES ($1, $2, $3, $4, $5, $6)',
				[rows[0].id, h.projectId, h.series.kind, h.series.startDate, h.series.sha256, h.series.id]
			];
		}
	},
	'run_nomination.run_id': { ref: (w) => w.runId, insert: (h, ref) => [`INSERT INTO run_nomination (project_id, run_id, reason) VALUES ($1, $2, 'x')`, [h.projectId, ref]] },
	// Superseded, so it isn't a second current publication.
	'run_publication.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => ['INSERT INTO run_publication (project_id, run_id, published_by, superseded_at) VALUES ($1, $2, $3, now())', [h.projectId, ref, u()]]
	},
	'run_series.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [`INSERT INTO run_series (run_id, project_id, key, "values") VALUES ($1, $2, $3, '{1}')`, [ref, h.projectId, `x_${randomUUID().slice(0, 8)}`]]
	},
	'run_uncertainty.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [
			`INSERT INTO run_uncertainty (project_id, run_id, runoff_model, engine_version, method, seed, members, options, created_by) VALUES ($1, $2, 'gr4j', 'x', 'lhs', 0, 30, '{}', $3)`,
			[h.projectId, ref, u()]
		]
	},
	'run_uncertainty.baseline_id': {
		ref: (w) => w.ensembleId,
		insert: (h, ref) => [
			`INSERT INTO run_uncertainty (project_id, run_id, baseline_id, runoff_model, engine_version, method, seed, members, options, created_by) VALUES ($1, $2, $3, 'gr4j', 'x', 'lhs', 0, 30, '{}', $4)`,
			[h.projectId, h.run2Id, ref, u()]
		]
	},
	'scenario.base_run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256) VALUES ($1, $2, $3, repeat('a', 64))`, [h.projectId, `S ${randomUUID()}`, ref]]
	},
	'scenario_member.scenario_id': {
		ref: (w) => w.applicationId,
		insert: (h, ref) => ['INSERT INTO scenario_member (scenario_id, project_id, user_id) VALUES ($1, $2, $3)', [ref, h.projectId, viewer.id]]
	},
	'scenario_sweep.base_run_id': { ref: (w) => w.runId, insert: (h, ref) => [`INSERT INTO scenario_sweep (project_id, base_run_id, name) VALUES ($1, $2, 'x')`, [h.projectId, ref]] },
	'scenario_sweep.job_id': {
		ref: (w) => w.sweepJobId,
		insert: (h, ref) => [`INSERT INTO scenario_sweep (project_id, base_run_id, name, job_id) VALUES ($1, $2, 'x', $3)`, [h.projectId, h.runId, ref]]
	},
	'scenario_sweep_member.sweep_id': {
		ref: (w) => w.sweepId,
		insert: (h, ref) => [
			`INSERT INTO scenario_sweep_member (sweep_id, project_id, position, name, ops, ops_sha256) VALUES ($1, $2, 9, 'y', '[]', repeat('a', 64))`,
			[ref, h.projectId]
		]
	},
	'seasonal_outlook.base_run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [
			`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'x', '2012-10-01', '2013-04-30', '[{}]')`,
			[h.projectId, ref]
		]
	},
	'seasonal_outlook.job_id': {
		ref: (w) => w.outlookJobId,
		insert: (h, ref) => [
			`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels, job_id) VALUES ($1, $2, 'x', '2012-10-01', '2013-04-30', '[{}]', $3)`,
			[h.projectId, h.runId, ref]
		]
	},
	'seasonal_outlook_member.outlook_id': {
		ref: (w) => w.outlookId,
		insert: (h, ref) => [
			`INSERT INTO seasonal_outlook_member (outlook_id, project_id, level_position, water_year, status, problems) VALUES ($1, $2, 0, 2012, 'failed', '["x"]')`,
			[ref, h.projectId]
		]
	},
	'signoff.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [
			`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
			 VALUES ($1, $2, $3, 'A Person', 'SACNASP', '1', 'x', 'signoff-1', repeat('a', 64), 'v1')`,
			[h.projectId, ref, u()]
		]
	},
	'yield_result.job_id': {
		ref: (w) => w.yieldJobId,
		insert: (h, ref) => [
			`INSERT INTO yield_result (project_id, run_id, node_id, job_id, kind, params, points, engine_version) VALUES ($1, $2, $3, $4, 'firm', '{}', '{}', 'x')`,
			[h.projectId, h.runId, h.farmId, ref]
		]
	},
	'yield_result.run_id': {
		ref: (w) => w.runId,
		insert: (h, ref) => [`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`, [h.projectId, ref, h.farmId]]
	},
	'yield_result.scenario_id': {
		ref: (w) => w.scenarioId,
		insert: (h, ref) => [
			`INSERT INTO yield_result (project_id, scenario_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', 'x')`,
			[h.projectId, ref, h.farmId]
		]
	}
};

/** How a refused cross-project write fails: a foreign-key or check violation, or RLS's WITH CHECK. */
const REFUSED = new Set(['23503', '23514', '42501']);

class Rollback extends Error {}

type Outcome = { ok: true; stored: string | null } | { ok: false; code: string; message: string };

/**
 * Run a case in a transaction that is always rolled back: the INSERT with
 * `refId`, or (`update`) the INSERT with home's own row and then an UPDATE of
 * that row's column to `refId`. Returns what was stored, or how it failed.
 */
async function attempt(key: string, c: Case, home: World, refId: string, update: boolean): Promise<Outcome> {
	const [table, col] = key.split('.') as [string, string];
	let stored: string | null = null;
	const body = async (db: Db) => {
		const [sql, params] = await c.insert(home, update ? c.ref(home) : refId, db);
		if (c.asKey) {
			await db.query(sql, params);
			stored = refId;
			throw new Rollback();
		}
		const { rows } = await db.query(`${sql} RETURNING ctid::text AS ctid, ${col}::text AS ref`, params);
		stored = rows[0].ref;
		if (update) {
			const res = await db.query(`UPDATE ${table} SET ${col} = $1 WHERE ctid = $2::tid RETURNING ${col}::text AS ref`, [refId, rows[0].ctid]);
			expect(res.rowCount, `${key}: the UPDATE reached its row`).toBe(1);
			stored = res.rows[0].ref;
		}
		throw new Rollback();
	};
	try {
		await (c.asKey ? withApiKey(home.apiKeyId, body) : withUser(dual.id, body));
		throw new Error('unreachable');
	} catch (err) {
		if (err instanceof Rollback) return { ok: true, stored };
		const e = err as { code?: string; message: string };
		if (!e.code) throw err;
		return { ok: false, code: e.code, message: e.message };
	}
}

let inventory: Fk[] = [];

beforeAll(async () => {
	[dual, viewer, farmer] = await Promise.all([signUp('Dual'), signUp('DualViewer'), signUp('DualFarmer')]);
	A = await world('Project A');
	B = await world('Project B');
	inventory = (await asOwner(FK_SQL)) as unknown as Fk[];
}, 60_000);

afterAll(async () => {
	// Nothing the routes queued is left for another file's tick to pick up.
	await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE project_id = ANY($1) AND status <> 'done'`, [
		[A.projectId, B.projectId]
	]);
});

describe('the inventory of references between project-scoped tables', () => {
	it('classifies every foreign key: composite on project_id, a case below, or an exemption whose premise holds', () => {
		expect(inventory.length).toBeGreaterThan(40);
		const unclassified: string[] = [];
		const seen = new Set<string>();
		for (const fk of inventory) {
			if (fk.cols.includes('project_id')) {
				// Composite: the child's project_id must be matched to the parent's.
				expect(fk.parentCols[fk.cols.indexOf('project_id')], `${fk.child}(${fk.cols}) → ${fk.parent}(${fk.parentCols})`).toBe('project_id');
				continue;
			}
			expect(fk.cols, `${fk.child} → ${fk.parent}`).toHaveLength(1);
			const key = `${fk.child}.${fk.cols[0]}`;
			seen.add(key);
			const exempt = EXEMPT[key];
			if (exempt) {
				if (exempt.premise === 'no project_id') expect(fk.childHasProject, key).toBe(false);
				else if (exempt.premise === 'not writable') expect(fk.writable, key).toBe(false);
				// Fixed at insert: the insert-time readability check can't be sidestepped by an UPDATE.
				else expect(fk.updatable, key).toBe(false);
				continue;
			}
			if (!CASES[key]) unclassified.push(key);
		}
		expect(unclassified, 'a foreign key between project-scoped tables with no same-project check test: add a case (and the check)').toEqual([]);
		// No stale entries.
		expect([...Object.keys(CASES), ...Object.keys(EXEMPT)].filter((k) => !seen.has(k))).toEqual([]);
	});
});

describe('through RLS as water_app, by an editor of both projects', () => {
	for (const [key, c] of Object.entries(CASES)) {
		it(key, async () => {
			const fk = inventory.find((f) => `${f.child}.${f.cols[0]}` === key && f.cols.length === 1);
			expect(fk, `${key} is in the inventory`).toBeDefined();
			for (const update of fk!.updatable ? [false, true] : [false]) {
				const how = update ? 'UPDATE' : 'INSERT';
				// Positive control: A's own row is accepted and stored.
				const control = await attempt(key, c, A, c.ref(A), update);
				if (c.mustRefuse) expect(control.ok, `${key} ${how} with project A's row: ${JSON.stringify(control)}`).toBe(true);
				else expect(control, `${key} ${how} with project A's row`).toEqual({ ok: true, stored: c.ref(A) });
				// B's row: refused, or not what was stored.
				const attack = await attempt(key, c, A, c.ref(B), update);
				if (attack.ok && c.mustRefuse) expect.fail(`${key} ${how} accepted project B's row`);
				if (attack.ok) expect(attack.stored, `${key} ${how} stored project B's row`).not.toBe(c.ref(B));
				else expect(REFUSED.has(attack.code), `${key} ${how}: ${attack.code} ${attack.message}`).toBe(true);
			}
		});
	}

	it("can't plant a restore of another project's revision, whose id is a guessable integer, even from outside it", async () => {
		// Before 069 a plain editor of their own project could name any
		// revision id, and the NO ACTION foreign key then blocked deleting the
		// victim's project. The ids are sequential, so no access was needed.
		const outsider = await signUp('RevisionOutsider');
		const own = (await outsider.call('POST', '/projects', { name: 'Own' })).body.project.id as string;
		expect((await outsider.call('PUT', `/projects/${own}/model`, { nodes: [node('Outlet', null)], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const [mine] = await asOwner('SELECT max(id)::text AS id FROM model_revision WHERE project_id = $1', [own]);
		const plant = (rev: string) =>
			withUser(outsider.id, (db) =>
				db.query(`INSERT INTO model_revision (project_id, created_by, source, snapshot, restored_from) VALUES ($1, $2, 'restore', '{}', $3) RETURNING id`, [own, outsider.id, rev])
			);
		await expect(plant(mine!.id as string)).resolves.toMatchObject({ rowCount: 1 });
		await expect(plant(A.revisionId)).rejects.toMatchObject({ code: '23503' });
		expect(await asOwner('SELECT count(*)::int AS n FROM model_revision WHERE restored_from = $1 AND project_id <> $2', [A.revisionId, A.projectId])).toEqual([{ n: 0 }]);
	});

	it("can't record a restore of another project's run", async () => {
		const plant = (runId: string) =>
			withUser(dual.id, (db) =>
				db.query(`INSERT INTO model_revision (project_id, created_by, source, snapshot, restored_from_run) VALUES ($1, $2, 'restore', '{}', $3) RETURNING id`, [
					A.projectId,
					dual.id,
					runId
				])
			);
		await expect(plant(A.runId)).resolves.toMatchObject({ rowCount: 1 });
		await expect(plant(B.runId)).rejects.toMatchObject({ code: '23503' });
	});
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Res = { status: number; body: { error?: string } | null };

const modelOf = (w: World, patch: Record<string, unknown> = {}) => ({
	nodes: [node('Outlet', null, { id: w.outletId }), node('Farm', w.outletId, { id: w.farmId }), node('Farm two', w.outletId, { id: w.farm2Id })],
	crops: [{ id: w.cropId, name: 'Lucerne', cropFactor: monthly(0.8) }],
	cropAreas: [{ nodeId: w.farmId, cropId: w.cropId, areaM2: 10_000 }],
	transfers: [],
	...patch
});
const transferOf = (from: string, to: string) => ({ id: randomUUID(), fromNodeId: from, toNodeId: to, months: [1, 2, 3], maxRateM3s: 1, dailyCapM3: 0, minStoragePct: 0, enabled: true, priority: 0 });

/** Write routes whose body names another row, each sent with A's row (control) and B's (attack). */
const ROUTES: Record<string, (h: World, r: World) => Promise<Res>> = {
	'POST /projects/:id/scenarios baseRunId': (h, r) => dual.call('POST', `/projects/${h.projectId}/scenarios`, { name: `S ${randomUUID()}`, baseRunId: r.runId }),
	'POST /projects/:id/publication runId': (h, r) => dual.call('POST', `/projects/${h.projectId}/publication`, { runId: r.run2Id }),
	'POST /projects/:id/evidence runId': (h, r) => dual.call('POST', `/projects/${h.projectId}/evidence`, { runId: r.runId, reason: 'Cross-project sweep' }),
	'POST /projects/:id/reports runId': (h, r) => dual.call('POST', `/projects/${h.projectId}/reports`, { runId: r.runId }),
	'POST /projects/:id/sweeps baseRunId': (h, r) =>
		dual.call('POST', `/projects/${h.projectId}/sweeps`, { name: `W ${randomUUID()}`, baseRunId: r.runId, members: [{ name: 'm', ops: [{ op: 'demand.scale', factor: 0.9 }] }] }),
	'POST /projects/:id/yield runId': (h, r) => dual.call('POST', `/projects/${h.projectId}/yield`, { nodeId: h.farmId, runId: r.runId, kind: 'firm' }),
	'POST /projects/:id/yield nodeId': (h, r) => dual.call('POST', `/projects/${h.projectId}/yield`, { nodeId: r.farmId, runId: h.run2Id, kind: 'firm' }),
	'POST /projects/:id/notes runId': (h, r) => dual.call('POST', `/projects/${h.projectId}/notes`, { body: 'On a run', runId: r.runId }),
	'POST /projects/:id/notes nodeId': (h, r) => dual.call('POST', `/projects/${h.projectId}/notes`, { body: 'On a farm', nodeId: r.farmId }),
	'PUT /projects/:id/alert-rules nodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/alert-rules`, { rules: [{ kind: 'dam_below', nodeId: r.farm2Id, threshold: 0.3, enabled: true }] }),
	'PUT /projects/:id/alert-rules feedId': (h, r) => dual.call('PUT', `/projects/${h.projectId}/alert-rules`, { rules: [{ kind: 'data_stale', feedId: r.feedId, threshold: 5, enabled: true }] }),
	// Per-farm choices are a farmer's: the farmer of both, linked to "Farm" in each.
	'PUT /me/alerts/:projectId nodeId': (h, r) => farmer.call('PUT', `/me/alerts/${h.projectId}`, { items: [{ kind: 'dam_below', nodeId: r.farmId, mode: 'immediate' }] }),
	'POST /projects/:id/allocations nodeId': (h, r) =>
		dual.call('POST', `/projects/${h.projectId}/allocations`, { nodeId: r.farmId, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 }),
	'PUT /projects/:id/model downstreamNodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, {
			...modelOf(h),
			nodes: [node('Outlet', null, { id: h.outletId }), node('Farm', h.outletId, { id: h.farmId }), node('Farm two', r.outletId, { id: h.farm2Id })]
		}),
	'PUT /projects/:id/model cropAreas.cropId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { cropAreas: [{ nodeId: h.farmId, cropId: h.cropId, areaM2: 10_000 }, { nodeId: h.farm2Id, cropId: r.cropId, areaM2: 1 }] })),
	'PUT /projects/:id/model cropAreas.nodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { cropAreas: [{ nodeId: h.farmId, cropId: h.cropId, areaM2: 10_000 }, { nodeId: r.farm2Id, cropId: h.cropId, areaM2: 1 }] })),
	'PUT /projects/:id/model transfers.toNodeId': (h, r) => dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { transfers: [transferOf(h.farmId, r.farm2Id)] })),
	'PUT /projects/:id/model landCover.nodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { landCover: [{ id: randomUUID(), nodeId: r.farmId, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null }] })),
	'PUT /projects/:id/model boreholes.nodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { boreholes: [{ id: randomUUID(), nodeId: r.farmId, name: 'Bore', capacityM3Day: 10 }] })),
	'PUT /projects/:id/model demandObjects.nodeId': (h, r) =>
		dual.call('PUT', `/projects/${h.projectId}/model`, modelOf(h, { demandObjects: [{ id: randomUUID(), nodeId: r.farmId, name: 'Town', monthlyM3Day: new Array(12).fill(1) }] }))
};

describe('through the routes, by an editor of both projects', () => {
	for (const [name, send] of Object.entries(ROUTES)) {
		it(name, async () => {
			const control = await send(A, A);
			expect(control.status, `${name} with project A's row: ${JSON.stringify(control.body)}`).toBeGreaterThanOrEqual(200);
			expect(control.status).toBeLessThan(300);
			const attack = await send(A, B);
			expect([400, 404, 409], `${name} with project B's row: ${attack.status} ${JSON.stringify(attack.body)}`).toContain(attack.status);
			// Never the database's words.
			expect(JSON.stringify(attack.body)).not.toMatch(/belongs to a different project|violates|foreign key/i);
		});
	}

	it('leaves no row of either project referencing a row of the other, in any table of the inventory', async () => {
		const leaks: string[] = [];
		for (const fk of inventory) {
			if (!fk.childHasProject || fk.cols.includes('project_id')) continue;
			if (EXEMPT[`${fk.child}.${fk.cols[0]}`]?.premise === 'cross-project by design') continue;
			const [n] = await asOwner(
				`SELECT count(*)::int AS n FROM ${fk.child} c JOIN ${fk.parent} p ON p.${fk.parentCols[0]} = c.${fk.cols[0]}
				 WHERE c.project_id = ANY($1) AND p.project_id IS DISTINCT FROM c.project_id`,
				[[A.projectId, B.projectId]]
			);
			if ((n as { n: number }).n) leaks.push(`${fk.child}.${fk.cols[0]}: ${(n as { n: number }).n}`);
		}
		expect(leaks).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The route inventory: every uuid field of a request schema
// ---------------------------------------------------------------------------

/**
 * `file:field` for every uuid-typed field of a zod schema in backend/src
 * (tests aside) that names another row, mapped to the ROUTES entries that
 * try it or the reason it needs none. A new one fails until it's classified.
 */
const FIELDS: Record<string, string[] | string> = {
	'alerts/routes.ts:nodeId': ['PUT /me/alerts/:projectId nodeId', 'PUT /projects/:id/alert-rules nodeId'],
	'alerts/routes.ts:feedId': ['PUT /projects/:id/alert-rules feedId'],
	'allocations/routes.ts:nodeId': ['POST /projects/:id/allocations nodeId'],
	'export/routes.ts:nodeId': 'a read filter within the project: another project’s node matches nothing',
	'history/routes.ts:nodeId': 'a read filter within the project: another project’s node matches nothing',
	'jobs/handlers/feed-fetch.ts:feedId': 'a job payload: jobs/trust.security.db.test.ts holds every payload to its job’s project',
	'jobs/handlers/feed-ingest.ts:feedId': 'a job payload: jobs/trust.security.db.test.ts',
	'jobs/handlers/feed-ingest.ts:fetchJobId': 'a job payload: jobs/trust.security.db.test.ts',
	'jobs/handlers/report-render.ts:reportId': 'a job payload: jobs/trust.security.db.test.ts',
	'jobs/transport.ts:fetchJobId': 'a queue envelope between the app’s own Lambdas, not a request',
	'jobs/transport.ts:feedId': 'a queue envelope between the app’s own Lambdas, not a request',
	'jobs/transport.ts:reportId': 'a queue envelope between the app’s own Lambdas, not a request',
	'jobs/transport.ts:projectId': 'a queue envelope between the app’s own Lambdas, not a request',
	'jobs/transport.ts:runId': 'a queue envelope between the app’s own Lambdas, not a request',
	'lambda-fetcher.ts:fetchJobId': 'a queue envelope between the app’s own Lambdas, not a request',
	'lambda-fetcher.ts:feedId': 'a queue envelope between the app’s own Lambdas, not a request',
	'model/validate.ts:downstreamNodeId': ['PUT /projects/:id/model downstreamNodeId'],
	'model/validate.ts:nodeId': ['PUT /projects/:id/model cropAreas.nodeId', 'PUT /projects/:id/model landCover.nodeId', 'PUT /projects/:id/model boreholes.nodeId', 'PUT /projects/:id/model demandObjects.nodeId'],
	'model/validate.ts:cropId': ['PUT /projects/:id/model cropAreas.cropId'],
	'model/validate.ts:fromNodeId': 'the same store path as toNodeId (transfer_same_project checks both)',
	'model/validate.ts:toNodeId': ['PUT /projects/:id/model transfers.toNodeId'],
	'notes/routes.ts:nodeId': ['POST /projects/:id/notes nodeId'],
	'notes/routes.ts:runId': ['POST /projects/:id/notes runId'],
	'outlooks/routes.ts:baseRunId': 'a read filter within the project',
	'outlooks/schema.ts:baseRunId': 'checked by seasonal_outlook_guard (the SQL case) and outlooks.db.test.ts; the route needs a multi-year record',
	'outlooks/schema.ts:outlookId': 'a job payload: jobs/trust.security.db.test.ts',
	'projects/outcomeSettings.ts:siteNodeId': 'checkOutcomeSite: outcomeSettings.db.test.ts refuses another project’s node',
	'projects/document.ts:siteNodeId': 'a node of the file’s own model, moved to its fresh id on import (projectFileProblems refuses any other): series/site.db.test.ts',
	'projects/routes.ts:teamId': 'a team, not a project row: teams/teams.security.db.test.ts',
	'publish/publish.ts:runId': ['POST /projects/:id/publication runId'],
	'reports/routes.ts:runId': ['POST /projects/:id/reports runId'],
	'runs/evidence.ts:runId': ['POST /projects/:id/evidence runId'],
	'runs/routes.ts:nodeId': 'a read filter within the run',
	'runs/uncertainty.ts:baselineId': 'checked by run_uncertainty_start (the SQL case); the route needs a completed ensemble, uncertainty.db.test.ts',
	'scenarios/schema.ts:baseRunId': ['POST /projects/:id/scenarios baseRunId'],
	'series/routes.ts:siteNodeId': 'setSite finds the node in the project (400 otherwise) and time_series_site_same_project refuses another project’s node: series/site.db.test.ts, both',
	'scenarios/schema.ts:userId': 'a person, not a project row: scenario_member’s composite key on (project_id, user_id)',
	'sweeps/routes.ts:baseRunId': 'a read filter within the project',
	'sweeps/schema.ts:baseRunId': ['POST /projects/:id/sweeps baseRunId'],
	'sweeps/schema.ts:sweepId': 'a job payload: jobs/trust.security.db.test.ts',
	'yield/routes.ts:runId': ['POST /projects/:id/yield runId'],
	'yield/routes.ts:scenarioId': 'a read filter within the project',
	'yield/routes.ts:nodeId': 'a read filter within the project',
	'yield/routes.ts:jobId': 'a read filter within the project',
	'yield/store.ts:nodeId': ['POST /projects/:id/yield nodeId'],
	'yield/store.ts:runId': ['POST /projects/:id/yield runId'],
	'yield/store.ts:scenarioId': 'checked by yield_result_guard (the SQL case)'
};

const SRC = fileURLToPath(new URL('..', import.meta.url));
/** `name: z.string().uuid()`, `name: z.string().regex(UUID)`, `name: uuid`, `name: Uuid`. */
const UUID_FIELD = /\b([a-z][A-Za-z]*Id)\s*:\s*(?:z\s*\.\s*string\(\)\s*\.\s*(?:uuid\(|regex\(UUID)|uuid\b|Uuid\b)/g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
		return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
	});
}

describe('the inventory of request fields that name a row', () => {
	it('tries every one through its route, or says why not', () => {
		const found = new Set<string>();
		for (const file of sourceFiles(SRC)) for (const m of readFileSync(file, 'utf8').matchAll(UUID_FIELD)) found.add(`${relative(SRC, file)}:${m[1]}`);
		expect(found.size).toBeGreaterThan(30);
		expect([...found].filter((f) => !(f in FIELDS)).sort(), 'a uuid field with no cross-project route case: add one to ROUTES, or a reason').toEqual([]);
		expect(Object.keys(FIELDS).filter((f) => !found.has(f)), 'stale').toEqual([]);
		for (const [field, cover] of Object.entries(FIELDS)) if (Array.isArray(cover)) for (const r of cover) expect(ROUTES[r], `${field} → ${r}`).toBeDefined();
	});
});
