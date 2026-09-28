// Pure helpers for the run results dashboard: the farm table's sorting and
// flags, grouping of output series for the pickers, and unit conversion.
import type { FarmSummary } from '@water-management/engine';
import type { RunSeriesRef } from '$lib/api/types';

export const SUPPLY_TARGET = 0.95;
export const SEC_PER_DAY = 86_400;
/** m³/day → Mm³ per year (365.25-day year). */
export const m3DayToMm3a = (v: number) => (v * 365.25) / 1e6;
export const m3DayToM3s = (v: number) => v / SEC_PER_DAY;

/** Width of a supply bar, 0–1: the fraction supplied, clamped (non-finite → 0). */
export const supplyBarFraction = (f: number) => (Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0);

export type FarmSortKey =
	| 'network'
	| 'name'
	| 'avgDemandM3Day'
	| 'avgSuppliedM3Day'
	| 'avgDeficitM3Day'
	| 'fractionSupplied'
	| 'avgEwrShortfallM3Day'
	| 'daysEwrNotMet';

/**
 * Farms in the requested order. 'network' = the project's node order
 * (`order`: nodeId → position; farms missing from it keep the run's order,
 * after the known ones).
 */
export function sortFarms(
	farms: readonly FarmSummary[],
	key: FarmSortKey,
	dir: 'asc' | 'desc',
	order: ReadonlyMap<string, number> = new Map()
): FarmSummary[] {
	const indexed = farms.map((f, i) => ({ f, i }));
	const sign = dir === 'asc' ? 1 : -1;
	indexed.sort((a, b) => {
		if (key === 'network') {
			const oa = order.get(a.f.nodeId) ?? Number.MAX_SAFE_INTEGER;
			const ob = order.get(b.f.nodeId) ?? Number.MAX_SAFE_INTEGER;
			return oa - ob || a.i - b.i;
		}
		if (key === 'name') return sign * a.f.name.localeCompare(b.f.name) || a.i - b.i;
		return sign * ((a.f[key] as number) - (b.f[key] as number)) || a.i - b.i;
	});
	return indexed.map((x) => x.f);
}

export interface SeriesGroup {
	nodeId: string | null;
	label: string;
	options: RunSeriesRef[];
}

/** Output series grouped for a picker: catchment first, then nodes in network order. */
export function seriesGroups(
	refs: readonly RunSeriesRef[],
	order: ReadonlyMap<string, number>,
	names: ReadonlyMap<string, string>
): SeriesGroup[] {
	const groups = new Map<string | null, RunSeriesRef[]>();
	for (const r of refs) {
		if (!groups.has(r.nodeId)) groups.set(r.nodeId, []);
		groups.get(r.nodeId)!.push(r);
	}
	const out: SeriesGroup[] = [];
	if (groups.has(null)) out.push({ nodeId: null, label: 'Catchment (outflow gauge)', options: groups.get(null)! });
	const nodeIds = [...groups.keys()].filter((k): k is string => k !== null);
	nodeIds.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || (names.get(a) ?? '').localeCompare(names.get(b) ?? ''));
	for (const id of nodeIds) out.push({ nodeId: id, label: names.get(id) ?? 'Unknown node', options: groups.get(id)! });
	return out;
}

/** Convert m³/day values to m³/s (other units unchanged); NaN/null stay missing. */
export function toDisplayUnit(values: readonly (number | null)[], unit: string, flowUnit: 'm³/s' | 'm³/day') {
	if (unit !== 'm³/day' || flowUnit === 'm³/day') {
		return { unit, values: values.map((v) => (v == null || !Number.isFinite(v) ? null : v)) };
	}
	return { unit: 'm³/s', values: values.map((v) => (v == null || !Number.isFinite(v) ? null : v / SEC_PER_DAY)) };
}

/**
 * Each node's dam capacity (m³) as the shown run had it: from the run's own
 * model snapshot, so a dam resized since the run doesn't rescale the run's
 * storage (halving a dam charted an old run at 200 %). A run from an API
 * without the snapshot falls back to the live model.
 */
export function runDamCapacity(
	runModel: { nodes?: readonly { id: string; damCapacityM3?: unknown }[] } | undefined,
	liveNodes: readonly { id: string; damCapacityM3: number }[]
): Map<string, number> {
	const snap = runModel?.nodes;
	if (snap?.length) return new Map(snap.map((n) => [n.id, typeof n.damCapacityM3 === 'number' ? n.damCapacityM3 : 0]));
	return new Map(liveNodes.map((n) => [n.id, n.damCapacityM3]));
}

/** Dam storage (m³) as % of capacity; null when there is no dam. */
export function storagePct(values: readonly (number | null)[], capacityM3: number): (number | null)[] | null {
	if (!(capacityM3 >= 1)) return null;
	return values.map((v) => (v == null || !Number.isFinite(v) ? null : (v / capacityM3) * 100));
}
