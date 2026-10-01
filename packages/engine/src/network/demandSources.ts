// How solid a set of demand objects' demand is, by rule (engine ≥ 1.56.0,
// issue #54 Q11, docs/model.md §2.7f): each source's share of their mean
// demand, best source first (meter records, a strategy's AADD, a per-capita
// norm, other), then what isn't recorded. The run's demand-objects table and
// the evidence report's § 6 (evidence-9) both read it, so the two say the
// same thing. Pure.
import { DEMAND_OBJECT_SOURCES, type DemandObjectSource } from '../project';

export interface DemandSourceShare {
	/** null = not recorded. */
	source: DemandObjectSource | null;
	/** Mean demand from it, m³/day. */
	demandM3Day: number;
	/** Of the objects' whole demand, 0–1 (0 when they have none). */
	share: number;
	objects: number;
}

/** Every source the objects have, in the rule's order, not recorded last. */
export function demandSourceShares(objects: readonly { source?: DemandObjectSource | null; avgDemandM3Day: number }[]): DemandSourceShare[] {
	const total = objects.reduce((s, o) => s + o.avgDemandM3Day, 0);
	return [...DEMAND_OBJECT_SOURCES, null].flatMap((source) => {
		const mine = objects.filter((o) => (o.source ?? null) === source);
		if (!mine.length) return [];
		const demandM3Day = mine.reduce((s, o) => s + o.avgDemandM3Day, 0);
		return [{ source, demandM3Day, share: total > 0 ? demandM3Day / total : 0, objects: mine.length }];
	});
}

/**
 * A run's shares for its results table: none when no object records a
 * source (a run before engine 1.56.0 never does, so it says nothing rather
 * than "100 % not recorded").
 */
export function demandBySource(objects: readonly { source?: DemandObjectSource | null; avgDemandM3Day: number }[]): DemandSourceShare[] {
	return objects.some((o) => o.source !== undefined && o.source !== null) ? demandSourceShares(objects) : [];
}
