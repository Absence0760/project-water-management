// Run stamps (077_run_stamp.sql; docs/security.md § Run stamps).
//
// RLS lets an applicant insert their own application's run rows (045) and an
// editor any run of their project (001), so a row alone doesn't say the
// engine produced it: someone with SQL as water_app could store a summary or
// series the engine never computed. The backend signs every run it stores
// (storeRun): an HMAC-SHA256 over app_run_digest(run), the database's
// canonical digest of the run's evidence (inputs snapshot, summary, stored
// input series, output series), under a key the database never holds. A
// sign-off and an application's decision refuse a run whose stamp is missing
// or wrong; the run responses say `verified`.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

/**
 * The stamp key: its own key, derived from the session secret by HKDF with
 * its own label, so a stamp is never a valid session or device MAC and there
 * is no new secret to provision. Rotating AUTH_JWT_SECRET leaves every stored
 * run unverified (docs/security.md § Run stamps).
 */
function key(): Buffer {
	const s = process.env.AUTH_JWT_SECRET ?? '';
	if (s.length < 32) throw new Error('AUTH_JWT_SECRET must be set (≥ 32 characters)');
	return Buffer.from(hkdfSync('sha256', s, Buffer.alloc(0), 'wm-run-stamp:v1', 32));
}

/** The stamp of a run whose app_run_digest is `digest`. */
export const runStamp = (digest: Buffer): Buffer => createHmac('sha256', key()).update(digest).digest();

/** True when `stamp` is the stamp of `digest` (either missing: false). */
export function stampMatches(digest: Buffer | null, stamp: Buffer | null): boolean {
	if (!digest || !stamp) return false;
	const want = runStamp(digest);
	return stamp.length === want.length && timingSafeEqual(stamp, want);
}

/**
 * Stamp a run just stored, in the storing transaction, after its last row
 * (storeRun). Throws if the database gives no digest or won't take the stamp:
 * a run is never stored unsigned by the backend.
 */
export async function stampRun(db: Db, runId: string): Promise<void> {
	const { rows } = await db.query<{ digest: Buffer | null }>('SELECT app_run_digest($1) AS digest', [runId]);
	const digest = rows[0]?.digest;
	if (!digest) throw new Error(`run ${runId}: no digest to stamp`);
	const { rows: set } = await db.query<{ ok: boolean }>('SELECT app_set_run_stamp($1, $2) AS ok', [runId, runStamp(digest)]);
	if (!set[0]?.ok) throw new Error(`run ${runId}: the stamp was not stored`);
}

/**
 * Which of `runIds` verify: their stamp matches their digest as the rows
 * stand now. A run the caller can't read (no digest), an unstamped one (from
 * before 077, or written past the API) and a tampered one are all false.
 */
export async function verifiedRuns(db: Db, runIds: readonly string[]): Promise<Map<string, boolean>> {
	const out = new Map(runIds.map((id) => [id, false] as [string, boolean]));
	if (!runIds.length) return out;
	const { rows } = await db.query<{ id: string; stamp: Buffer | null; digest: Buffer | null }>(
		'SELECT r.id, r.stamp, app_run_digest(r.id) AS digest FROM model_run r WHERE r.id = ANY($1::uuid[])',
		[[...new Set(runIds)]]
	);
	for (const r of rows) out.set(r.id, stampMatches(r.digest, r.stamp));
	return out;
}

/** Whether one run verifies (verifiedRuns). */
export const runVerified = async (db: Db, runId: string): Promise<boolean> => (await verifiedRuns(db, [runId])).get(runId) ?? false;

/** Why an unverified run is refused where it is judged (sign-off, an application's decision). */
export const RUN_UNVERIFIED =
	'this run was not stored by the model run itself (its server stamp is missing or no longer matches its results), so it cannot be signed off or decided on; delete it and run it again';

export const runUnverified = (message = RUN_UNVERIFIED) => ApiError.coded(409, 'run_unverified', message);

/**
 * The runs of scenario `scenarioId` that don't verify, oldest first: what an
 * application's decision refuses while any remain, and what the assessors
 * are shown (`unverifiedRunIds`). Under the caller's RLS: runs they can't
 * read aren't listed (an applicant reads none).
 */
export async function unverifiedScenarioRuns(db: Db, projectId: string, scenarioId: string): Promise<string[]> {
	const { rows } = await db.query<{ id: string; stamp: Buffer | null; digest: Buffer | null }>(
		`SELECT r.id, r.stamp, app_run_digest(r.id) AS digest FROM model_run r
		 WHERE r.project_id = $1 AND r.scenario_id = $2 ORDER BY r.created_at, r.id`,
		[projectId, scenarioId]
	);
	return rows.filter((r) => !stampMatches(r.digest, r.stamp)).map((r) => r.id);
}
