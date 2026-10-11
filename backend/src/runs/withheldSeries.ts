// A run's daily series as a viewer kept from each registered volume reads
// them (decision D3; issue #523 security review, finding I): no allocation
// series (a cap's room and what is left, a full allocation's factor), and in
// a cap or full-allocation run none of a bound unit's series
// (allocations/boundUnits.ts). Every route that serves a run's daily figures
// asks here: the series, its bulk pages, the day trace, the daily and
// all-farms CSVs. A series asked for by name is refused with
// `allocation_series_withheld` (403); a list says which it left out.
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Role } from '../projects/access.js';
import { allocationUnitsHidden } from '../allocations/viewerUnits.js';
import { boundUnits, seriesWithheld } from '../allocations/boundUnits.js';

/** What a caller is kept from of one run's series: null when they read each volume. */
export interface SeriesWithholding {
	/** The run's bound units: every series of theirs is withheld. */
	units: ReadonlySet<string>;
	/** Whether this series (a node's, or the catchment's for null) is withheld. */
	withheld: (nodeId: string | null, key: string) => boolean;
}

export async function seriesWithholding(db: Db, projectId: string, role: Role, runId: string): Promise<SeriesWithholding | null> {
	if (!(await allocationUnitsHidden(db, projectId, role))) return null;
	const { rows } = await db.query<{ allocations: Parameters<typeof boundUnits>[0] }>(
		`SELECT summary->'allocations' AS allocations FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	const units = boundUnits(rows[0]?.allocations);
	return { units, withheld: (nodeId, key) => seriesWithheld(units, nodeId, key) };
}

/** 403 for a series, or a whole node's, that the caller is kept from. */
export const allocationSeriesWithheld = (what: string) =>
	ApiError.coded(
		403,
		'allocation_series_withheld',
		`${what} is worked out from a registered water volume, which this project shows to its editors and owners only`
	);

/**
 * `items` without the ones withheld, and the keys left out (empty when
 * nothing is). Refuses the lot when every one is withheld, so a bound unit's
 * file or day isn't served empty.
 */
export function keepVisible<T extends { key: string }>(w: SeriesWithholding | null, nodeId: string | null, items: readonly T[], what: string): { kept: T[]; withheld: string[] } {
	if (!w) return { kept: [...items], withheld: [] };
	const kept = items.filter((s) => !w.withheld(nodeId, s.key));
	const withheld = items.filter((s) => w.withheld(nodeId, s.key)).map((s) => s.key);
	if (items.length && !kept.length) throw allocationSeriesWithheld(what);
	return { kept, withheld };
}
