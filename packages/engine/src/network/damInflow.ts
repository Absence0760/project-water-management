// What can bring water into a unit's dam (docs/model.md §2.13): its share of
// its own runoff, its share of the flow from the units upstream, River to dam
// (a diversion), and transfers or off-takes that deliver to it. A dam with
// none of them catches nothing (rain on its own surface aside), so its yield
// is 0 whatever its size; the Yield panel and the API say so instead of
// working out a 0 (engine ≥ 1.117.0, the hydrologist's report 2026-11-09).
//
// Pure, and reads only the model: no run.
import type { ModelInput } from '../project';
import { transferDestinations } from './transferSplits';

export interface DamInflowRoutes {
	/** Share of the unit's own runoff routed into its dam, 0–1 (pctRunoffToDam). */
	runoffToDam: number;
	/** Share of the flow from upstream routed into its dam, 0–1 (pctUpstreamToDam). */
	upstreamToDam: number;
	/** How many units drain straight into this one: an upstream share with none brings nothing. */
	upstreamUnits: number;
	/** River to dam: a diversion capacity above 0 (all year, or in some month). */
	riverToDam: boolean;
	/** Transfer and off-take rules that deliver to this unit. */
	transfersIn: number;
	/** Any of the above brings water into the dam. */
	receives: boolean;
}

export function damInflowRoutes(input: Pick<ModelInput, 'model'>, nodeId: string): DamInflowRoutes {
	const n = input.model.nodes.find((x) => x.id === nodeId);
	if (!n) throw new Error(`hydrological unit ${nodeId} not found`);
	const runoffToDam = n.pctRunoffToDam > 0 ? n.pctRunoffToDam : 0;
	const upstreamToDam = n.pctUpstreamToDam > 0 ? n.pctUpstreamToDam : 0;
	const upstreamUnits = input.model.nodes.filter((x) => x.downstreamNodeId === nodeId).length;
	const monthly = n.divertMonthlyM3Day;
	const riverToDam = Array.isArray(monthly) && monthly.length ? monthly.some((v) => v > 0) : n.divertCapacityM3Day > 0;
	const transfersIn = input.model.transfers.filter((t) => transferDestinations(t).some((d) => d.nodeId === nodeId)).length;
	return {
		runoffToDam,
		upstreamToDam,
		upstreamUnits,
		riverToDam,
		transfersIn,
		receives: runoffToDam > 0 || (upstreamToDam > 0 && upstreamUnits > 0) || riverToDam || transfersIn > 0
	};
}
