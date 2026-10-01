// Direct database access for the few e2e flows that start from an email.
// Tokens are stored only as SHA-256 hashes, and e2e prints mail to the
// backend's log (MAIL_TRANSPORT=log) rather than to somewhere a test can read,
// so these helpers plant a token whose plaintext the test knows, the way the
// backend would have issued it. Runs as the schema owner on the isolated
// `water_e2e` database; `pg` is the backend's own (see global-setup.ts).
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OWNER_E2E_URL } from './env.ts';

interface PgClient {
	connect(): Promise<void>;
	query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: R[] }>;
	end(): Promise<void>;
}
type PgModule = { Client: new (opts: { connectionString: string }) => PgClient };

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
const pg = createRequire(`${backendDir}package.json`)('pg') as PgModule;

async function withDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
	const db = new pg.Client({ connectionString: OWNER_E2E_URL });
	await db.connect();
	try {
		return await fn(db);
	} finally {
		await db.end();
	}
}

/**
 * Run `fn` holding a Postgres advisory lock on the e2e database, so specs in
 * parallel workers that need the same one-off setup (the seeded example
 * catchments) do it once, in turn, instead of racing. Blocks until the lock
 * is free; no polling.
 */
export async function withSetupLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
	return withDb(async (db) => {
		await db.query('SELECT pg_advisory_lock($1)', [key]);
		try {
			return await fn();
		} finally {
			await db.query('SELECT pg_advisory_unlock($1)', [key]);
		}
	});
}

function newToken(): { token: string; hash: Buffer } {
	const token = randomBytes(32).toString('base64url');
	return { token, hash: createHash('sha256').update(token, 'utf8').digest() };
}

/**
 * A live link token for `email`, as POST /auth/forgot-password ('reset') or
 * sign-up / resend-verification ('verify') would have mailed it.
 */
export async function plantEmailToken(email: string, purpose: 'reset' | 'verify'): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query(
			`INSERT INTO email_token (user_id, purpose, token_hash, expires_at)
			 SELECT id, $3::email_token_purpose, $2, now() + interval '1 hour' FROM app_user WHERE email = $1`,
			[email, hash, purpose]
		);
		if (r.rowCount !== 1) throw new Error(`no user ${email}`);
	});
	return token;
}

/** An account's id by its address (a sign-up answers without one until the address is confirmed, issue #57). */
export async function userIdByEmail(email: string): Promise<string> {
	return withDb(async (db) => {
		const r = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [email]);
		if (!r.rows[0]) throw new Error(`no user ${email}`);
		return r.rows[0].id;
	});
}

/** The id of the account with `email` if its address is confirmed, else null (no account, or unconfirmed). */
export async function verifiedUserIdByEmail(email: string): Promise<string | null> {
	return withDb(async (db) => {
		const r = await db.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1 AND email_verified_at IS NOT NULL', [email.trim().toLowerCase()]);
		return r.rows[0]?.id ?? null;
	});
}

/** The terms an account accepted at sign-up (app_user.terms_version / terms_accepted_at, 087). */
export async function termsAccepted(email: string): Promise<{ version: string | null; at: Date | null }> {
	return withDb(async (db) => {
		const r = await db.query<{ version: string | null; at: Date | null }>('SELECT terms_version AS version, terms_accepted_at AS at FROM app_user WHERE email = $1', [email]);
		if (!r.rows[0]) throw new Error(`no user ${email}`);
		return r.rows[0];
	});
}

/**
 * Record that these accounts accepted terms `version` (app_user.terms_version;
 * the database stamps the time). The seeded demo accounts accepted nothing,
 * so they would meet the re-acceptance notice (docs/legal-status.md) on every
 * page; an older version sets one up for it.
 */
export async function setTermsVersion(emails: string[], version: string): Promise<void> {
	await withDb(async (db) => {
		await db.query('UPDATE app_user SET terms_version = $2 WHERE email = ANY($1) AND terms_version IS DISTINCT FROM $2', [emails, version]);
	});
}

/** Re-key the pending invite(s) for `email` so the test knows the link token. */
export async function plantInviteToken(email: string): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query('UPDATE invite SET token_hash = $2 WHERE email = $1', [email, hash]);
		if (r.rowCount !== 1) throw new Error(`expected one invite for ${email}, got ${r.rowCount}`);
	});
	return token;
}

/**
 * An alert subscription for `email` whose one-click unsubscribe token the test
 * knows (WP-2.13). The worker would derive the token as
 * HMAC(ALERTS_TOKEN_SECRET, nonce); the API only ever looks it up by its
 * SHA-256, so any 43-character token planted with its hash behaves the same.
 */
export async function plantAlertSubscription(email: string, projectId: string, kind: string, nodeId: string | null = null): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query(
			`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce, unsubscribe_hash)
			 SELECT id, $2, $3, $4, 'immediate', $5, $6 FROM app_user WHERE email = $1`,
			[email, projectId, kind, nodeId, randomBytes(32), hash]
		);
		if (r.rowCount !== 1) throw new Error(`no user ${email}`);
	});
	return token;
}

/**
 * An alert email's "Was this useful?" row for `email` whose token the test
 * knows (151_alert_feedback). The worker would derive the token as
 * HMAC(ALERTS_TOKEN_SECRET, "wm-alert-feedback/v1/" + nonce); the API only
 * ever looks it up by its SHA-256, so any planted token behaves the same.
 */
export async function plantAlertFeedback(email: string, projectId: string, kind: string): Promise<string> {
	const { token, hash } = newToken();
	await withDb(async (db) => {
		const r = await db.query(
			`INSERT INTO alert_feedback (project_id, user_id, kind, nonce, token_hash)
			 SELECT $2, id, $3, $4, $5 FROM app_user WHERE email = $1`,
			[email, projectId, kind, randomBytes(32), hash]
		);
		if (r.rowCount !== 1) throw new Error(`no user ${email}`);
	});
	return token;
}

/**
 * Turn a run into a stored run of the legacy runoff model, as a run made
 * before engine 1.0.0 removed that model (issue #16) sits in the database:
 * its settings snapshot says 'legacy' (what every reader keys on), it has no
 * runoff store balance, its low-flow curves name the legacy model, and its
 * engine version predates 1.0.0. The API can no longer make such a run, so
 * the specs that cover "old legacy runs open read-only, badged" plant one.
 * The run's other numbers stay its GR4J ones: nothing reads them as legacy.
 */
export async function plantLegacyRun(runId: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(
			`UPDATE model_run SET
				engine_version = '0.45.0',
				inputs = jsonb_set(inputs, '{settings,runoffModel}', '"legacy"'),
				summary = CASE
					WHEN jsonb_typeof(summary #> '{plausibility,lowFlow}') = 'object'
						THEN jsonb_set(summary - 'runoff', '{plausibility,lowFlow,runoffModel}', '"legacy"')
					ELSE summary - 'runoff'
				END
			 WHERE id = $1`,
			[runId]
		);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
	});
}

/**
 * A run as engine 1.54.0 stored it, before the validation signatures (CR-16,
 * engine 1.55.0): the summary loses `plausibility.signatures`. The API only
 * makes current runs, so the compare spec that shows how an older run reads
 * plants one. Its run stamp no longer matches (it reads as unverified).
 */
export async function plantPreSignaturesRun(runId: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(`UPDATE model_run SET engine_version = '1.54.0', summary = summary #- '{plausibility,signatures}' WHERE id = $1`, [runId]);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
	});
}

/**
 * A sign-off as it was recorded under statement signoff-2, before the
 * registration category and field were (092_signoff_registration): a
 * free-text body and NULL category and field. The route only makes current
 * sign-offs, so the spec that shows how an older one prints plants one.
 */
export async function plantSignoff2(runId: string, fullName: string, registrationBody: string, registrationNo: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(
			`INSERT INTO signoff (project_id, run_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version, signed_at)
			 SELECT project_id, id, $2, $3, $4, 'an earlier review', 'signoff-2', repeat('e', 64), '2026-09-28', now() - interval '1 day'
			 FROM model_run WHERE id = $1`,
			[runId, fullName, registrationBody, registrationNo]
		);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
	});
}

/**
 * Make a project's forecast series look written by a CHIRPS-GEFS feed, every
 * day of it, as the feed's ingest leaves it (time_series.feed_id + feed_days,
 * 031_feed_days): a disabled feed with no acting user, which no worker tick
 * (data-feeds.spec.ts) ever finds due, owns the series' days. A forecast run
 * then records CHIRPS-GEFS as its rain source. The real ingest path is
 * covered by backend/src/feeds/forecast.db.test.ts.
 */
export async function plantGefsForecastDays(projectId: string): Promise<void> {
	await withDb(async (db) => {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, enabled)
			 SELECT $1, 'chirps_gefs', '{"cells":[{"lat":-20.1,"lon":25.1}]}'::jsonb, 'rain_forecast_mm', name, false
			 FROM time_series WHERE project_id = $1 AND kind = 'rain_forecast_mm' RETURNING id`,
			[projectId]
		);
		if (rows.length !== 1) throw new Error(`project ${projectId}: no single forecast series`);
		await db.query(
			`UPDATE time_series SET feed_id = $2, feed_days = datemultirange(daterange(start_date, start_date + cardinality("values")))
			 WHERE project_id = $1 AND kind = 'rain_forecast_mm'`,
			[projectId, rows[0]!.id]
		);
	});
}

/**
 * Move an application's submission `days` back (and its decision, if it has
 * one, to the day after), as one submitted that long ago sits in the
 * database. The scenario trigger stamps both with now() and never lets them
 * change, so the update runs with triggers off for this one transaction
 * (`session_replication_role`, this connection only). For the Applications
 * list's "waiting N days".
 */
export async function backdateApplication(scenarioId: string, days: number): Promise<void> {
	await withDb(async (db) => {
		await db.query('BEGIN');
		try {
			await db.query('SET LOCAL session_replication_role = replica');
			const r = await db.query(
				`UPDATE scenario SET
					submitted_at = submitted_at - make_interval(days => $2),
					decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE submitted_at - make_interval(days => $2) + interval '1 day' END
				 WHERE id = $1 AND submitted_at IS NOT NULL`,
				[scenarioId, days]
			);
			if (r.rowCount !== 1) throw new Error(`no submitted application ${scenarioId}`);
			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}
	});
}

/**
 * Change a stored run's summary behind the API's back, as someone with SQL
 * could: its server stamp (077_run_stamp, docs/security.md § Run stamps) no
 * longer matches, so the run reads as unverified.
 */
export async function tamperRunSummary(runId: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(`UPDATE model_run SET summary = summary || '{"tampered": true}' WHERE id = $1`, [runId]);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
	});
}

/**
 * Spread a project's history over earlier days, `perDay` change sets a day
 * (newest today), as a project edited over weeks has it. The history tables
 * are append-only (030_history), so the update runs with triggers off for
 * this one transaction; the project's `history_since` moves back with it.
 * For the History page's day groups at size.
 */
export async function spreadHistoryOverDays(projectId: string, perDay: number): Promise<void> {
	await withDb(async (db) => {
		await db.query('BEGIN');
		try {
			await db.query('SET LOCAL session_replication_role = replica');
			await db.query(
				`CREATE TEMP TABLE history_shift ON COMMIT DROP AS
				 SELECT t, id, ((dense_rank() OVER (ORDER BY created_at DESC) - 1) / $2)::int AS d
				   FROM (SELECT 'r' AS t, id, created_at FROM model_revision WHERE project_id = $1
				         UNION ALL SELECT 'e', id, created_at FROM audit_event WHERE project_id = $1) x`,
				[projectId, perDay]
			);
			await db.query(`UPDATE model_revision m SET created_at = m.created_at - make_interval(days => s.d) FROM history_shift s WHERE s.t = 'r' AND s.id = m.id`);
			await db.query(`UPDATE audit_event a SET created_at = a.created_at - make_interval(days => s.d) FROM history_shift s WHERE s.t = 'e' AND s.id = a.id`);
			await db.query(
				`UPDATE project SET history_since = history_since - make_interval(days => (SELECT coalesce(max(d), 0) FROM history_shift) + 1) WHERE id = $1`,
				[projectId]
			);
			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}
	});
}

/**
 * Keep a queued report PDF queued: its job waits a day, so a worker tick that
 * another spec runs meanwhile (support/jobs.ts runs every due job) doesn't
 * render it. For the emailed-link page's "Queued" state.
 */
export async function holdReportJob(jobId: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(`UPDATE job SET run_after = now() + interval '1 day' WHERE id = $1 AND kind = 'report_render' AND status = 'queued'`, [jobId]);
		if (r.rowCount !== 1) throw new Error(`no queued report job ${jobId}`);
	});
}

/**
 * Settle a report PDF as failed, as the worker leaves one whose last try gave
 * up (its job dead, the report failed with a reason). The API can't be asked
 * for a failure, and a real one needs a broken renderer.
 */
export async function failReport(jobId: string, error: string): Promise<void> {
	await withDb(async (db) => {
		const j = await db.query(`UPDATE job SET status = 'dead', finished_at = now() WHERE id = $1 AND kind = 'report_render'`, [jobId]);
		if (j.rowCount !== 1) throw new Error(`no report job ${jobId}`);
		const r = await db.query(`UPDATE report SET status = 'failed', error = $2, finished_at = now() WHERE job_id = $1`, [jobId, error]);
		if (r.rowCount !== 1) throw new Error(`no report for job ${jobId}`);
	});
}

/**
 * Hold a yield job as running at `progress` %, as a worker mid-calculation
 * leaves it: claimed with an hour's lease, so another spec's worker tick
 * won't take it. The API can't pause a job halfway, and a real one here
 * finishes in well under a second.
 */
export async function holdYieldJobRunning(jobId: string, progress: number): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(
			`UPDATE job SET status = 'running', attempts = 1, started_at = now(), locked_until = now() + interval '1 hour',
				lease_token = gen_random_uuid()
			 WHERE id = $1 AND kind = 'yield' AND status = 'queued'`,
			[jobId]
		);
		if (r.rowCount !== 1) throw new Error(`no queued yield job ${jobId}`);
		// A second statement: a claim (a new lease_token) resets progress (040_yield job_progress_reset).
		await db.query(`UPDATE job SET progress = $2 WHERE id = $1`, [jobId, progress]);
	});
}

/** Hand a held yield job back to the queue, as an expired lease does, for a worker tick to finish. */
export async function releaseYieldJob(jobId: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query(
			`UPDATE job SET status = 'queued', attempts = 0, started_at = NULL, locked_until = NULL, lease_token = NULL, progress = NULL, run_after = now()
			 WHERE id = $1 AND kind = 'yield' AND status = 'running'`,
			[jobId]
		);
		if (r.rowCount !== 1) throw new Error(`no running yield job ${jobId}`);
	});
}

/**
 * A firing alert on a project (a data_stale rule and its open event), as the
 * alert evaluator would leave it (WP-2.13): the project list's Alerts column
 * and Needs attention count firing events, and a spec can't wait for the
 * worker to fire one.
 */
export async function plantFiringAlert(projectId: string): Promise<void> {
	await withDb(async (db) => {
		const { rows } = await db.query<{ id: string }>(
			`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'data_stale', 7) RETURNING id`,
			[projectId]
		);
		await db.query(`INSERT INTO alert_event (rule_id, project_id, kind, state, value) VALUES ($1, $2, 'data_stale', 'firing', 30)`, [rows[0]!.id, projectId]);
	});
}

/**
 * Make a run the project's newest forecast run, continuing from recorded rain
 * to `lastObserved`, and open its EWR forecast alert (a rule and a firing
 * event), as the alert evaluator leaves it (WP-2.13). A `lastObserved` before
 * the project's last recorded rain day makes it a forecast behind the rain
 * (alerts/evaluate.ts newestForecast), which Active alerts marks out of date.
 * Called again, it only moves `lastObserved`. The evaluator's own decisions
 * are covered by backend/src/alerts/alerts.db.test.ts.
 */
export async function plantEwrForecastAlert(projectId: string, runId: string, lastObserved: string): Promise<void> {
	await withDb(async (db) => {
		const forecast = { from: '2026-09-25', to: '2026-10-10', days: 16, outletEwrDaysAtRisk: 5, lastObserved, perFarm: [] };
		const r = await db.query(`UPDATE model_run SET trigger = 'forecast', summary = jsonb_set(summary, '{forecast}', $2::jsonb) WHERE id = $1`, [runId, JSON.stringify(forecast)]);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
		const { rows } = await db.query<{ id: string }>(`SELECT id FROM alert_rule WHERE project_id = $1 AND kind = 'ewr_forecast_fail'`, [projectId]);
		if (rows.length) return;
		const { rows: rule } = await db.query<{ id: string }>(`INSERT INTO alert_rule (project_id, kind, threshold, enabled) VALUES ($1, 'ewr_forecast_fail', 3, true) RETURNING id`, [projectId]);
		await db.query(
			`INSERT INTO alert_event (rule_id, project_id, kind, state, value, detail, run_id) VALUES ($1, $2, 'ewr_forecast_fail', 'firing', 5, $3, $4)`,
			[rule[0]!.id, projectId, JSON.stringify({ days: 5, of: 16, from: forecast.from, to: forecast.to, madeOn: '2026-09-24' }), runId]
		);
	});
}

/**
 * Make a run look as if an older engine made it (issue #103, the known-defect
 * flag): only its recorded engine_version changes, so the API flags the errata
 * of that version (docs/engine-errata.md).
 */
export async function plantRunEngine(runId: string, engineVersion: string): Promise<void> {
	await withDb(async (db) => {
		const r = await db.query('UPDATE model_run SET engine_version = $2 WHERE id = $1', [runId, engineVersion]);
		if (r.rowCount !== 1) throw new Error(`no run ${runId}`);
	});
}
