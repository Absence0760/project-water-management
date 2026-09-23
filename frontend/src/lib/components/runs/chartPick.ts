// Choosing which run output series to plot.
import type { RunSeriesRef } from '$lib/api/types';

export const CATCHMENT = '__catchment';
export const COMPARE = '__compare';
/** Catchment series overlaid by default, when present. */
export const COMPARE_KEYS = ['natural_flow', 'simulated_outflow', 'observed_flow'];

export function seriesForNode(refs: RunSeriesRef[], node: string): RunSeriesRef[] {
	return refs.filter((r) => (node === CATCHMENT ? r.nodeId === null : r.nodeId === node));
}

/**
 * Catchment comparison set: the COMPARE_KEYS present in the run that share
 * the unit of the first one found (one y-axis only).
 */
export function comparisonRefs(refs: RunSeriesRef[]): RunSeriesRef[] {
	const found = COMPARE_KEYS.map((k) => refs.find((r) => r.nodeId === null && r.key === k)).filter(
		(r): r is RunSeriesRef => !!r
	);
	const unit = found[0]?.unit;
	return found.filter((r) => r.unit === unit);
}
