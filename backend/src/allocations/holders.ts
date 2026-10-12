// Who holds each of a run's registered volumes, as a salted key frozen when
// the run was stored (219, issue #523 G/N/P, decision D3; docs/allocations.md
// § Who sees what): what the evidence report's § 5 (per-year totals of other
// units) and the authorised mix count holders by. Read through
// app_run_allocation_holders, a SECURITY DEFINER lookup any member from
// viewer up may call for the rows of one run, so a report is the same
// whoever builds it; the keys never leave the server.
import type { Db } from '../db/tx.js';

/** The key every row of a run without a living holder shares (a row a scenario op added, or one gone before 219): at most one holder. */
export const GONE = 'gone';

/**
 * The holder key of each of `rows` (a run's allocations, by id), as frozen
 * with run `runId` (run_allocation_holder); a row with none shares GONE.
 */
export async function allocationHolderKeys(db: Db, projectId: string, runId: string, rows: readonly { id: string }[]): Promise<Record<string, string>> {
	if (!rows.length) return {};
	const { rows: keys } = await db.query<{ id: string; holder: string }>(
		'SELECT allocation_id AS id, holder FROM app_run_allocation_holders($1, $2, $3::text[])',
		[projectId, runId, rows.map((r) => r.id)]
	);
	const byId = new Map(keys.map((k) => [k.id, k.holder]));
	return Object.fromEntries(rows.map((r) => [r.id, byId.get(r.id) ?? GONE]));
}
