// allocationMode (engine ≥ 1.18.0, roadmap WP-3.10, issue #72, docs/model.md
// §2.12a): registered volumes as a physical limit on a run, not only as a
// comparison beside it.
//
//  - 'none' (the default): the allocations change nothing; a run that has
//    them only reports RunSummary.allocations (compareAllocations).
//  - 'cap': each farm's and water user's use per water year stays within
//    what is registered for it, per water source: surface use (supplied −
//    groundwater to the crop: the dam, the river pump, river off-take water
//    used) within the surface volume, groundwater use (pumped to the crop +
//    into the dam) within the groundwater volume. The budget is the whole
//    water year's registered volume (each allocation × its valid days in
//    the year ÷ the year's days), so a run that starts or ends inside a year
//    doesn't shrink it, and a farm may take its volume early. A source with
//    no allocation isn't capped (a run warning names them).
//    Every draw from the dam counts as surface use, groundwater pumped into
//    it included, so that water uses up both volumes; the comparison nets it
//    (docs/model.md §2.12). Pending the hydrologist (followups.md §
//    Allocations, issue #90).
//  - 'fullAllocation': "what if every lawful user took their entitlement"
//    (WP-3.11's background run): each unit's abstraction demand (crops and
//    demand objects) is scaled, per water year, so it adds up to the
//    registered volume in force over the run's days of that year (both
//    sources together), keeping the unit's own seasonal pattern. A unit with
//    no demand in a year can't be scaled and takes nothing that year (a
//    warning names it).
//
// Licence conditions (months, the most it may take at once) are recorded on
// an allocation but not enforced by either mode yet (docs/allocations.md).
//
// Pure, like the rest of the engine.
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import type { AllocationEntry, AllocationWaterSource } from './compare';
import { cmpStr } from '../order';

export const ALLOCATION_MODES = ['none', 'cap', 'fullAllocation'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

/** Each mode in plain words (the Settings form, run results). */
export const ALLOCATION_MODE_LABEL: Record<AllocationMode, string> = {
	none: 'Compare only',
	cap: 'Cap use at the registered volume',
	fullAllocation: 'Full allocation: every user takes their registered volume'
};

/** The mode a run uses: settings.allocationMode when it is one, else 'none'. */
export function resolveAllocationMode(v: unknown, warnings: string[]): AllocationMode {
	if (v === undefined || v === null) return 'none';
	if ((ALLOCATION_MODES as readonly unknown[]).includes(v)) return v as AllocationMode;
	warnings.push(`allocationMode "${String(v)}" is not one of ${ALLOCATION_MODES.join(', ')}; the allocations only compare`);
	return 'none';
}

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromEpochDay(toEpochDay(v)) === v;

/**
 * The allocations a run can use, each checked: a finite volume ≥ 0, a known
 * water source, and dates that are ISO days in order. Anything else is left
 * out with a warning (the API stores only valid rows; this guards a stored
 * input edited by hand).
 */
export function usableAllocations(list: readonly AllocationEntry[] | undefined, warnings: string[]): AllocationEntry[] {
	const out: AllocationEntry[] = [];
	for (const a of list ?? []) {
		const bad =
			!(typeof a.volumeM3PerYear === 'number' && Number.isFinite(a.volumeM3PerYear) && a.volumeM3PerYear >= 0)
				? 'its volume is not a number ≥ 0'
				: a.waterSource !== 'surface' && a.waterSource !== 'groundwater'
					? `its water source "${String(a.waterSource)}" is not surface or groundwater`
					: (a.validFrom != null && !isIso(a.validFrom)) || (a.validTo != null && !isIso(a.validTo))
						? 'a validity date is not an ISO date'
						: a.validFrom && a.validTo && a.validFrom > a.validTo
							? 'it is valid from after valid to'
							: null;
		if (bad) warnings.push(`allocation ${String(a.id)} left out: ${bad}`);
		else out.push(a);
	}
	return out;
}

/** First epoch day of water year `wy` (1 October). */
const wyStart = (wy: number) => toEpochDay(`${wy}-10-01`);

/** Registered m³ of `allocs` over epoch days [from, to] of water year `wy`: each volume × its valid days there ÷ the year's days. */
export function registeredOver(allocs: readonly AllocationEntry[], wy: number, from: number, to: number): number {
	const yearDays = wyStart(wy + 1) - wyStart(wy);
	let sum = 0;
	for (const a of allocs) {
		const lo = Math.max(from, a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
		const hi = Math.min(to, a.validTo ? toEpochDay(a.validTo) : Infinity);
		if (hi >= lo) sum += (a.volumeM3PerYear * (hi - lo + 1)) / yearDays;
	}
	return sum;
}

/**
 * The cap's budget for each run day (`cap` mode): the registered volume of
 * `source` over the whole water year the day falls in (not only the run's
 * days of it), the same number on every day of a year. null when the node
 * has no allocation of that source (no cap).
 */
export function yearBudgets(allocs: readonly AllocationEntry[], source: AllocationWaterSource, start: number, days: number): Float64Array | null {
	const own = allocs.filter((a) => a.waterSource === source);
	if (!own.length) return null;
	const out = new Float64Array(days);
	for (let t = 0; t < days; ) {
		const wy = waterYearOf(start + t);
		const end = wyStart(wy + 1) - 1;
		const v = registeredOver(own, wy, wyStart(wy), end);
		const last = Math.min(days - 1, end - start);
		for (let k = t; k <= last; k++) out[k] = v;
		t = last + 1;
	}
	return out;
}

/**
 * `fullAllocation`: the factor each run day's demand is scaled by, one per
 * water year: the registered volume (both sources) in force over the run's
 * days of the year ÷ the unit's abstraction demand over them (`demand`,
 * m³/day). A year with demand but nothing registered gets 0; a year with
 * registered volume but no demand can't be scaled, gets 0 and is listed in
 * `unscaled` (water years).
 */
export function fullAllocationFactors(
	allocs: readonly AllocationEntry[],
	demand: ArrayLike<number>,
	start: number,
	days: number,
	/** A resumed run (../warmstart): the factor its first water year keeps from the run it was captured from. */
	pinnedFirst?: number
): { factor: Float64Array; years: { waterYear: number; demandM3: number; registeredM3: number }[]; unscaled: number[] } {
	const factor = new Float64Array(days);
	const years: { waterYear: number; demandM3: number; registeredM3: number }[] = [];
	const unscaled: number[] = [];
	for (let t = 0; t < days; ) {
		const wy = waterYearOf(start + t);
		const last = Math.min(days - 1, wyStart(wy + 1) - 1 - start);
		let d = 0;
		for (let k = t; k <= last; k++) d += demand[k]!;
		const pinned = t === 0 && pinnedFirst !== undefined;
		const reg = registeredOver(allocs, wy, start + t, start + last);
		const f = pinned ? pinnedFirst : d > 0 ? reg / d : 0;
		if (!pinned && !(d > 0) && reg > 0) unscaled.push(wy);
		for (let k = t; k <= last; k++) factor[k] = f;
		// A pinned year was scaled to the capture run's volume for the whole of it: record what its days got.
		years.push({ waterYear: wy, demandM3: d, registeredM3: pinned ? f * d : reg });
		t = last + 1;
	}
	return { factor, years, unscaled };
}

/** What a plan node needs for the modes (../network/simulate.ts PlanNode). */
interface ModePlanNode {
	demand: Float64Array;
	irrigationEfficiency: number;
	objects?: { demand: Float64Array[]; total: Float64Array };
	borehole?: unknown;
	allocationCap?: { surface: Float64Array | null; groundwater: Float64Array | null };
}

/** The allocations as a run plans them (buildNetworkPlan). */
export interface AllocationPlan {
	mode: AllocationMode;
	/** The usable allocations, in id order. */
	list: AllocationEntry[];
	/** Node index → its allocations (farms and water users only). */
	byNode: Map<number, AllocationEntry[]>;
	/** 'fullAllocation': node index → its demand's factor per day, and per water year the demand before and the volume after. */
	scaled: Map<number, { factor: Float64Array; years: { waterYear: number; demandM3: number; registeredM3: number }[] }>;
	/**
	 * 'fullAllocation' in a run resumed from a snapshot (../warmstart): node
	 * index → the factor of the water year in progress in the run it was
	 * captured from, kept for the resumed days of that year so they are the
	 * uninterrupted run's (the year's demand before the snapshot isn't in the
	 * resumed run).
	 */
	pinned?: Map<number, number>;
}

/** The usable allocations matched to the run's farms and water users (node index → its allocations). */
export function matchAllocations(
	allocations: readonly AllocationEntry[] | undefined,
	mode: AllocationMode,
	nodes: readonly { id: string; kind: string }[],
	warnings: string[]
): AllocationPlan {
	// In id order, so a unit's registered volume sums the same to the last bit however the list came.
	const list = usableAllocations(allocations, warnings).sort((a, b) => cmpStr(String(a.id), String(b.id)));
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const byNode = new Map<number, AllocationEntry[]>();
	for (const a of list) {
		const i = a.nodeId === null || a.nodeId === undefined ? undefined : index.get(a.nodeId);
		if (i === undefined || (nodes[i]!.kind !== 'farm' && nodes[i]!.kind !== 'user')) continue;
		const own = byNode.get(i) ?? [];
		own.push(a);
		byNode.set(i, own);
	}
	return { mode, list, byNode, scaled: new Map() };
}

/**
 * 'fullAllocation': scale node `i`'s abstraction demand `D` (m³/day) in
 * place to its registered volume, year by year, and record it in
 * `plan.scaled`. A water user's demand is scaled this way before its senior
 * claim is passed down (buildNetworkPlan), so the farms upstream pass the
 * scaled demand.
 */
export function scaleDemandToAllocation(plan: AllocationPlan, i: number, D: Float64Array, start: number, days: number, name: string, warnings: string[]): Float64Array | null {
	const allocs = plan.byNode.get(i);
	if (plan.mode !== 'fullAllocation' || !allocs || days <= 0) return null;
	const f = fullAllocationFactors(allocs, D, start, days, plan.pinned?.get(i));
	for (let t = 0; t < days; t++) D[t]! *= f.factor[t]!;
	plan.scaled.set(i, { factor: f.factor, years: f.years });
	if (f.unscaled.length) warnings.push(`full allocation: "${name}" has no demand in water year${f.unscaled.length === 1 ? '' : 's'} ${f.unscaled.join(', ')}, so it takes none of its registered volume there`);
	return f.factor;
}

/**
 * Put the allocation mode into a built plan (engine ≥ 1.18.0): for 'cap'
 * each unit's per-source budgets (PlanNode.allocationCap); for
 * 'fullAllocation' each farm's demand scaled (the crop requirement and the
 * demand objects alike, so D = F / e + objects scales with them; water users
 * were scaled before their claims, scaleDemandToAllocation). Warns about
 * units the mode leaves alone.
 */
export function planAllocations(
	ap: AllocationPlan,
	nodes: readonly { id: string; name: string; kind: string }[],
	plan: ModePlanNode[],
	start: number,
	days: number,
	warnings: string[]
): void {
	const { mode, byNode } = ap;
	if (mode === 'none' || days <= 0) return;
	const without = nodes.flatMap((n, i) => ((n.kind === 'farm' || n.kind === 'user') && !byNode.has(i) ? [n.name] : []));
	if (without.length)
		warnings.push(
			`allocation mode ${mode}: ${without.length} unit${without.length === 1 ? ' has' : 's have'} no registered volume, so ${mode === 'cap' ? 'nothing caps their use' : 'their demand is left as modelled'} (${without.join('; ')})`
		);
	for (const [i, allocs] of byNode) {
		const p = plan[i]!;
		if (mode === 'cap') {
			const surface = yearBudgets(allocs, 'surface', start, days);
			const groundwater = yearBudgets(allocs, 'groundwater', start, days);
			p.allocationCap = { surface, groundwater };
			if (!surface) warnings.push(`allocation cap: "${nodes[i]!.name}" has no surface-water volume registered, so its surface use isn't capped`);
			if (!groundwater && p.borehole) warnings.push(`allocation cap: "${nodes[i]!.name}" has no groundwater volume registered, so its boreholes aren't capped`);
			continue;
		}
		if (nodes[i]!.kind !== 'farm') continue;
		const e = p.irrigationEfficiency;
		const D = new Float64Array(days);
		for (let t = 0; t < days; t++) D[t] = p.demand[t]! / e + (p.objects ? p.objects.total[t]! : 0);
		const factor = scaleDemandToAllocation(ap, i, D, start, days, nodes[i]!.name, warnings)!;
		p.demand = Float64Array.from(p.demand, (v, t) => v * factor[t]!);
		if (p.objects) {
			const demand = p.objects.demand.map((d) => Float64Array.from(d, (v, t) => v * factor[t]!));
			const total = new Float64Array(days);
			for (const d of demand) for (let t = 0; t < days; t++) total[t]! += d[t]!;
			p.objects = { ...p.objects, demand, total };
		}
	}
}

/** The run series the modes add (engine ≥ 1.18.0), per farm or water user they touch. */
export const ALLOCATION_SERIES = {
	surfaceRoom: { key: 'allocation_room_surface', label: 'Allocation cap: surface water it may still take this water year (start of day)' },
	groundwaterRoom: { key: 'allocation_room_groundwater', label: 'Allocation cap: groundwater it may still take this water year (start of day)' },
	demandFactor: { key: 'allocation_demand_factor', label: 'Full allocation: demand × this factor (the water year’s registered volume ÷ its demand)' }
} as const;
