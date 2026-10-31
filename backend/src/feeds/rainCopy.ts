// Our CHIRPS copy's state for the data feeds panel (issue #604 Round 2,
// docs/architecture.md § Our copy of the rain data): the three products' last
// days as the worker's mirror tick last recorded them (mirror_copy, 246;
// jobs/handlers/mirror-tick.ts), judged by health.ts rainCopyStatus. The API
// never reaches the copy itself: only the worker reads its manifests.
// Null when this process reads CHC itself (CHIRPS_SOURCE=chc): then nothing
// changes.
//
// The rows are per cache origin (cellCacheStore.ts cacheOrigin): `chc` for a
// real copy, `fixtures` for the committed sample copy (backend/fixtures/mirror/,
// the default off a live process). The sample is fixed at the day it was
// made, SAMPLE_COPY_MADE: its lags count to that day, so dev and e2e show it
// on time, as the re-dated file fixtures show their feeds healthy, and the
// panel says it is the sample copy.
//
// No row at all for the origin: the worker hasn't ticked against the copy
// yet (a fresh database, a dev server without the worker). That is
// `readable: false`, "not checked yet", which marks no feed Copy behind; a
// product missing beside others the tick has seen is behind (rainCopyStatus).
import type { Db } from '../db/tx.js';
import { chirpsSource } from '../mirror/source.js';
import { cacheOrigin } from './cellCacheStore.js';
import { utcToday } from './fetch.js';
import { copyFinalLagDays, type RainCopy, rainCopyStatus } from './health.js';
import { mirrorCopy } from './mirrorRevision.js';

type Env = Record<string, string | undefined>;

/** The day the committed sample copy was made (backend/scripts/gen-mirror-fixture.ts MIRROR_FIXTURE.today; rainCopy.db.test.ts checks they agree). */
export const SAMPLE_COPY_MADE = '2026-02-09';

/** Our CHIRPS copy's state as of `now`, read in `db` (any signed-in session), or null when this process reads CHC itself. */
export async function rainCopy(db: Db, env: Env = process.env, now = new Date()): Promise<RainCopy | null> {
	if (chirpsSource(env) !== 'mirror') return null;
	const origin = cacheOrigin();
	const rows = await mirrorCopy(db, origin);
	if (!rows.sat && !rows.rnl && !rows.prelim) return { readable: false };
	const days = {
		sat: rows.sat ? { finalThrough: rows.sat.finalThrough } : null,
		rnl: rows.rnl ? { finalThrough: rows.rnl.finalThrough } : null,
		prelim: rows.prelim ? { prelimThrough: rows.prelim.prelimThrough } : null
	};
	const sample = origin === 'fixtures';
	// How late the finals may be: the lag alarm's threshold in production (COPY_FINAL_LAG_DAYS, infra/lambda.tf), else 75.
	return rainCopyStatus(days, sample ? SAMPLE_COPY_MADE : utcToday(now), sample, copyFinalLagDays(env));
}
