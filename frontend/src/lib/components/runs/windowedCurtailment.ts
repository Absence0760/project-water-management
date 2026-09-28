// The curtailment table (farms, other water users, EWR sites) over a window
// the reader picks (issue #44), worked out in the browser from the run's
// stored daily series by the engine's prepareCurtailment
// (views/farmProjection.ts, the same recompute as the farmer projection's
// season), the EWR site that set each farm's charge included. Nothing is
// re-run and nothing is saved: the project setting and the stored summary
// stay as they are. Pure; the component fetches the series (reportWindow.ts
// resolves the window). The engine's curtailmentOverWindow.test.ts checks the
// table against runModel's own; windowedCurtailment.test.ts checks the wiring.
import {
	curtailmentSeriesKeys as engineSeriesKeys,
	prepareCurtailment,
	type CropArea,
	type DemandObject,
	type CropDef,
	type CurtailmentSummary,
	type NetworkNode,
	type PreparedCurtailment,
	type Transfer
} from '@water-management/engine';

/** One stored run series, as `GET …/runs/:runId/series` names it. */
export interface SeriesKey {
	nodeId: string | null;
	key: string;
}

/** Stored daily values (run_series.values: a non-finite day is null). */
export type Stored = ArrayLike<number | null>;

/** The network the run used: its model snapshot (model_run.inputs.model), or today's model on an older API. */
export interface RunNetwork {
	nodes: readonly NetworkNode[];
	transfers: readonly Transfer[];
	/**
	 * The snapshot's crops and crop areas and the run's monthly A-pan: a farm
	 * whose crops carry their own irrigation efficiency (engine ≥ 0.43.0) is
	 * curtailed on the combined one runModel used. Absent = each farm's own.
	 */
	crops?: readonly CropDef[];
	cropAreas?: readonly CropArea[];
	apanMm?: readonly number[];
	/** The snapshot's demand objects (engine ≥ 1.7.0): a unit with one is curtailed on the consumptive share its return flow gives. */
	demandObjects?: readonly DemandObject[];
}

/**
 * Every series the recompute reads (the engine's curtailmentSeriesKeys): the
 * farm and other-user series, the EWR sites', and each farm's stored binding
 * site (engine ≥ 1.5.0) or, for a run saved before it (`refs` lack them), the
 * flows the binding site is recomputed from. null when the run predates the
 * EWR charge (engine 0.17.0), which a window can't be recomputed without.
 */
export function curtailmentSeriesKeys(stored: CurtailmentSummary, network: RunNetwork, refs?: readonly SeriesKey[]): SeriesKey[] | null {
	if (!stored.ewrAttribution || !stored.ewrSites) return null;
	// Sites whose charge followed their Reserve rule table (engine ≥ 1.3.0) have their own shortfall series.
	const ruleTableSites = stored.ewrSites.filter((s) => s.ewrSource === 'ruleTable').map((s) => (s.isOutlet ? null : s.nodeId));
	const have = refs ? new Set(refs.map((r) => `${r.nodeId ?? ''}|${r.key}`)) : null;
	const options = { ...(ruleTableSites.length ? { ruleTableSites } : {}), ...(network.demandObjects?.length ? { demandObjects: network.demandObjects } : {}) };
	return engineSeriesKeys(network.nodes, network.transfers, options, have ? (nodeId, key) => have.has(`${nodeId ?? ''}|${key}`) : undefined);
}

/** The keys the run has no stored series for (a run saved before one of them existed). */
export function missingSeries(keys: SeriesKey[], refs: readonly SeriesKey[]): SeriesKey[] {
	const have = new Set(refs.map((r) => `${r.nodeId ?? ''}|${r.key}`));
	return keys.filter((k) => !have.has(`${k.nodeId ?? ''}|${k.key}`));
}

/**
 * The run, read once, whose table `.over(window)` works out for any window.
 * `get` returns a stored series (every key curtailmentSeriesKeys lists must
 * be there). Throws the engine's ProjectionInputError when a series doesn't
 * cover the run.
 */
export function prepareWindowed(run: { startDate: string; endDate: string }, network: RunNetwork, get: (nodeId: string | null, key: string) => Stored | undefined): PreparedCurtailment {
	return prepareCurtailment({
		startDate: run.startDate,
		endDate: run.endDate,
		nodes: network.nodes,
		transfers: network.transfers,
		...(network.crops && network.cropAreas ? { crops: network.crops, cropAreas: network.cropAreas, apanMm: network.apanMm ?? [] } : {}),
		...(network.demandObjects?.length ? { demandObjects: network.demandObjects } : {}),
		series: get
	});
}
