// A cap or full-allocation run's per-unit results, as a viewer kept from each
// registered volume reads them (decision D3; issue #523 security review,
// finding I and finding 7; docs/security.md § Allocations).
//
// In such a run a unit's results are worked out from its registered volume:
// a cap's room on a licence's first day is the volume, and its use in a year
// the cap binds adds up to it; a full allocation scales the unit's demand to
// it, so its demand (and with it supply and deficit) adds up to it every
// water year. So for that viewer every unit that holds an allocation in a cap
// or full-allocation run is a "bound unit": its daily series and its entries
// in the run's summary are withheld, with a marker saying which. A
// compare-only run (the baseline since #507) binds nothing: its results don't
// depend on the volumes. Pure: the routes decide who is kept from the volumes
// (allocationUnitsHidden).
import { ALLOCATION_SERIES } from '@water-management/engine';

/** The series a run stores from the registered volumes on any unit (engine ≥ 1.18.0): a cap's room and what is left, a full allocation's factor. */
export const ALLOCATION_SERIES_KEYS: ReadonlySet<string> = new Set(Object.values(ALLOCATION_SERIES).map((s) => s.key));

type AllocationsLike = { mode?: unknown; nodes?: readonly { nodeId: string }[] | null; withheldUnits?: readonly string[] } | null | undefined;

/** The units a run's allocation mode bound to their registered volumes: every unit with an allocation in a cap or full-allocation run, none otherwise. */
export function boundUnits(allocations: AllocationsLike): Set<string> {
	if (!allocations || (allocations.mode !== 'cap' && allocations.mode !== 'fullAllocation')) return new Set();
	// Already redacted (the per-unit part emptied, the units named): the marker is the list.
	return new Set([...(allocations.nodes ?? []).map((n) => n.nodeId), ...(allocations.withheldUnits ?? [])]);
}

/** Whether a viewer kept from the volumes is denied a run's series: an allocation series anywhere, or any series of a bound unit. */
export const seriesWithheld = (units: ReadonlySet<string>, nodeId: string | null, key: string): boolean =>
	ALLOCATION_SERIES_KEYS.has(key) || (nodeId !== null && units.has(nodeId));

/**
 * `v` without any bound unit's entry anywhere: an array element that is an
 * object whose nodeId is one, and an object's entry keyed by one (a record
 * by node id, such as an ensemble member's per-unit demand). Node ids are
 * UUIDs, so no other key is taken for one.
 */
export function withoutUnits(v: unknown, units: ReadonlySet<string>): unknown {
	if (!units.size) return v;
	if (Array.isArray(v))
		return v.filter((x) => !(x && typeof x === 'object' && typeof (x as { nodeId?: unknown }).nodeId === 'string' && units.has((x as { nodeId: string }).nodeId))).map((x) => withoutUnits(x, units));
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (units.has(k) ? [] : [[k, withoutUnits(x, units)]])));
	return v;
}

// A cap run's warnings about a licence's maximum rate quote the registered volume (allocations/mode.ts rateShortfall).
const RATE_ZERO = /^allocation cap: allocation (\S+)'s maximum rate is 0, so it may take none of its .*$/;
const RATE_SHORT = /^allocation cap: at its maximum rate allocation (\S+) can take at most .* in (its months of use|a year), less than its .*$/;
/** A figure in m³ (with its separators), for any other allocation warning that quotes one. */
const VOLUME = /\d[\d\s,.  ]*\s?m³/g;

/** A cap or full-allocation run's warning as that viewer reads it: no registered volume quoted. */
export function warningWithoutVolume(w: string): string {
	if (RATE_ZERO.test(w)) return w.replace(RATE_ZERO, "allocation cap: allocation $1's maximum rate is 0, so it may take none of its registered volume (a blank rate states none)");
	if (RATE_SHORT.test(w)) return w.replace(RATE_SHORT, 'allocation cap: at its maximum rate allocation $1 cannot take its registered volume in $2');
	return /^(allocation|full allocation)/.test(w) ? w.replace(VOLUME, 'a withheld volume') : w;
}

/**
 * A run summary as a viewer kept from each registered volume reads it: in a
 * cap or full-allocation run, no bound unit's entry anywhere (its farm or
 * water user summary, groundwater years, curtailment, reliability, stress
 * grid …: any element with its nodeId), no volume in the allocation
 * warnings, and `allocations.withheldUnits` naming the units left out (the
 * marker the pages show). Catchment figures stay. A compare-only run comes
 * back as it is. Idempotent.
 */
export function withoutBoundUnits<S>(summary: S): S {
	const s = summary as { allocations?: AllocationsLike; warnings?: unknown } | null | undefined;
	const units = boundUnits(s?.allocations);
	if (!s || !units.size) return summary;
	const out = withoutUnits(s, units) as { allocations: Record<string, unknown>; warnings?: unknown };
	out.allocations = { ...out.allocations, withheldUnits: [...units].sort() };
	if (Array.isArray(out.warnings)) out.warnings = out.warnings.map((w) => (typeof w === 'string' ? warningWithoutVolume(w) : w));
	return out as S;
}
