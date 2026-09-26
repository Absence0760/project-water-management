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
}

/**
 * Every series the recompute reads (the engine's curtailmentSeriesKeys): the
 * flows the binding site is recomputed from, the farm and other-user series
 * and the EWR sites'. null when the run predates the EWR charge (engine
 * 0.17.0), which a window can't be recomputed without.
 */
export function curtailmentSeriesKeys(stored: CurtailmentSummary, network: RunNetwork): SeriesKey[] | null {
	if (!stored.ewrAttribution || !stored.ewrSites) return null;
	return engineSeriesKeys(network.nodes, network.transfers);
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
	return prepareCurtailment({ startDate: run.startDate, endDate: run.endDate, nodes: network.nodes, transfers: network.transfers, series: get });
}
