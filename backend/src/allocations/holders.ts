// Who holds each registered volume, as an opaque key (215, issue #523 G,
// decision D3; docs/allocations.md § Who sees what): what the evidence
// report's § 5 (per-year totals of other units) and the authorised mix count
// holders by. Read through app_allocation_holders, a SECURITY DEFINER lookup
// any member from viewer up may call, so a report is the same whoever builds
// it; the keys never leave the server.
import type { Db } from '../db/tx.js';

/**
 * The holder key of each of `rows` (a run's allocations, by id): the
 * project's row's holder (`h<ordinal>`, counted as 162 counts holders); for a
 * row gone since the run, a living row's on the same unit (fewer holders
 * counted, never more), else the unit (`n:<id>`), else the row.
 */
export async function allocationHolderKeys(db: Db, projectId: string, rows: readonly { id: string; nodeId?: string | null }[]): Promise<Record<string, string>> {
	if (!rows.length) return {};
	const { rows: live } = await db.query<{ id: string; nodeId: string | null; holder: number }>(
		'SELECT id::text, node_id::text AS "nodeId", holder FROM app_allocation_holders($1)',
		[projectId]
	);
	const byId = new Map(live.map((r) => [r.id, `h${r.holder}`]));
	const byNode = new Map<string, string>();
	for (const r of [...live].sort((a, b) => a.holder - b.holder)) if (r.nodeId && !byNode.has(r.nodeId)) byNode.set(r.nodeId, `h${r.holder}`);
	return Object.fromEntries(rows.map((r) => [r.id, byId.get(r.id) ?? (r.nodeId ? (byNode.get(r.nodeId) ?? `n:${r.nodeId}`) : `a:${r.id}`)]));
}
