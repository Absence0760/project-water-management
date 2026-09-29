// Daily network water balance — port of the b023 Element sheets (FarmTemplate
// / GaugeTemplate, formula row 17) plus [Transfers], [Fragmented flow] and
// [Fragmented EWR]. Column letters in comments are the FarmTemplate columns;
// see ./README.md for the full mapping and the workbook quirks we mirror.
// Unlike the workbook nothing is rounded: every split conserves water exactly
// (docs/engine-audit.md R1).
import { curveAreaAt, releaseToday, type DamCurve, type PlanRelease } from './dam';
import { landCoverReduction, lowFlowThreshold } from './landcover';
import { groundwaterDay, startsWaterYear, type PlanBorehole } from './boreholes';
import { pumpsRiverToday, riverRoom, surfaceSplit, type PlanSupply } from './supply';
import { splitSupply, type PlanObjects } from './demandObjects';
import type { PlanOfftake } from './offtake';

/**
 * Relative size of float noise treated as zero in a shortfall. A difference
 * of large volumes (outflow − requirement, or a shortfall minus its upstream
 * shortfalls) that is exact in real arithmetic comes out as ±1e-16 of the
 * volumes involved; 1e-12 of them is far below anything measurable (0.01 m³
 * on a 10⁹ m³/day requirement) and far above the noise.
 */
export const SHORTFALL_NOISE = 1e-12;

/**
 * MIN(a − b, 0) with float noise reported as 0: the result is negative only
 * when it exceeds SHORTFALL_NOISE × `scale` (the largest magnitude that went
 * into a and b). Without this a residue of −4.8e-7 m³ counted as a day the
 * EWR was not met, and whether it appeared depended on the order upstream
 * values were summed in (engine review F8).
 */
export function shortfall(a: number, b: number, scale: number): number {
	const d = a - b;
	return d < -SHORTFALL_NOISE * scale ? d : 0;
}

export interface PlanNode {
	kind: 'farm' | 'gauge' | 'user';
	/** Fraction of natural flow / EWR generated on this farm's land. */
	share: number;
	/** Share of the upstream inflow (H) that enters the dam (K); the rest passes below it (L). Engine ≥ 0.9.0 (model.md §3 Q1). */
	pctUpstreamToDam: number;
	pctRunoffToDam: number;
	divertCapacityM3Day: number;
	/** Dam capacity (m³). */
	damCapacityM3: number;
	/** Storage on the day before the first simulated day. */
	initialStorageM3: number;
	/**
	 * The storage this dam starts plan.storageResetDay with, instead of the
	 * day before's (settings.damStorageReset, engine ≥ 0.46.0, issue #53 R6);
	 * absent = no reset. Used clamped to 0 … capacity.
	 */
	storageResetM3?: number;
	/**
	 * The rest of the node's state on the day before the first simulated day,
	 * for a run resumed from a model-state snapshot (engine ≥ 1.1.0,
	 * ../warmstart): the stream-depletion lag store, whether the river pump
	 * was on yesterday (the trigger rule) and each pumping unit's volume so far
	 * this water year. Absent = a fresh start (0, off, 0).
	 */
	initialDepletionStoreM3?: number;
	/** The stream-depletion deficit still owed to the river the day before (engine ≥ 1.10.0); absent = 0. */
	initialDepletionDeficitM3?: number;
	initialOnRiver?: boolean;
	initialBoreholeUsedM3?: readonly number[];
	/**
	 * allocationMode 'cap' (engine ≥ 1.18.0, ../allocations/mode.ts,
	 * docs/model.md §2.12a): per water source, the registered volume (m³) of
	 * the water year each day falls in; null = that source isn't capped.
	 * Surface use (supplied − groundwater to the crop: the dam, the river pump
	 * and off-take water used) and groundwater use (pumped to the crop and
	 * into the dam) per water year stay within it. Absent = no cap.
	 */
	allocationCap?: { surface: Float64Array | null; groundwater: Float64Array | null };
	/** Surface and groundwater use so far this water year, the day before (a resumed run, engine ≥ 1.18.0); absent = 0. */
	initialAllocationUsedM3?: readonly [number, number];
	/**
	 * Dead storage: capacity × the dam's minimum operating level (engine ≥
	 * 0.16.0, audit Q5). Irrigation draws only the storage above it, and
	 * transfers keep at least this much in the source dam.
	 */
	deadStorageM3: number;
	/** Irrigation application efficiency e, 0 < e ≤ 1 (audit N1): abstraction demand D = F / e. */
	irrigationEfficiency: number;
	/** Share β of the application losses (1 − e)·G that returns to the river the same day (audit N1). */
	lossReturnFraction: number;
	/**
	 * Dam surface area when full (m²), as entered or estimated (capacity ÷ 3 m
	 * mean depth); the area on a day is A = full × (Q[t−1] / capacity)^b
	 * (engine ≥ 0.16.0, audit N2). 0 for a node without a dam.
	 */
	damAreaFullM2: number;
	/** Exponent b of the area–storage relation (Liebe et al. 2005: 0.7). */
	damAreaExponent: number;
	/** Seepage per day as a fraction of the storage at the start of the day (audit N2). */
	damSeepagePerDay: number;
	/** Survey curve (WP-3.5): when present the area comes from it, not the power law. */
	damCurve?: DamCurve;
	/** Release rule (WP-3.5), before irrigation. Absent = none. */
	release?: PlanRelease;
	/** Share of the seepage returning below the dam (WP-3.5); absent = all of it. */
	seepageReturn?: number;
	/** Daily crop water requirement (F, net irrigation need); zeros for gauges; a user's own demand from the river (WP-1.33). */
	demand: Float64Array;
	/** A user's share of what it takes that returns below it the same day (WP-1.33); 0 for other kinds. */
	userReturn?: number;
	/**
	 * A senior user whose demand is fragmented to the farms upstream of it
	 * (WP-1.33): the requirement it takes out of the senior claims passing it.
	 * False for a junior user, and for a senior one with no farm share upstream.
	 */
	seniorClaimed?: boolean;
	/** A user's priority (WP-1.33): a senior user takes what reaches it; a junior one leaves the senior requirement passing it. */
	senior?: boolean;
	/**
	 * Boreholes (WP-1.34, WP-3.9, docs/model.md §2.7d); absent = none. Its
	 * pumping units (the combined capacity and each borehole) run in the supply
	 * order of ./boreholes.ts groundwaterDay, each within its daily capacity
	 * and annual cap. Σ d × pumped enters a linear reservoir that releases
	 * `depletionAlpha` of its content each day (1 − e^(−1/k); 1 for k = 0) as
	 * depletion of the river at this node.
	 */
	borehole?: PlanBorehole;
	/**
	 * A farm's supply rule and river pump (WP-3.8, ./supply.ts, docs/model.md
	 * §2.7e); absent = the dam only (damFirst, every engine before 0.42.0).
	 * The pump takes from the flow below the dam S, above the senior users'
	 * requirement and a pass-inflow release's target, up to its capacity;
	 * run of river (rule 3) also sends all inflow and runoff below the (absent) dam.
	 */
	supply?: PlanSupply;
	/**
	 * A unit's demand objects (engine ≥ 1.7.0, ./demandObjects.ts,
	 * docs/model.md §2.7f); absent = none. Their demand adds to the crops'
	 * abstraction demand F / e; what the unit is supplied is split between
	 * crops and objects by priority class (splitSupply), and each object
	 * returns its share of its part below the unit.
	 */
	objects?: PlanObjects;
	/**
	 * Land cover on this farm (WP-1.35, ./landcover.ts): the shares of its
	 * runoff above and up to the low-flow threshold that it removes. Absent = none.
	 */
	landCover?: { mar: number; lowFlow: number };
	/**
	 * A farm's share of the senior users' demand below it, m³/day (WP-1.33):
	 * Σ over senior users u downstream of D_u × share / Σ upstream shares of u,
	 * the EWR's fragmentation rule. Absent = none.
	 */
	seniorClaim?: Float64Array;
	/**
	 * Gross demand before effective rain, the effective rain used against it
	 * (m³/day) and the soil-water store at the end of the day (mm); only
	 * needed for workings (../demand.ts farmDailyDemand).
	 */
	grossDemand?: Float64Array;
	rainOffset?: Float64Array;
	soilWater?: Float64Array;
}

export interface PlanTransfer {
	/** The run series key its volume is stored under (`transfer_rule@<rule id>`, engine ≥ 1.6.0, ./transferSeries.ts); absent for a rule that can never move water. */
	seriesKey?: string;
	from: number;
	to: number;
	/** activeMonth[m] for calendar month m (1–12). */
	activeMonth: Uint8Array;
	/** Source storage kept back: dam capacity × MAX(min storage %, the dam's minimum operating level). */
	reserveM3: number;
	/** Most that can move in one day (m³), by calendar month (index 1–12): the month's rate × 86 400, capped by the daily cap (./transferRates.ts). */
	maxDailyM3: Float64Array;
	/**
	 * Lower moves first (engine ≥ 0.16.0, audit Q18). Rules of equal priority
	 * share the water pro rata, so the list order never matters.
	 */
	priority: number;
}

export interface NetworkPlan {
	days: number;
	nodes: PlanNode[];
	order: Int32Array;
	/**
	 * upstream[i] = nodes draining directly into node i, in a fixed order
	 * (runModel uses node-id order) so sums over them don't depend on how the
	 * nodes are listed.
	 */
	upstream: Int32Array[];
	transfers: PlanTransfer[];
	/**
	 * River off-takes (engine ≥ 1.14.0, ./offtake.ts, docs/model.md §2.6a):
	 * taken from the flow leaving the source unit today, delivered to the
	 * destination, which `order` puts after its source. Absent = none.
	 */
	offtakes?: PlanOfftake[];
	/** Calendar month (1–12) of each day. */
	month: Uint8Array;
	/** Catchment natural flow, m³/day. */
	naturalFlow: Float64Array;
	/** Unfragmented pragmatic EWR at the outflow, m³/day. */
	ewr: Float64Array;
	/**
	 * Open-water evaporation depth per day (mm): lake factor × A-pan for the
	 * month ÷ days in the month (engine ≥ 0.16.0, audit N2). Absent = none.
	 */
	lakeEvapMmDay?: Float64Array;
	/** Rain falling on a dam's surface per day (mm): the day's rain before any threshold (audit N2). Absent = none. */
	damRainMm?: Float64Array;
	/** The run day the dams with a storageResetM3 start from it (engine ≥ 0.46.0); absent = none. */
	storageResetDay?: number;
	/**
	 * The land-cover low-flow threshold to use (m³/day), pinned from the run a
	 * snapshot was captured from (engine ≥ 1.1.0, ../warmstart); absent = the
	 * natural flow's own Q75 over this run.
	 */
	lowFlowThresholdM3Day?: number;
	/**
	 * A run resumed part-way through a record (engine ≥ 1.1.0): the calendar
	 * month of the day before its first day, so day 0 starts a water year (and
	 * clears the boreholes' annual volumes) only when it is 1 October.
	 */
	continued?: { monthBefore: number };
}

/** Per-node daily results. Gauges fill inflowUpstream/outflow/ewrCumulative/ewrShortfall only. */
export interface NodeResult {
	/** Abstraction demand D = F / e (engine ≥ 0.16.0, audit N1). */
	demand: Float64Array;
	/** Crop water requirement F (net irrigation need). */
	cropRequirement: Float64Array;
	supplied: Float64Array; // G
	inflowUpstream: Float64Array; // H
	runoff: Float64Array; // I
	transfer: Float64Array; // J
	storage: Float64Array; // Q
	spill: Float64Array; // R
	outflow: Float64Array; // U
	deficit: Float64Array; // W
	ewr: Float64Array; // Y
	ewrCumulative: Float64Array; // Z
	ewrShortfall: Float64Array; // AA
	ewrShortfallIncremental: Float64Array; // AB
	/**
	 * The senior users' requirement still to pass below this node (WP-1.33):
	 * Zs = own senior claim + Σ upstream Zs, less a senior user's own demand.
	 * All zeros without senior users.
	 */
	seniorRequirement: Float64Array;
	/** A user's return below it, r × supplied (WP-1.33); zeros for farms (theirs is a working column) and gauges. */
	userReturn: Float64Array;
	/** Groundwater pumped to the crop or user (WP-1.34), part of `supplied`. Zeros without boreholes. */
	groundwater: Float64Array;
	/** Groundwater pumped into the farm dam (WP-3.9), not part of `supplied`. Zeros without dam-target boreholes. */
	groundwaterToDam: Float64Array;
	/** What each of the node's pumping units pumped per day (WP-3.9), in `borehole.units` order; absent without boreholes. */
	boreholePumped?: Float64Array[];
	/**
	 * allocationMode 'cap' (engine ≥ 1.18.0): what each capped source may
	 * still take this water year, at the start of each day (m³): the year's
	 * registered volume less its use so far. null for a source without a cap;
	 * absent on a node without one.
	 */
	allocationRoom?: { surface: Float64Array | null; groundwater: Float64Array | null };
	/** Pumped from the river below the dam (WP-3.8), part of `supplied`; absent without a supply rule that can pump from the river. */
	riverAbstraction?: Float64Array;
	/** What each demand object was supplied (engine ≥ 1.7.0), in `objects` order, part of `supplied`; absent without demand objects. */
	objectSupplied?: Float64Array[];
	/** Delivered by river off-takes into this unit (engine ≥ 1.14.0), after conveyance losses; absent on a unit no off-take reaches. */
	offtakeIn?: Float64Array;
	/** Taken by river off-takes from the flow leaving this unit (engine ≥ 1.14.0), before losses; absent on a unit no off-take draws on. */
	offtakeOut?: Float64Array;
	/**
	 * The storage reset's step (engine ≥ 0.46.0): on the reset day, the
	 * storage set − the storage the day before left (m³, + added / − taken);
	 * 0 on every other day. Absent on a dam without a reset.
	 */
	storageSet?: Float64Array;
	/** Stream depletion taken from the node's outflow (WP-1.34), after the clamp. */
	depletion: Float64Array;
	/**
	 * The stream-depletion deficit at the end of the day (engine ≥ 1.10.0, m³):
	 * depletion that fell due while the river had no flow left at the node,
	 * carried over and taken off the first flow there. Never dropped.
	 */
	depletionDeficit: Float64Array;
	/** Depletion still to come at the end of the day: the lag reservoir's content (m³). */
	depletionStore: Float64Array;
	/** Natural runoff land cover removed before the farm got it (WP-1.35); I = natural × share − this. */
	landCoverReduction: Float64Array;
}

/**
 * Today's stream depletion at a node (WP-1.34): Σ d × pumping (`depleting`) enters the lag
 * reservoir and α of its content falls due. What is owed is yesterday's
 * deficit plus today's due; the river gives at most what flows out of the node
 * (`flow`), and the rest stays owed as the deficit, taken off the first flow
 * that returns (engine ≥ 1.10.0; before it, the rest was dropped). Writes the
 * node's depletion columns and returns the depletion taken.
 */
function deplete(node: PlanNode, r: NodeResult, t: number, depleting: number, flow: number): number {
	const b = node.borehole;
	if (!b) return 0;
	const store = (t === 0 ? (node.initialDepletionStoreM3 ?? 0) : r.depletionStore[t - 1]!) + depleting;
	const due = b.depletionAlpha * store;
	const owed = (t === 0 ? (node.initialDepletionDeficitM3 ?? 0) : r.depletionDeficit[t - 1]!) + due;
	const taken = Math.min(owed, Math.max(flow, 0));
	r.depletionStore[t] = store - due;
	r.depletion[t] = taken;
	r.depletionDeficit[t] = owed - taken;
	return taken;
}

/**
 * A farm's intermediate columns (model.md §2.7), recorded only when asked
 * (simulateNetwork(plan, { workings: true })) so calibration's thousands of
 * runs don't pay for them. They let a user redo any day by hand.
 */
export interface FarmWorkings {
	grossDemand: Float64Array; // before effective rain
	rainOffset: Float64Array; // effective rain used: MIN(soil store + today's effective rain, gross)
	soilWater: Float64Array; // soil-water store at the end of the day (mm)
	upstreamToDam: Float64Array; // K
	upstreamBelowDam: Float64Array; // L
	runoffToDam: Float64Array; // M
	runoffBelowDam: Float64Array; // N
	divertedToDam: Float64Array; // O
	interimStorage: Float64Array; // P
	belowDamNotDiverted: Float64Array; // S
	returnFlow: Float64Array; // T = β·(1 − e)·G
	/** Dam surface area at the start of the day (m²), audit N2. */
	damArea: Float64Array;
	/** Open-water evaporation from the dam, after the clamp (m³/day). */
	damEvaporation: Float64Array;
	/** Rain falling on the dam's surface (m³/day). */
	rainOnDam: Float64Array;
	/** Seepage out of the dam, after the clamp (m³/day); it joins the outflow U. */
	damSeepage: Float64Array;
	/** The part of the seepage lost from the catchment (WP-3.5); the rest joins U. */
	damSeepageLost: Float64Array;
	/** Released below the dam before irrigation (WP-3.5); it joins U. */
	damRelease: Float64Array;
	/** V, signed: (H + I + J + rain on dam) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U. Float noise only. */
	balanceResidual: Float64Array;
	/**
	 * Flow kept out of the dam so the senior users' requirement passes below
	 * it (WP-1.33): the cut in O, then in K and M, that makes S ≥ MIN(Zs, H + I).
	 */
	passedForSenior: Float64Array;
	/**
	 * River off-take water delivered here (engine ≥ 1.14.0): the part that
	 * met the demand directly and the part that went into the dam (the rest
	 * flowed on in U). Only on a unit an off-take reaches.
	 */
	offtakeUsed?: Float64Array;
	offtakeToDam?: Float64Array;
}

/** The network's day-to-day state at the start of a day, per node (simulateNetwork's `captureAt`, engine ≥ 1.1.0). */
export interface NetworkState {
	/** Dam storage the day before (before any storage reset that day). */
	storageM3: Float64Array;
	depletionStoreM3: Float64Array;
	/** The stream-depletion deficit the day before (engine ≥ 1.10.0). */
	depletionDeficitM3: Float64Array;
	/** 1 = the river pump was on the day before. */
	onRiver: Uint8Array;
	/** Each pumping unit's volume so far this water year (before a 1 October clears it); null without boreholes. */
	boreholeUsedM3: (number[] | null)[];
	/** Surface and groundwater use so far this water year under an allocation cap (before a 1 October clears it); null without a cap. */
	allocationUsedM3: ([number, number] | null)[];
}

export interface NetworkResult {
	nodes: NodeResult[];
	/** The state at the start of day `captureAt`, when asked. */
	captured?: NetworkState;
	/** Per node when simulated with { workings: true } (gauges get none). */
	workings?: (FarmWorkings | null)[];
	/** Volume moved by each transfer per day (m³). */
	transfers: Float64Array[];
	/** Volume each river off-take took per day (m³, before conveyance losses), in plan.offtakes order; absent without off-takes. */
	offtakes?: Float64Array[];
}

function allocNode(days: number): NodeResult {
	const f = () => new Float64Array(days);
	return {
		demand: f(),
		cropRequirement: f(),
		supplied: f(),
		inflowUpstream: f(),
		runoff: f(),
		transfer: f(),
		storage: f(),
		spill: f(),
		outflow: f(),
		deficit: f(),
		ewr: f(),
		ewrCumulative: f(),
		ewrShortfall: f(),
		ewrShortfallIncremental: f(),
		seniorRequirement: f(),
		userReturn: f(),
		groundwater: f(),
		groundwaterToDam: f(),
		depletion: f(),
		depletionDeficit: f(),
		depletionStore: f(),
		landCoverReduction: f()
	};
}

function allocWorkings(node: PlanNode, days: number): FarmWorkings {
	const f = () => new Float64Array(days);
	return {
		grossDemand: node.grossDemand ?? node.demand,
		rainOffset: node.rainOffset ?? f(),
		soilWater: node.soilWater ?? f(),
		upstreamToDam: f(),
		upstreamBelowDam: f(),
		runoffToDam: f(),
		runoffBelowDam: f(),
		divertedToDam: f(),
		interimStorage: f(),
		belowDamNotDiverted: f(),
		returnFlow: f(),
		damArea: f(),
		damEvaporation: f(),
		rainOnDam: f(),
		damSeepage: f(),
		damSeepageLost: f(),
		damRelease: f(),
		balanceResidual: f(),
		passedForSenior: f()
	};
}

/**
 * A dam's surface area, rain on it, open-water evaporation and seepage today
 * (audit N2), all from yesterday's storage and before any cap: the routing
 * caps evaporation and seepage at what is in the dam once today's transfer
 * has landed, and the transfer room (N4) counts them as they are. Zero for a
 * node without a dam or an empty one.
 *
 * With b > 1 evaporation is also at most (1 − seepage) × Q[t−1] / b (engine
 * 0.21.1). The daily step applies the start-of-day surface to the whole day,
 * and when the surface grows faster than the volume (A ∝ Q^b, b > 1) a day's
 * evaporation of more than 1/b of the dam makes Q[t−1] − E − Sp fall as
 * Q[t−1] rises: a fuller dam ended the day with less water (149 m³ all
 * evaporated while 144 m³ kept 3 m³, fuzz seed 15979), which the real
 * process, a dam evaporating as its surface shrinks, never does. The cap is
 * the largest loss for which the step keeps that order; it is a limiter, not
 * physics, and never binds for b ≤ 1, where the clamped step already keeps
 * it (docs/model.md §2.7a).
 */
function damDay(node: PlanNode, qPrev: number, t: number, lakeEvapMmDay: Float64Array | undefined, damRainMm: Float64Array | undefined): { A: number; Pd: number; E: number; Sp: number } {
	const cap = node.damCapacityM3;
	if (!(cap > 0 && qPrev > 0)) return { A: 0, Pd: 0, E: 0, Sp: 0 };
	if (node.damCurve) {
		// Survey curve (WP-3.5): area linear in volume between rows. The limiter
		// above generalises to the curve's local exponent b = Q·A′/A: while it
		// exceeds 1, evaporation is at most (1 − seepage) × A / A′.
		const { area: A, slope } = curveAreaAt(node.damCurve, qPrev);
		const s = node.damSeepagePerDay;
		const E = lakeEvapMmDay ? (lakeEvapMmDay[t]! * A) / 1000 : 0;
		return {
			A,
			Pd: damRainMm ? (damRainMm[t]! * A) / 1000 : 0,
			E: A > 0 && qPrev * slope > A ? Math.min(E, ((1 - s) * A) / slope) : E,
			Sp: s * qPrev
		};
	}
	const b = node.damAreaExponent;
	const A = node.damAreaFullM2 * Math.pow(Math.min(qPrev / cap, 1), b);
	const s = node.damSeepagePerDay;
	const E = lakeEvapMmDay ? (lakeEvapMmDay[t]! * A) / 1000 : 0;
	return {
		A,
		Pd: damRainMm ? (damRainMm[t]! * A) / 1000 : 0,
		E: b > 1 ? Math.min(E, ((1 - s) * qPrev) / b) : E,
		Sp: s * qPrev
	};
}

/**
 * What a node may still take today under an allocation cap (engine ≥ 1.18.0):
 * [surface, groundwater], each the water year's registered volume less the
 * use so far, never below 0; Infinity for a source (or a node) without a cap.
 * Records the room in the node's allocation_room columns.
 */
function allocationRoom(node: PlanNode, r: NodeResult, used: Float64Array | null, t: number): [number, number] {
	const c = node.allocationCap;
	if (!c || !used) return [Infinity, Infinity];
	const room = r.allocationRoom!;
	let s = Infinity;
	let g = Infinity;
	if (c.surface) s = room.surface![t] = Math.max(0, c.surface[t]! - used[0]!);
	if (c.groundwater) g = room.groundwater![t] = Math.max(0, c.groundwater[t]! - used[1]!);
	return [s, g];
}

export function simulateNetwork(plan: NetworkPlan, opts: { workings?: boolean; captureAt?: number } = {}): NetworkResult {
	const { days, nodes, order, upstream, transfers, month, naturalFlow, ewr, lakeEvapMmDay, damRainMm } = plan;
	const res = nodes.map((n, i) => {
		const r = allocNode(days);
		if (n.borehole) r.boreholePumped = n.borehole.units.map(() => new Float64Array(days));
		if (n.supply) r.riverAbstraction = new Float64Array(days);
		if (n.objects) r.objectSupplied = n.objects.ids.map(() => new Float64Array(days));
		if (plan.offtakes?.some((o) => o.to === i)) r.offtakeIn = new Float64Array(days);
		if (plan.offtakes?.some((o) => o.from === i)) r.offtakeOut = new Float64Array(days);
		if (n.storageResetM3 !== undefined && plan.storageResetDay !== undefined) r.storageSet = new Float64Array(days);
		if (n.allocationCap) r.allocationRoom = { surface: n.allocationCap.surface ? new Float64Array(days) : null, groundwater: n.allocationCap.groundwater ? new Float64Array(days) : null };
		return r;
	});
	// The storage reset (engine ≥ 0.46.0, settings.damStorageReset): the day, −1 = none.
	const resetDay = plan.storageResetDay ?? -1;
	/** Node i's storage at the start of day t: the day before's, or on the reset day the storage set. */
	const startStorage = (i: number, t: number): number => {
		const n = nodes[i]!;
		if (t === resetDay && n.storageResetM3 !== undefined) return Math.min(Math.max(n.storageResetM3, 0), n.damCapacityM3);
		return t === 0 ? n.initialStorageM3 : res[i]!.storage[t - 1]!;
	};
	// Whether each farm under the trigger rule (WP-3.8) pumped from the river yesterday.
	const onRiver = Uint8Array.from(nodes, (n) => (n.initialOnRiver ? 1 : 0));
	// Each pumping unit's volume so far this water year (WP-3.9 annual caps).
	const bhUsed = nodes.map((n) => {
		if (!n.borehole) return null;
		const u = new Float64Array(n.borehole.units.length);
		const init = n.initialBoreholeUsedM3;
		if (init) {
			if (init.length !== u.length) throw new Error(`a node's saved borehole volumes have ${init.length} units, its plan ${u.length}`);
			u.set(init);
		}
		return u;
	});
	// Each capped node's surface and groundwater use so far this water year (allocationMode 'cap', engine ≥ 1.18.0).
	const allocUsed = nodes.map((n) => (n.allocationCap ? Float64Array.from(n.initialAllocationUsedM3 ?? [0, 0]) : null));
	// A resumed run's day 0 starts a water year only on 1 October (engine ≥ 1.1.0).
	const startsYear = (t: number) => (t === 0 && plan.continued ? month[0] === 10 && plan.continued.monthBefore !== 10 : startsWaterYear(month, t));
	let captured: NetworkState | undefined;
	const capture = (t: number): NetworkState => ({
		storageM3: Float64Array.from(nodes, (n, i) => (t === 0 ? n.initialStorageM3 : res[i]!.storage[t - 1]!)),
		depletionStoreM3: Float64Array.from(nodes, (n, i) => (t === 0 ? (n.initialDepletionStoreM3 ?? 0) : res[i]!.depletionStore[t - 1]!)),
		depletionDeficitM3: Float64Array.from(nodes, (n, i) => (t === 0 ? (n.initialDepletionDeficitM3 ?? 0) : res[i]!.depletionDeficit[t - 1]!)),
		onRiver: onRiver.slice(),
		boreholeUsedM3: bhUsed.map((u) => (u ? Array.from(u) : null)),
		allocationUsedM3: allocUsed.map((u) => (u ? [u[0]!, u[1]!] : null))
	});
	const work = opts.workings
		? nodes.map((n, i) => {
				if (n.kind !== 'farm') return null;
				const w = allocWorkings(n, days);
				if (res[i]!.offtakeIn) {
					w.offtakeUsed = new Float64Array(days);
					w.offtakeToDam = new Float64Array(days);
				}
				return w;
			})
		: null;
	// River off-takes (engine ≥ 1.14.0, ./offtake.ts): each source's rules by priority, lowest first.
	const offtakes = plan.offtakes ?? [];
	const otVol = offtakes.map(() => new Float64Array(days));
	const otLevels: (number[][] | null)[] = nodes.map((_, i) => {
		const mine = offtakes.flatMap((o, k) => (o.from === i ? [k] : []));
		if (!mine.length) return null;
		return [...new Set(mine.map((k) => offtakes[k]!.priority))].sort((a, b) => a - b).map((p) => mine.filter((k) => offtakes[k]!.priority === p));
	});
	// Delivered into each unit today (after losses), the part from rules that top up the dam, and each demand-sized rule's share of its destination's need.
	const otIn = new Float64Array(nodes.length);
	const otInDam = new Float64Array(nodes.length);
	const otShare = new Float64Array(offtakes.length);
	const otWant = new Float64Array(offtakes.length);
	const otCapInto = new Float64Array(nodes.length);
	const trOut = transfers.map(() => new Float64Array(days));
	const jToday = new Float64Array(nodes.length);
	// Volume already committed today by earlier transfers from each source dam,
	// and already scheduled into each destination.
	const drawnToday = new Float64Array(nodes.length);
	const intoToday = new Float64Array(nodes.length);
	// Transfer rules by priority, lowest first (audit Q18).
	const levels = [...new Set(transfers.map((tr) => tr.priority))].sort((a, b) => a - b).map((p) => transfers.flatMap((tr, k) => (tr.priority === p ? [k] : [])));
	const want = new Float64Array(transfers.length);
	const sumBy = new Float64Array(nodes.length);
	const freeBy = new Float64Array(nodes.length);

	// Land cover (WP-1.35): the catchment's low-flow threshold, natural flow exceeded 75 % of the days.
	const qLow = !nodes.some((n) => n.landCover) ? 0 : plan.lowFlowThresholdM3Day !== undefined ? plan.lowFlowThresholdM3Day : lowFlowThreshold(naturalFlow.subarray(0, days));

	for (let t = 0; t < days; t++) {
		if (t === opts.captureAt) captured = capture(t);
		if (t === resetDay) {
			for (let i = 0; i < nodes.length; i++) {
				const r = res[i]!;
				if (r.storageSet) r.storageSet[t] = startStorage(i, t) - (t === 0 ? nodes[i]!.initialStorageM3 : r.storage[t - 1]!);
			}
		}
		// [Transfers] "Draw from dam": uses the storage at the end of the
		// previous day (Q, row N-1), so all transfers are settled before any farm
		// irrigates, the source's own irrigation included (quirk Q3: the source
		// doesn't irrigate first). Each rule moves
		//   v = MAX(0, MIN(source free, destination room, max daily))
		// with source free = Q_src[t−1] − drawn today − reserve and destination
		// room = cap_dst − (Q_dst[t−1] + rain on it − evaporation − seepage)
		// + D_dst[t] − scheduled into it today, so a transfer never pumps into a
		// full dam only to spill, and one to a farm with no dam still serves its
		// demand (audit N4). The dam's own gains and losses today (N2) count:
		// they follow yesterday's storage alone, so they are known before the
		// transfer, and a room that ignored them left a leaking dam short of
		// its demand by a fixed volume while the source had water to spare,
		// which a larger demand would have hidden (engine 0.19.0; fuzz seed
		// 921, "doubling crop areas raised the supply fraction"). Rules run by priority,
		// lowest first (Q18); within a priority, rules into one destination share
		// its room and rules from one source share its free water, each pro rata
		// to its own limit, so the result never depends on the list order.
		jToday.fill(0);
		drawnToday.fill(0);
		intoToday.fill(0);
		const prevQ = (n: number) => startStorage(n, t);
		for (const level of levels) {
			// 1. Each active rule's own limit: its daily cap and its source's free water.
			for (const k of level) {
				const tr = transfers[k]!;
				if (!tr.activeMonth[month[t]!]) {
					want[k] = 0;
					continue;
				}
				const free = prevQ(tr.from) - drawnToday[tr.from]! - tr.reserveM3;
				want[k] = Math.max(0, Math.min(free, tr.maxDailyM3[month[t]!]!));
			}
			// 2. Rules into one destination share its room, pro rata to their limits.
			sumBy.fill(0);
			for (const k of level) sumBy[transfers[k]!.to]! += want[k]!;
			for (const k of level) {
				const tr = transfers[k]!;
				const total = sumBy[tr.to]!;
				const dst = nodes[tr.to]!;
				const q = prevQ(tr.to);
				const loss = damDay(dst, q, t, lakeEvapMmDay, damRainMm);
				// Today's demand D: the crops' abstraction plus any demand objects' (engine ≥ 1.7.0).
				const dstD = dst.objects ? dst.demand[t]! / dst.irrigationEfficiency + dst.objects.total[t]! : dst.demand[t]! / dst.irrigationEfficiency;
				const room = Math.max(0, dst.damCapacityM3 - (q + loss.Pd - loss.E - loss.Sp) + dstD - intoToday[tr.to]!);
				if (total > room) want[k] = (want[k]! * room) / total;
			}
			// 3. Rules from one source share its free water, pro rata (the most a rule of this priority may leave it).
			sumBy.fill(0);
			freeBy.fill(0);
			for (const k of level) {
				const tr = transfers[k]!;
				sumBy[tr.from]! += want[k]!;
				if (tr.activeMonth[month[t]!]) freeBy[tr.from] = Math.max(freeBy[tr.from]!, prevQ(tr.from) - drawnToday[tr.from]! - tr.reserveM3);
			}
			for (const k of level) {
				const tr = transfers[k]!;
				const total = sumBy[tr.from]!;
				const free = freeBy[tr.from]!;
				if (total > free) want[k] = (want[k]! * free) / total;
			}
			// 4. Move the water.
			for (const k of level) {
				const tr = transfers[k]!;
				const v = want[k]!;
				trOut[k]![t] = v;
				drawnToday[tr.from]! += v;
				intoToday[tr.to]! += v;
				jToday[tr.to]! += v;
				jToday[tr.from]! -= v;
			}
		}

		// River off-takes sized to their destination's need (sizing 'demand'): its demand today, plus its
		// dam's room for a rule that tops it up, split between the rules into it pro rata to their capacity
		// today, so the split never depends on which source is simulated first.
		if (offtakes.length) {
			otIn.fill(0);
			otInDam.fill(0);
			otCapInto.fill(0);
			for (const o of offtakes) if (o.sizing === 0) otCapInto[o.to]! += o.capM3Day[month[t]!]!;
			for (let k = 0; k < offtakes.length; k++) {
				const o = offtakes[k]!;
				const cap = o.capM3Day[month[t]!]!;
				if (o.sizing !== 0 || !(cap > 0)) {
					otShare[k] = 0;
					continue;
				}
				const dst = nodes[o.to]!;
				let need = dst.objects ? dst.demand[t]! / dst.irrigationEfficiency + dst.objects.total[t]! : dst.demand[t]! / dst.irrigationEfficiency;
				if (o.topUpDam && dst.damCapacityM3 > 0) {
					const q = prevQ(o.to);
					const g = damDay(dst, q, t, lakeEvapMmDay, damRainMm);
					need += Math.max(0, dst.damCapacityM3 - (q + g.Pd - g.E - g.Sp));
				}
				otShare[k] = (need * cap) / otCapInto[o.to]!;
			}
		}

		const nat = naturalFlow[t]!;
		const ewrT = ewr[t]!;
		// Annual borehole caps (WP-3.9) run per water year, October to September.
		if (startsYear(t)) {
			for (const u of bhUsed) u?.fill(0);
			for (const u of allocUsed) u?.fill(0);
		}
		for (let oi = 0; oi < order.length; oi++) {
			const i = order[oi]!;
			const node = nodes[i]!;
			const r = res[i]!;
			const ups = upstream[i]!;
			let sumU = 0;
			let sumZ = 0;
			let sumZs = 0;
			let sumAA = 0;
			// Magnitude of the upstream shortfalls, the scale of their float noise.
			let absAA = 0;
			for (let u = 0; u < ups.length; u++) {
				const ur = res[ups[u]!]!;
				sumU += ur.outflow[t]!;
				sumZ += ur.ewrCumulative[t]!;
				sumZs += ur.seniorRequirement[t]!;
				sumAA += ur.ewrShortfall[t]!;
				absAA += Math.abs(ur.ewrShortfall[t]!);
			}

			if (node.kind === 'gauge') {
				// GaugeTemplate: G = Σ upstream U, H = Σ upstream Z. The shortfall is
				// the gauge's own flow against its own requirement, like a farm's AA.
				// The workbook sums the branches' AA (I = Σ upstream AA), which
				// reports a shortfall at a confluence whose flow meets the EWR when
				// one branch is short and another has water to spare (audit G1).
				r.inflowUpstream[t] = sumU;
				r.outflow[t] = sumU;
				r.ewrCumulative[t] = sumZ;
				r.ewrShortfall[t] = shortfall(sumU, sumZ, Math.max(sumU, sumZ));
				r.seniorRequirement[t] = sumZs;
				continue;
			}

			if (node.kind === 'user') {
				// An other water user (WP-1.33, docs/model.md §2.7c) draws from the
				// river at its position only. A senior user takes what reaches it; a
				// junior one leaves the senior requirement passing it for the senior
				// users below. What it returns (treated wastewater) joins its outflow
				// the same day. Like a gauge it has no EWR share of its own.
				const D = node.demand[t]!;
				const avail = node.senior ? sumU : Math.max(0, sumU - sumZs);
				const [sRoom, gRoom] = allocationRoom(node, r, allocUsed[i]!, t);
				// Boreholes (WP-1.34, WP-3.9): what the river can't give (or first, primary).
				let Gs = Math.min(avail, D, sRoom);
				let Ggw = 0;
				let dGw = 0;
				if (node.borehole) [Gs, Ggw, , dGw] = groundwaterDay(node.borehole, bhUsed[i]!, r.boreholePumped!, t, D, 0, avail, 0, 0, 0, 1, sRoom, gRoom);
				const G = Math.min(Gs + Ggw, D);
				const au = allocUsed[i];
				if (au) {
					au[0]! += G - Ggw;
					au[1]! += Ggw;
				}
				const T = (node.userReturn ?? 0) * G;
				const Uriver = sumU - Gs + T;
				const U = Uriver - deplete(node, r, t, dGw, Uriver);
				r.groundwater[t] = Ggw;
				r.demand[t] = D;
				r.supplied[t] = G;
				r.deficit[t] = D - G;
				r.inflowUpstream[t] = sumU;
				r.outflow[t] = U;
				r.userReturn[t] = T;
				r.ewrCumulative[t] = sumZ;
				r.ewrShortfall[t] = shortfall(U, sumZ, Math.max(U, sumZ));
				// A senior user takes its own demand out of the requirement; float noise can't make it negative.
				r.seniorRequirement[t] = node.seniorClaimed ? Math.max(0, sumZs - D) : sumZs;
				continue;
			}

			const F = node.demand[t]!;
			// Abstraction demand: the crop requirement plus the application losses (audit N1),
			// plus the unit's demand objects (engine ≥ 1.7.0, docs/model.md §2.7f).
			const Dc = F / node.irrigationEfficiency;
			const objs = node.objects;
			const D = objs ? Dc + objs.total[t]! : Dc;
			const H = sumU;
			// Land cover removes part of the farm's natural runoff before it reaches the river or dam (WP-1.35).
			const I0 = nat * node.share;
			const lc = node.landCover ? landCoverReduction(I0, qLow * node.share, node.landCover) : 0;
			const I = I0 - lc;
			r.landCoverReduction[t] = lc;
			const J = jToday[i]!;
			// The percentage is the share of upstream inflow that enters the dam
			// (K); the rest passes below it (L), where the diversion capacity (O)
			// can still take some back. The b023 formula had it the other way
			// round (L = H × %), against its own label and [Models] sheet; the
			// client confirmed the label's meaning (engine 0.9.0, model.md §3 Q1).
			// A split never exceeds the volume it splits.
			// Run of river (WP-3.8): no dam, so everything passes below it, where the pump takes from.
			const sup = node.supply;
			const ror = sup !== undefined && sup.rule === 3;
			let K = ror ? 0 : Math.min(H * node.pctUpstreamToDam, H);
			let L = H - K;
			let M = ror ? 0 : Math.min(I * node.pctRunoffToDam, I);
			let N = I - M;
			let O = ror ? 0 : Math.min(node.divertCapacityM3Day, L + N);
			// Senior users below (WP-1.33): the farm passes their requirement Zs
			// below the dam (S) before it fills the dam, as far as its inflow
			// allows: it diverts less first, then takes less of the upstream
			// inflow and its own runoff into the dam, pro rata. Zs = 0 changes nothing.
			const Zs = sumZs + (node.seniorClaim ? node.seniorClaim[t]! : 0);
			let passed = 0;
			if (Zs > 0) {
				let short = Math.min(Zs, H + I) - (L + N - O);
				if (short > 0) {
					const dO = Math.min(short, O);
					O -= dO;
					short -= dO;
					passed += dO;
					const into = K + M;
					if (short > 0 && into > 0) {
						const cut = Math.min(short, into);
						if (cut >= into) {
							// Everything passes: exactly nothing enters the dam (a pro-rata cut
							// would leave a float residue there, which an emptying dam's
							// area–storage power then magnifies; fuzz seed 360).
							K = 0;
							M = 0;
						} else {
							const dK = (cut * K) / into;
							K = Math.max(0, K - dK);
							M = Math.max(0, M - (cut - dK));
						}
						L = H - K;
						N = I - M;
						passed += cut;
					}
				}
			}
			const qPrev = startStorage(i, t);
			// Dam losses and gains before irrigation (audit N2). The surface area
			// follows yesterday's storage, A = A_full × (Q[t−1] / cap)^b; rain on
			// that surface is a gain, open-water evaporation and seepage losses.
			// Evaporation takes at most what is there (yesterday's storage, the
			// rain and today's net transfer, which was settled first), seepage at
			// most what evaporation leaves, so storage stays ≥ 0.
			const cap = node.damCapacityM3;
			const day = damDay(node, qPrev, t, lakeEvapMmDay, damRainMm);
			const A = day.A;
			const Pd = day.Pd;
			// A transfer out never takes more than yesterday's storage, so this is ≥ 0 up to float noise.
			const there = Math.max(qPrev + Pd + J, 0);
			const E = Math.min(day.E, there);
			const Sp = Math.min(day.Sp, there - E);
			const qStart = qPrev + Pd - E - Sp;
			// River off-take water delivered here (engine ≥ 1.14.0): it meets the demand first, then tops up the
			// dam (the rules that say so, their share of what is left), and the rest flows on below the unit.
			// The use left under an allocation cap (engine ≥ 1.18.0); Infinity when uncapped.
			const [sRoom, gRoom] = allocationRoom(node, r, allocUsed[i]!, t);
			const Xin = offtakes.length ? otIn[i]! : 0;
			let Xused = 0;
			let XtoDam = 0;
			let Xpass = 0;
			if (Xin > 0) {
				// Off-take water used here is surface use, within the cap.
				Xused = Math.min(Xin, D, sRoom);
				const rest = Xin - Xused;
				XtoDam = rest > 0 && otInDam[i]! > 0 ? Math.min(rest, (rest * otInDam[i]!) / Xin) : 0;
				Xpass = rest - XtoDam;
			}
			let avail0 = qStart + M + O + K + J;
			if (XtoDam > 0) avail0 += XtoDam;
			const S = L + N - O;
			const Y = ewrT * node.share;
			const Z = Y + sumZ;
			// Release below the dam before irrigation (WP-3.5): pass today's inflow
			// up to what the river below still needs, or a fixed amount from the
			// storage above dead storage, capped by the outlet. It comes before
			// the boreholes (WP-3.9), so a dam-target borehole tops up what the
			// release left and an emergency one sees the dam after it.
			let Rel = 0;
			if (node.release) {
				Rel = releaseToday(node.release, month[t]!, K + M + O, Z, S, Math.max(avail0, 0), node.deadStorageM3);
				avail0 -= Rel;
			}
			// Irrigation draws only what is above the dam's minimum operating
			// level (dead storage, audit Q5); a dam below it supplies nothing.
			// Boreholes (WP-1.34, WP-3.9) add groundwater: supplemental after the
			// dam and river, primary before them, emergency (drought) only while
			// the dam is low; dam-target ones pump into the dam first (Gd).
			// The river pump (WP-3.8, docs/model.md §2.7e): what it can take today
			// from the flow below the dam, S, above what must pass it (the senior
			// users' requirement; a pass-inflow release's target, so the pump
			// never takes what the release is there to keep flowing), up to its
			// capacity. Under the trigger rule only while switched to the river.
			let room = 0;
			if (sup) {
				const river = pumpsRiverToday(sup, onRiver[i] === 1, qPrev);
				onRiver[i] = river ? 1 : 0;
				if (river) {
					const rel = node.release;
					const target = rel && rel.rule === 1 ? (rel.m3DayByMonth ? rel.m3DayByMonth[month[t]!]! : Z) : 0;
					room = riverRoom(sup, S, Math.max(Zs, target));
				}
			}
			let Gs: number;
			let Gr = 0;
			let Ggw = 0;
			let Gd = 0;
			let dGw = 0;
			// What the unit's own sources still have to supply once the off-take water is used.
			const Dl = Xused > 0 ? D - Xused : D;
			const sLeft = Xused > 0 ? sRoom - Xused : sRoom;
			if (node.borehole) [Gs, Ggw, Gd, dGw, Gr] = groundwaterDay(node.borehole, bhUsed[i]!, r.boreholePumped!, t, Dl, qPrev, avail0, node.deadStorageM3, cap, room, sup?.rule ?? 1, sLeft, gRoom);
			else if (room > 0) [Gs, Gr] = surfaceSplit(sup!.rule, Math.min(Dl, sLeft), Math.max(avail0 - node.deadStorageM3, 0), room);
			else Gs = Math.min(Math.max(avail0 - node.deadStorageM3, 0), Dl, sLeft);
			const avail = Gd > 0 ? avail0 + Gd : avail0;
			// Gs + (D − Gs) can round one ulp above D, and so can Xused + (D − Xused) (fuzz seed 15467).
			const G = Xused > 0 ? Math.min(Xused + Math.min(Gs + Ggw + Gr, Dl), D) : Math.min(Gs + Ggw + Gr, D);
			const au = allocUsed[i];
			if (au) {
				au[0]! += G - Ggw;
				au[1]! += Ggw + Gd;
			}
			const P = avail - Gs;
			const Q = Math.min(P, cap);
			const Rr = Math.max(P - cap, 0);
			// The crop gets e·G; of the losses (1 − e)·G, the share β returns below the farm (audit N1).
			// With demand objects (engine ≥ 1.7.0) G is split between the crops and the objects
			// first, and each object returns its share of its own part.
			let T: number;
			if (objs) {
				const got = r.objectSupplied!;
				const Gc = splitSupply(G, Dc, objs, t, got);
				T = node.lossReturnFraction * (1 - node.irrigationEfficiency) * Gc;
				for (let k = 0; k < got.length; k++) T += objs.returnShare[k]! * got[k]![t]!;
			} else T = node.lossReturnFraction * (1 - node.irrigationEfficiency) * G;
			// Seepage leaves the dam below the wall and joins the outflow the same
			// day (N2), all of it unless a share is set to be lost (WP-3.5).
			const SpRet = node.seepageReturn === undefined ? Sp : Sp * node.seepageReturn;
			const SpLost = Sp - SpRet;
			// Stream depletion from pumping (WP-1.34) is taken from the flow leaving the farm.
			// What the river pump took (WP-3.8) leaves the flow below the dam.
			let Uriver = Rr + (S - Gr) + T + SpRet;
			if (Rel > 0) Uriver += Rel;
			// Off-take water this unit doesn't use or store flows on (engine ≥ 1.14.0).
			if (Xpass > 0) Uriver += Xpass;
			const Dep = deplete(node, r, t, dGw, Uriver);
			let U = Uriver - Dep;
			// River off-takes from this unit (engine ≥ 1.14.0, docs/model.md §2.6a): from the flow leaving it,
			// by priority, above what must stay in the river (the senior users' requirement passing it, the
			// rule's hands-off flow and, when asked, the EWR here), up to each rule's capacity today (and its
			// share of the destination's need when sized to demand). Rules of one priority share the flow pro
			// rata to their limits, never leaving less than the most any of them may, so the list order never matters.
			let Xout = 0;
			const lv = otLevels[i];
			if (lv) {
				const U0 = U;
				for (const level of lv) {
					let freeMax = 0;
					let total = 0;
					for (const k of level) {
						const o = offtakes[k]!;
						const cap = o.capM3Day[month[t]!]!;
						if (!(cap > 0)) {
							otWant[k] = 0;
							continue;
						}
						const keep = Math.max(Zs, o.handsOffM3Day, o.handsOffEwr ? Z : 0);
						const free = Math.max(0, U0 - Xout - keep);
						const lim = o.sizing === 0 ? Math.min(cap, otShare[k]! / (1 - o.loss)) : cap;
						otWant[k] = Math.max(0, Math.min(free, lim));
						freeMax = Math.max(freeMax, free);
						total += otWant[k]!;
					}
					const scaleBy = total > freeMax ? freeMax / total : 1;
					for (const k of level) {
						const o = offtakes[k]!;
						const v = scaleBy < 1 ? otWant[k]! * scaleBy : otWant[k]!;
						otVol[k]![t] = v;
						Xout += v;
						const got = v * (1 - o.loss);
						otIn[o.to]! += got;
						if (o.topUpDam) otInDam[o.to]! += got;
					}
				}
				// The shares of a level can add up one ulp past the flow they split; the river never goes below 0.
				U = Math.max(0, U0 - Xout);
				r.offtakeOut![t] = Xout;
			}
			if (r.offtakeIn) r.offtakeIn[t] = Xin;
			r.groundwater[t] = Ggw;
			r.groundwaterToDam[t] = Gd;
			if (r.riverAbstraction) r.riverAbstraction[t] = Gr;
			// AA = MIN(U − Z, 0) and AB = MIN(AA − Σ upstream AA, 0), with float
			// noise of the volumes involved reported as 0 (review F8).
			const scale = Math.max(U, Z, absAA);
			const AA = shortfall(U, Z, scale);
			const AB = shortfall(AA, sumAA, scale);

			r.demand[t] = D;
			r.cropRequirement[t] = F;
			r.supplied[t] = G;
			r.inflowUpstream[t] = H;
			r.runoff[t] = I;
			r.transfer[t] = J;
			r.storage[t] = Q;
			r.spill[t] = Rr;
			r.outflow[t] = U;
			r.deficit[t] = D - G;
			r.ewr[t] = Y;
			r.ewrCumulative[t] = Z;
			r.ewrShortfall[t] = AA;
			r.ewrShortfallIncremental[t] = AB;
			r.seniorRequirement[t] = Zs;
			const w = work?.[i];
			if (w) {
				w.upstreamToDam[t] = K;
				w.upstreamBelowDam[t] = L;
				w.runoffToDam[t] = M;
				w.runoffBelowDam[t] = N;
				w.divertedToDam[t] = O;
				w.interimStorage[t] = P;
				w.belowDamNotDiverted[t] = S;
				w.returnFlow[t] = T;
				w.damArea[t] = A;
				w.damEvaporation[t] = E;
				w.rainOnDam[t] = Pd;
				w.damSeepage[t] = Sp;
				w.damSeepageLost[t] = SpLost;
				w.damRelease[t] = Rel;
				w.balanceResidual[t] =
					Xin > 0 || Xout > 0 ? H + I + J + Pd + Ggw + Gd + Xin - Xout - (G - T) - E - (Q - qPrev) - U - Dep - SpLost : H + I + J + Pd + Ggw + Gd - (G - T) - E - (Q - qPrev) - U - Dep - SpLost;
				w.passedForSenior[t] = passed;
				if (w.offtakeUsed) {
					w.offtakeUsed[t] = Xused;
					w.offtakeToDam![t] = XtoDam;
				}
			}
		}
	}
	if (opts.captureAt === days) captured = capture(days);
	return { nodes: res, transfers: trOut, ...(offtakes.length ? { offtakes: otVol } : {}), ...(work ? { workings: work } : {}), ...(captured ? { captured } : {}) };
}
