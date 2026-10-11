// A run's daily series as a viewer kept from each registered volume reads
// them (decision D3; issue #523 security review, finding I): no allocation
// series on any run (a cap's room and what is left, a full allocation's
// factor), and of a cap or full-allocation run only its river series
// (allocations/riverOutcomes.ts: an allowlist of the catchment's and the
// gauges' series, nothing of any unit). Every route that serves a run's daily
// figures asks here: the run's series list, the series, its bulk pages, the
// day trace, the daily and all-farms CSVs, the compare route's catchment
// list. A series asked for by name is refused with `allocation_series_withheld`
// (403); a list says which it left out.
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Role } from '../projects/access.js';
import { allocationUnitsHidden } from '../allocations/viewerUnits.js';
import { ALLOCATION_SERIES_KEYS, riverOutcomesOnly, riverSeries } from '../allocations/riverOutcomes.js';

/** What a caller is kept from of one run's series: null when they read each volume. */
export interface SeriesWithholding {
	/** The run caps or fully allocates: only its river series are read. */
	riverOnly: boolean;
	/** Whether this series (a node's, or the catchment's for null) is withheld. */
	withheld: (nodeId: string | null, key: string) => boolean;
}

/** The withholding for a run whose mode (summary.allocations) and gauges are known. */
export function withholdingFor(allocations: { mode?: unknown } | null | undefined, gauges: ReadonlySet<string>): SeriesWithholding {
	const riverOnly = riverOutcomesOnly(allocations);
	return {
		riverOnly,
		withheld: (nodeId, key) => ALLOCATION_SERIES_KEYS.has(key) || (riverOnly && !riverSeries(gauges, nodeId, key))
	};
}

export async function seriesWithholding(db: Db, projectId: string, role: Role, runId: string): Promise<SeriesWithholding | null> {
	if (!(await allocationUnitsHidden(db, projectId, role))) return null;
	// The run's gauges as it ran (its model snapshot): the only nodes whose series a cap or full-allocation run gives.
	const { rows } = await db.query<{ allocations: { mode?: unknown } | null; gauges: string[] | null }>(
		`SELECT r.summary->'allocations' AS allocations,
			(SELECT array_agg(n->>'id') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.inputs->'model'->'nodes') = 'array' THEN r.inputs->'model'->'nodes' ELSE '[]'::jsonb END) n
			 WHERE n->>'kind' = 'gauge') AS gauges
		 FROM model_run r WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId]
	);
	return withholdingFor(rows[0]?.allocations, new Set(rows[0]?.gauges ?? []));
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
 * nothing is). Refuses the lot when every one is withheld, so a unit's file
 * or day isn't served empty.
 */
export function keepVisible<T extends { key: string }>(w: SeriesWithholding | null, nodeId: string | null, items: readonly T[], what: string): { kept: T[]; withheld: string[] } {
	if (!w) return { kept: [...items], withheld: [] };
	const kept = items.filter((s) => !w.withheld(nodeId, s.key));
	const withheld = items.filter((s) => w.withheld(nodeId, s.key)).map((s) => s.key);
	if (items.length && !kept.length) throw allocationSeriesWithheld(what);
	return { kept, withheld };
}
