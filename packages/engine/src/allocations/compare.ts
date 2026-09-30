// Registered water-use volumes against modelled use, per farm or water user
// and per water year (roadmap WP-3.10 first slice; docs/model.md §2.12,
// docs/allocations.md).
//
// Pure and I/O-free like the rest of the engine: the backend feeds it a
// stored run's daily `supplied`, `groundwater_used`, `groundwater_to_dam` and
// `river_abstraction` series and the project's allocations, and the result is shown next to the run. It does not
// change a run and is not part of runModel, so ENGINE_VERSION doesn't move.
//
// The comparison is arithmetic, not a finding. "Over" means the model's
// abstraction in that water year is more than the registered volume plus the
// tolerance; it says nothing about whether a use is lawful (the model's
// supply is modelled, not metered, and the registered volume may be
// incomplete). The wording on every screen follows that.

import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';

export type AllocationWaterSource = 'surface' | 'groundwater';

/** One registered volume, as the comparison needs it. */
export interface AllocationEntry {
	id: string;
	/** The farm or water user; null = not matched to a node yet. */
	nodeId: string | null;
	waterSource: AllocationWaterSource;
	volumeM3PerYear: number;
	/** Registered storage (s21b), m³. */
	storageM3?: number | null;
	/** First day it applies (ISO date, inclusive); null/absent = open. */
	validFrom?: string | null;
	/** Last day it applies (ISO date, inclusive); null/absent = open. */
	validTo?: string | null;
	/**
	 * Licence conditions (engine ≥ 1.18.0, issue #72): the calendar months
	 * (1–12) the use may happen in, and the most it may take at once (m³/s).
	 * allocationMode `cap` applies them from engine 1.34.0 (./mode.ts
	 * dailyLimits); the comparison doesn't. null/absent = none stated.
	 */
	months?: readonly number[] | null;
	maxRateM3s?: number | null;
}

/** A node's modelled use from a run. */
export interface AllocationUseNode {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Daily water supplied (m³/day), groundwater included: the run's `supplied` series. */
	supplied: ArrayLike<number | null>;
	/** Daily groundwater pumped (m³/day, part of supplied): the run's `groundwater_used` series; absent without boreholes. */
	groundwater?: ArrayLike<number | null> | null;
	/**
	 * Daily groundwater pumped into the farm dam (m³/day; WP-3.9, engine ≥
	 * 0.36.0): the run's `groundwater_to_dam` series; absent without dam-target
	 * boreholes. Not part of supplied. It counts as groundwater use when pumped,
	 * so the groundwater side per water year equals RunSummary.groundwaterAnnualUse's
	 * abstraction (to the crop + into the dam). Drawing it back out of the dam is
	 * not a second (surface) take: the surface side nets it out, at most the
	 * water year's dam draw (docs/model.md §2.12).
	 */
	groundwaterToDam?: ArrayLike<number | null> | null;
	/**
	 * Daily water pumped from the river below the dam (m³/day, part of supplied;
	 * WP-3.8): the run's `river_abstraction` series; absent without a river
	 * pump. Only used to tell the dam draw (supplied − groundwater − river) apart.
	 */
	riverAbstraction?: ArrayLike<number | null> | null;
	/** The dam capacity the run modelled (m³), for the storage comparison. */
	damCapacityM3?: number | null;
}

export interface AllocationComparisonInput {
	/** The run's first day (ISO). Every series starts on it. */
	startDate: string;
	nodes: readonly AllocationUseNode[];
	allocations: readonly AllocationEntry[];
	/** Relative band around the registered volume counted as "within" (default 0.1 = ±10 %). */
	tolerance?: number;
}

/**
 * - over: modelled use > registered × (1 + tolerance);
 * - under: modelled use < registered × (1 − tolerance);
 * - within: between the two;
 * - unregistered: modelled use with no registered volume in force;
 * - none: neither.
 */
export type AllocationStatus = 'over' | 'within' | 'under' | 'unregistered' | 'none';

export interface AllocationYear {
	/** Water year (Oct–Sep), labelled by the year it starts in. */
	waterYear: number;
	/** Days of this water year inside the run. */
	days: number;
	/** Days in the whole water year (365 or 366). */
	yearDays: number;
	/** The run covers only part of the water year; the registered volume is prorated to the days covered. */
	partial: boolean;
	/** Modelled abstraction over the days covered, m³. */
	modelledM3: number;
	/** Registered volume in force over the days covered, m³ (prorated by day for partial years and validity dates). */
	registeredM3: number;
	/** modelled / registered; null when nothing is registered. */
	ratio: number | null;
	status: AllocationStatus;
}

export interface AllocationSourceComparison {
	waterSource: AllocationWaterSource;
	/** The allocations counted, in input order. */
	allocationIds: string[];
	years: AllocationYear[];
	/** Whole water years over (partial years are listed but not counted here). */
	yearsOver: number;
	/** Whole water years judged (not partial). */
	wholeYears: number;
	/** Mean modelled use per whole water year, m³; null without a whole year. */
	meanModelledM3PerYear: number | null;
	/** Mean registered volume per whole water year, m³; null without a whole year. */
	meanRegisteredM3PerYear: number | null;
}

export interface AllocationNodeComparison {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	surface: AllocationSourceComparison;
	groundwater: AllocationSourceComparison;
	/** Registered storage (Σ storageM3 of this node's allocations; null when none states one) against the modelled dam capacity. */
	storage: { registeredM3: number | null; modelledCapacityM3: number | null };
}

export interface AllocationComparison {
	tolerance: number;
	startDate: string;
	endDate: string;
	/** Every farm and water user of the run, in input order. */
	nodes: AllocationNodeComparison[];
	/** Allocations with no node yet. */
	unmatchedAllocationIds: string[];
	/** Allocations matched to a node this run doesn't have (deleted since, or added after the run). */
	notInRunAllocationIds: string[];
}

export const DEFAULT_ALLOCATION_TOLERANCE = 0.1;

/** Below this many m³ a year's use or volume counts as nothing (float dust). */
const NOTHING_M3 = 1e-6;

const finite = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The status of one year's modelled use against its registered volume. */
export function allocationStatus(modelledM3: number, registeredM3: number, tolerance = DEFAULT_ALLOCATION_TOLERANCE): AllocationStatus {
	if (registeredM3 <= NOTHING_M3) return modelledM3 > NOTHING_M3 ? 'unregistered' : 'none';
	if (modelledM3 > registeredM3 * (1 + tolerance)) return 'over';
	if (modelledM3 < registeredM3 * (1 - tolerance)) return 'under';
	return 'within';
}

/** First epoch day of a water year (1 October). */
const waterYearStart = (wy: number) => toEpochDay(`${wy}-10-01`);

/**
 * Compare each farm's and water user's modelled abstraction per water year
 * with the volumes registered for it, for surface water and groundwater
 * separately. Per water year y (docs/model.md §2.12):
 *
 *   groundwater(y) = Σ groundwater_used + Σ groundwater_to_dam
 *   surface(y)     = Σ (supplied − groundwater_used) − MIN(Σ groundwater_to_dam, Σ dam draw)
 *   dam draw       = MAX(supplied − groundwater_used − river_abstraction, 0), per day
 *
 * Groundwater pumped into the dam is counted once, as groundwater, when it is
 * pumped; the dam draw attributes to it first, up to what was pumped in that
 * water year, so re-drawing it is not a second, surface take.
 */
export function compareAllocations(input: AllocationComparisonInput): AllocationComparison {
	const tolerance = input.tolerance ?? DEFAULT_ALLOCATION_TOLERANCE;
	if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError(`allocation tolerance must be in [0, 1), got ${tolerance}`);
	const start = toEpochDay(input.startDate);
	const days = input.nodes.reduce((n, x) => Math.max(n, x.supplied.length), 0);
	const end = start + Math.max(days, 1) - 1;

	// The run's water years and the part of each it covers.
	const spans: { waterYear: number; from: number; to: number; yearDays: number }[] = [];
	for (let d = start; d <= start + days - 1; ) {
		const wy = waterYearOf(d);
		const yearEnd = waterYearStart(wy + 1) - 1;
		const to = Math.min(yearEnd, start + days - 1);
		spans.push({ waterYear: wy, from: d, to, yearDays: yearEnd - waterYearStart(wy) + 1 });
		d = to + 1;
	}

	const inRun = new Set(input.nodes.map((n) => n.nodeId));
	const byNode = new Map<string, AllocationEntry[]>();
	const unmatchedAllocationIds: string[] = [];
	const notInRunAllocationIds: string[] = [];
	for (const a of input.allocations) {
		if (!(a.volumeM3PerYear >= 0) || !Number.isFinite(a.volumeM3PerYear)) throw new RangeError(`allocation ${a.id}: volume must be a finite number ≥ 0`);
		if (a.nodeId === null) unmatchedAllocationIds.push(a.id);
		else if (!inRun.has(a.nodeId)) notInRunAllocationIds.push(a.id);
		else {
			const list = byNode.get(a.nodeId) ?? [];
			list.push(a);
			byNode.set(a.nodeId, list);
		}
	}

	/** Registered m³ of `allocs` over [from, to]: each volume × its valid days there ÷ the year's days. */
	const registered = (allocs: readonly AllocationEntry[], from: number, to: number, yearDays: number) => {
		let sum = 0;
		for (const a of allocs) {
			const lo = Math.max(from, a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
			const hi = Math.min(to, a.validTo ? toEpochDay(a.validTo) : Infinity);
			if (hi >= lo) sum += (a.volumeM3PerYear * (hi - lo + 1)) / yearDays;
		}
		return sum;
	};

	const nodes = input.nodes.map((n): AllocationNodeComparison => {
		const allocs = byNode.get(n.nodeId) ?? [];
		const gw = n.groundwater ?? null;
		const gd = n.groundwaterToDam ?? null;
		const ra = n.riverAbstraction ?? null;
		const side = (source: AllocationWaterSource): AllocationSourceComparison => {
			const own = allocs.filter((a) => a.waterSource === source);
			const years = spans.map((s): AllocationYear => {
				let modelled = 0;
				let toDam = 0;
				let damDraw = 0;
				for (let d = s.from; d <= s.to; d++) {
					const t = d - start;
					const g = gw ? finite(gw[t]) : 0;
					const pumped = gd ? finite(gd[t]) : 0;
					if (source === 'groundwater') modelled += g + pumped;
					else {
						const surface = finite(n.supplied[t]) - g;
						modelled += surface;
						if (gd) {
							toDam += pumped;
							damDraw += Math.max(surface - (ra ? finite(ra[t]) : 0), 0);
						}
					}
				}
				// Groundwater pumped into the dam and drawn back out that water year (§2.12).
				if (source === 'surface') modelled -= Math.min(toDam, damDraw);
				const reg = registered(own, s.from, s.to, s.yearDays);
				const covered = s.to - s.from + 1;
				return {
					waterYear: s.waterYear,
					days: covered,
					yearDays: s.yearDays,
					partial: covered < s.yearDays,
					modelledM3: modelled,
					registeredM3: reg,
					ratio: reg > NOTHING_M3 ? modelled / reg : null,
					status: allocationStatus(modelled, reg, tolerance)
				};
			});
			const whole = years.filter((y) => !y.partial);
			const mean = (f: (y: AllocationYear) => number) => (whole.length ? whole.reduce((s, y) => s + f(y), 0) / whole.length : null);
			return {
				waterSource: source,
				allocationIds: own.map((a) => a.id),
				years,
				yearsOver: whole.filter((y) => y.status === 'over').length,
				wholeYears: whole.length,
				meanModelledM3PerYear: mean((y) => y.modelledM3),
				meanRegisteredM3PerYear: mean((y) => y.registeredM3)
			};
		};
		const stated = allocs.filter((a) => a.storageM3 !== null && a.storageM3 !== undefined);
		return {
			nodeId: n.nodeId,
			name: n.name,
			kind: n.kind,
			surface: side('surface'),
			groundwater: side('groundwater'),
			storage: {
				registeredM3: stated.length ? stated.reduce((s, a) => s + (a.storageM3 ?? 0), 0) : null,
				modelledCapacityM3: n.kind === 'farm' ? (n.damCapacityM3 ?? null) : null
			}
		};
	});

	return {
		tolerance,
		startDate: input.startDate,
		endDate: fromEpochDay(end),
		nodes,
		unmatchedAllocationIds,
		notInRunAllocationIds
	};
}
