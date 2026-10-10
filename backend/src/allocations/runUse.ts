// A stored run's modelled use per farm and water user, as compareAllocations
// reads it (WP-3.10, docs/allocations.md): the run's daily `supplied`,
// `groundwater_used`, `groundwater_to_dam` and `river_abstraction` series, the
// river water it took (`offtake_used`, `river_take@…`) and its diverted river
// water the dam lost (`diverted_loss`, engine ≥ 1.79.0),
// record days only (a forecast run's forecast days are left out, issue #51).
// The Allocations tab compares it with the project's allocations now; the
// evidence report with the run's own (runAllocationComparison).
import {
	beforeForecast,
	compareAllocations,
	DEFAULT_ALLOCATION_TOLERANCE,
	usableAllocations,
	type AllocationComparison,
	type AllocationEntry,
	type AllocationUseNode,
	type RunInputsSnapshot
} from '@water-management/engine';
import type { Db } from '../db/tx.js';

export interface RunUseNode {
	id: string;
	name: string;
	kind: string;
	damCapacityM3?: number;
}

/** The run's farms and water users with a `supplied` series, each with its use series. */
export async function runUseNodes(db: Db, runId: string, startDate: string, forecastFrom: string | null, nodes: readonly RunUseNode[] | null): Promise<AllocationUseNode[]> {
	const users = (nodes ?? []).filter((n) => n.kind === 'farm' || n.kind === 'user');
	const { rows: series } = await db.query<{ nodeId: string; key: string; values: (number | null)[] }>(
		`SELECT node_id AS "nodeId", key, "values" FROM run_series
		 WHERE run_id = $1 AND (key IN ('supplied', 'groundwater_used', 'groundwater_to_dam', 'river_abstraction', 'offtake_used', 'diverted_loss') OR key LIKE 'river\\_take@%') AND node_id = ANY($2::uuid[])`,
		[runId, users.map((n) => n.id)]
	);
	const get = (nodeId: string, key: string) => {
		const values = series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
		return values && Array.from(beforeForecast(values, startDate, forecastFrom));
	};
	return users
		.filter((n) => get(n.id, 'supplied'))
		.map((n) => ({
			nodeId: n.id,
			name: n.name,
			kind: n.kind as 'farm' | 'user',
			supplied: get(n.id, 'supplied')!,
			groundwater: get(n.id, 'groundwater_used') ?? null,
			groundwaterToDam: get(n.id, 'groundwater_to_dam') ?? null,
			riverAbstraction: get(n.id, 'river_abstraction') ?? null,
			// The rest of the river water in supplied (engine ≥ 1.69.0): never netted as a dam draw (§2.12).
			riverTakes: series.filter((s) => s.nodeId === n.id && (s.key === 'offtake_used' || s.key.startsWith('river_take@'))).map((s) => get(n.id, s.key) ?? null),
			// Diverted river water the dam lost to evaporation and seepage (engine ≥ 1.79.0): surface use (§2.12); absent before.
			divertedLoss: get(n.id, 'diverted_loss') ?? null,
			damCapacityM3: n.damCapacityM3 ?? null
		}));
}

/**
 * A stored run against the allocations it ran with (its stored
 * inputs.model.allocations, which never carry a holder's name) and its own
 * band (inputs.settings.allocationTolerance, as the run's summary used it),
 * so the evidence report's § 5 is reproducible from the run alone, whatever
 * the project's allocations are now. Null when the run carries none (a
 * project without allocations, or a run from before engine 1.18.0).
 */
export async function runAllocationComparison(
	db: Db,
	run: { id: string; startDate: string; forecastFrom: string | null; inputs: Pick<RunInputsSnapshot, 'settings' | 'model'> }
): Promise<AllocationComparison | null> {
	const model = run.inputs.model as { nodes?: RunUseNode[]; allocations?: AllocationEntry[] } | undefined;
	const allocations = usableAllocations(model?.allocations, []);
	if (!allocations.length) return null;
	const t = (run.inputs.settings as { allocationTolerance?: unknown } | undefined)?.allocationTolerance;
	const tolerance = typeof t === 'number' && t >= 0 && t < 1 ? t : DEFAULT_ALLOCATION_TOLERANCE;
	const nodes = await runUseNodes(db, run.id, run.startDate, run.forecastFrom, model?.nodes ?? null);
	return compareAllocations({ startDate: run.startDate, nodes, tolerance, allocations });
}
