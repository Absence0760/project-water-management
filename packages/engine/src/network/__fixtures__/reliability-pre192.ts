// The assurance of supply as it was before issue #192 (engine 1.32.x, origin/main
// before 47e1ddb1), kept only as the reference reliability.bitIdentity.test.ts
// compares network/reliability.ts against: the workaround for the V8 miscompile
// (docs/engine-audit.md V1) must give the same figures to the bit. Never import
// it from app code.

// Assurance of supply, stress classes and the water account (engine ≥ 0.32.0,
// roadmap WP-3.4, docs/model.md §2.11a and §2.11b) → RunSummary.supplyAssurance.
//
// New outputs only: every figure here is read off the run's own daily series,
// so no result the engine had before changes.
//
// - Reliability per farm and per other water user over the reporting window
//   (settings.reportStart … reportEnd, the curtailment window): time-based
//   (share of demand days fully met), volumetric (Σ supplied / Σ demand) and
//   annual (share of complete water years whose supply ratio reaches a
//   threshold; engine ≥ 1.11.0 leaves part years out), by
//   water-year month and overall; resilience (mean length of a failure run)
//   and vulnerability (mean and largest deficit per failure run), after
//   Hashimoto, Stedinger & Loucks (1982).
// - Stress classes per farm (and for the whole system) × water-year month,
//   over the whole run, from the supply ratio: the thresholds of the
//   experimental node-based workbook (docs/model.md §4).
// - The water account per water year and over the run: what came into the
//   river network, what left it and how, the change in storage, and a closure
//   residual that is float noise; EWR required vs met at each EWR site.
import { monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from '../../calendar';
import { cmpStr } from '../../order';

/** Default of settings.assuranceAnnualThreshold: a project choice, not a standard. */
export const DEFAULT_ANNUAL_THRESHOLD = 0.9;

/**
 * A day's demand counts as fully met when the deficit is within this share of
 * the demand: supply = demand − (demand − surface) can differ from demand in
 * its last bit, and a residue is not a failure.
 */
const MET_NOISE = 1e-9;

export type StressClass = 'low' | 'moderate' | 'high' | 'severe' | 'critical';

/** Lower bounds of the supply ratio for each class but the last (docs/model.md §4, the node-based workbook). */
export const STRESS_THRESHOLDS: readonly { cls: StressClass; min: number }[] = [
	{ cls: 'low', min: 0.95 },
	{ cls: 'moderate', min: 0.85 },
	{ cls: 'high', min: 0.7 },
	{ cls: 'severe', min: 0.5 }
];

export const STRESS_LABEL: Record<StressClass, string> = {
	low: 'Low',
	moderate: 'Moderate',
	high: 'High',
	severe: 'Severe',
	critical: 'Critical'
};

/** The stress class of a supply ratio (supplied ÷ demand); null when there was no demand. */
export function stressClassOf(ratio: number | null): StressClass | null {
	if (ratio === null || !Number.isFinite(ratio)) return null;
	for (const t of STRESS_THRESHOLDS) if (ratio >= t.min) return t.cls;
	return 'critical';
}

/** One water-year month (Oct … Sep) of a demand node's reliability, pooled over the window's years. */
export interface ReliabilityMonth {
	/** Days in this calendar month inside the window with demand > 0. */
	demandDays: number;
	/** Of those, days whose demand was fully met. */
	metDays: number;
	demandM3: number;
	suppliedM3: number;
	/** metDays ÷ demandDays; null without demand days. */
	timeReliability: number | null;
	/** suppliedM3 ÷ demandM3; null without demand. */
	volumetricReliability: number | null;
}

/** Reliability of one farm or other water user over the reporting window. */
export interface SupplyReliability {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	demandM3: number;
	suppliedM3: number;
	/** Days in the window with demand > 0 (days without demand are neither met nor failed). */
	demandDays: number;
	/** Of those, days whose demand was fully met. */
	metDays: number;
	/** metDays ÷ demandDays: the share of demand days fully met; null without demand days. */
	timeReliability: number | null;
	/** Σ supplied ÷ Σ demand; null without demand. Equals the curtailment table's supplied ÷ demand. */
	volumetricReliability: number | null;
	/**
	 * Complete water years in the window (1 Oct … 30 Sep all inside it) with
	 * demand > 0: the years the annual measure counts. Up to engine 1.9.0 a
	 * part year at either end counted too.
	 */
	waterYears: number;
	/**
	 * Part water years at the window's ends with demand > 0, left out of the
	 * annual measure (engine ≥ 1.11.0, issue #46; absent on earlier runs, which
	 * counted them).
	 */
	partWaterYears?: number;
	/** Of those, years whose Σ supplied ÷ Σ demand reached the annual threshold. */
	waterYearsMet: number;
	/** waterYearsMet ÷ waterYears; null without a complete water year with demand. */
	annualReliability: number | null;
	/** Failure runs: consecutive demand days not fully met (a day without demand ends a run). */
	failureRuns: number;
	/** Resilience as the WP defines it: mean failure-run length in days; null without failures. Hashimoto's resilience is 1 ÷ this. */
	meanFailureDays: number | null;
	longestFailureDays: number;
	/** Vulnerability: mean Σ deficit per failure run (m³); null without failures. */
	meanFailureDeficitM3: number | null;
	/** Vulnerability: the largest Σ deficit of one failure run (m³); 0 without failures. */
	maxFailureDeficitM3: number;
	/** Water-year months, 0 = Oct … 11 = Sep. */
	months: ReliabilityMonth[];
}

/** One demand node's (or the system's) stress grid: water-year rows × Oct … Sep. */
export interface StressGrid {
	/** null = the whole system (every farm and other water user together). */
	nodeId: string | null;
	name: string;
	kind: 'farm' | 'user' | 'system';
	/** Σ supplied ÷ Σ demand in the month; null without demand (or outside the run). */
	ratio: (number | null)[][];
	/** The class of each ratio; null where the ratio is null. */
	stressClass: (StressClass | null)[][];
}

export interface StressSummary {
	/** Row labels: water years by the calendar year they start in. */
	waterYears: number[];
	/** Days simulated in each cell (0 outside the run). */
	days: number[][];
	thresholds: readonly { cls: StressClass; min: number }[];
	system: StressGrid;
	nodes: StressGrid[];
}

/** One EWR site's requirement and what reached it, over a water year or the run. */
export interface WaterAccountEwr {
	/** null = the outlet. */
	nodeId: string | null;
	name: string;
	requiredM3: number;
	/** Σ MIN(flow, requirement): the part of the requirement that passed. */
	metM3: number;
	daysNotMet: number;
	/** 'ruleTable' when the requirement is the site's Reserve rule table (engine ≥ 1.3.0, settings.ewrChargeSource); absent = the pragmatic EWR. */
	ewrSource?: 'ruleTable';
}

/**
 * The river network's account for one water year (or the run). Volumes in m³.
 * in − out − Δ storage = residual, float noise:
 *   in  = natural flow + rain on the dams + groundwater pumped + net transfers
 *   out = land-cover reduction + natural flow not allocated to a farm
 *       + consumptive irrigation + other users' consumptive use
 *       + dam evaporation + dam seepage lost from the catchment (WP-3.5)
 *       + stream depletion + river off-takes' conveyance losses (engine ≥ 1.14.0)
 *       + outflow at the outlet
 * A dam release (WP-3.5) joins the river below the dam, so it is already in
 * the outflow (or taken again downstream): a memo, not a term.
 */
export interface WaterAccountRow {
	/** Start year of the water year; null for the whole-run row. */
	waterYear: number | null;
	days: number;
	/** Memo: rain on the catchment (rain_final, × the areal factor with an areal rainfall correction, × area); null without rain or an area. */
	rainM3: number | null;
	/** Memo: rain − natural flow, what the catchment evaporated, stored or recharged; null with rainM3. */
	catchmentLossM3: number | null;
	naturalFlowM3: number;
	rainOnDamsM3: number;
	/** Groundwater pumped: to the crops and users, and (engine ≥ 0.36.0, WP-3.9) into the dams. */
	groundwaterM3: number;
	/**
	 * Storage set into (+) or out of (−) the dams by settings.damStorageReset
	 * (engine ≥ 0.46.0, the review triggers' members), an in term; present
	 * only on a run with the reset.
	 */
	storageSetM3?: number;
	/** Σ transfers in − out over all farms: 0 up to float noise (a transfer moves water inside the network). */
	transfersM3: number;
	inM3: number;
	/** Natural runoff removed by land cover (invasive plants, forestry) before it reached the farms. */
	landCoverM3: number;
	/** Natural flow no farm received: natural − Σ farm runoff − land cover (flow shares that don't sum to 1). */
	unallocatedM3: number;
	/** Irrigation that left the river: supplied − return flow (the crop's e·G plus losses that don't return). */
	consumptiveIrrigationM3: number;
	/** Other water users: taken − returned. */
	otherUseM3: number;
	damEvaporationM3: number;
	/**
	 * Dam seepage that leaves the catchment instead of returning below the dam
	 * (engine ≥ 0.35.0, WP-3.5). Absent on runs before 0.35.0, where all of it
	 * returned.
	 */
	damSeepageLostM3?: number;
	/** Taken from the river by the boreholes' lagged stream depletion. */
	streamDepletionM3: number;
	/** Lost on the way by river off-takes (engine ≥ 1.14.0): taken − delivered; present only on a run with off-takes. */
	conveyanceLossM3?: number;
	/** Simulated outflow at the outlet. */
	outflowM3: number;
	outM3: number;
	/**
	 * Memo, not a separate outflow: dam seepage that rejoins the river below
	 * each dam (all of it before engine 0.35.0; from 0.35.0 the lost share is
	 * `damSeepageLostM3` instead).
	 */
	damSeepageM3: number;
	/** Memo (engine ≥ 0.35.0, WP-3.5): released below the dams; it joins the river, so it is not an out term. */
	damReleaseM3?: number;
	/** Memo: irrigation supplied (consumptive + return flow). */
	irrigationSuppliedM3: number;
	openingStorageM3: number;
	closingStorageM3: number;
	storageChangeM3: number;
	/** in − out − Δ storage: float noise. */
	residualM3: number;
	/** Σ of every |term| the residual is made of; the residual is judged against it. */
	scaleM3: number;
	/** EWR required vs met: the outlet first, then gauges by node id. */
	ewr: WaterAccountEwr[];
}

export interface WaterAccount {
	/** Catchment area used for the rain memo (km²); null when unknown. */
	areaKm2: number | null;
	years: WaterAccountRow[];
	total: WaterAccountRow;
}

/** RunSummary.supplyAssurance (engine ≥ 0.32.0). */
export interface SupplyAssurance {
	/** The reporting window the reliability covers (the curtailment window). */
	reportStart: string;
	reportEnd: string;
	days: number;
	/** settings.assuranceAnnualThreshold as the run used it. */
	annualThreshold: number;
	/** Farms, then other water users, in network order. */
	reliability: SupplyReliability[];
	stress: StressSummary;
	waterAccount: WaterAccount;
}

/** A demand node's daily series. */
export interface DemandNodeInput {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	demand: ArrayLike<number>;
	supplied: ArrayLike<number>;
}

/** One node's daily series the account needs (all nodes, any kind). Missing = zeros. */
export interface AccountNodeInput {
	kind: 'farm' | 'gauge' | 'user';
	runoff: ArrayLike<number>;
	landCover: ArrayLike<number>;
	transfer: ArrayLike<number>;
	supplied: ArrayLike<number>;
	/** Farms: return flow T; users: their return. */
	returned: ArrayLike<number>;
	rainOnDam?: ArrayLike<number>;
	evaporation?: ArrayLike<number>;
	/** All the dam's seepage (returned + lost). */
	seepage?: ArrayLike<number>;
	/** The part of the seepage lost from the catchment (WP-3.5); missing = none. */
	seepageLost?: ArrayLike<number>;
	/** Released below the dam (WP-3.5); missing = none. */
	release?: ArrayLike<number>;
	/** Groundwater to the crop or user (part of supplied). */
	groundwater: ArrayLike<number>;
	/** Groundwater pumped into the farm dam (WP-3.9, engine ≥ 0.36.0); missing = none. */
	groundwaterToDam?: ArrayLike<number>;
	depletion: ArrayLike<number>;
	/** End-of-day storage. */
	storage: ArrayLike<number>;
	/** The storage reset's step on its day (settings.damStorageReset, engine ≥ 0.46.0); missing = none. */
	storageSet?: ArrayLike<number>;
	/** River off-takes (engine ≥ 1.14.0): taken from the flow leaving this node, and delivered into it; missing = none. */
	offtakeOut?: ArrayLike<number>;
	offtakeIn?: ArrayLike<number>;
	initialStorageM3: number;
}

export interface AccountSiteInput {
	nodeId: string | null;
	name: string;
	/** The requirement at the site, m³/day. */
	required: ArrayLike<number>;
	/** ≤ 0: the site's shortfall. */
	shortfall: ArrayLike<number>;
	/** 'ruleTable' when `required` follows the site's Reserve rule table (engine ≥ 1.3.0); absent = the pragmatic EWR. */
	ewrSource?: 'ruleTable';
}

export interface SupplyAssuranceInput {
	startDate: string;
	days: number;
	window: { from: number; to: number; reportStart: string; reportEnd: string };
	annualThreshold: number;
	demandNodes: DemandNodeInput[];
	/** Every node, in node-id order, so sums don't depend on the list order. */
	accountNodes: AccountNodeInput[];
	natural: ArrayLike<number>;
	outflow: ArrayLike<number>;
	/** Final catchment rain (mm), null entries for missing days; null without a rain series. */
	rainMm: ArrayLike<number | null> | null;
	areaKm2: number | null;
	sites: AccountSiteInput[];
}

/** -0 → 0. */
const nz = (x: number) => (x === 0 ? 0 : x);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Water-year row and month column of each day. */
function calendarOf(startDate: string, days: number) {
	const d0 = toEpochDay(startDate);
	const row = new Int32Array(days);
	const col = new Uint8Array(days);
	const wy0 = days > 0 ? waterYearOf(d0) : 0;
	const rows = days > 0 ? waterYearOf(d0 + days - 1) - wy0 + 1 : 0;
	const cellDays = Array.from({ length: rows }, () => new Array<number>(12).fill(0));
	for (let t = 0; t < days; t++) {
		row[t] = waterYearOf(d0 + t) - wy0;
		col[t] = waterYearIndex(monthOfEpochDay(d0 + t));
		cellDays[row[t]!]![col[t]!]!++;
	}
	return { row, col, rows, wy0, cellDays };
}

type Calendar = ReturnType<typeof calendarOf>;

/** Days in water year `wy` (1 Oct wy … 30 Sep wy + 1): 365 or 366. */
const waterYearLength = (wy: number) => (Date.UTC(wy + 1, 9, 1) - Date.UTC(wy, 9, 1)) / 86_400_000;

/** Is the day's demand fully met? */
const isMet = (d: number, g: number) => d - g <= MET_NOISE * d;

export function nodeReliability(n: DemandNodeInput, cal: Calendar, from: number, to: number, threshold: number): SupplyReliability {
	const months = Array.from({ length: 12 }, () => ({ demandDays: 0, metDays: 0, demandM3: 0, suppliedM3: 0 }));
	const years = new Map<number, { d: number; g: number; days: number }>();
	let demandM3 = 0;
	let suppliedM3 = 0;
	let demandDays = 0;
	let metDays = 0;
	let runs = 0;
	let runLen = 0;
	let runDef = 0;
	let totalRunDays = 0;
	let totalRunDef = 0;
	let longest = 0;
	let maxDef = 0;
	const endRun = () => {
		if (runLen === 0) return;
		runs++;
		totalRunDays += runLen;
		totalRunDef += runDef;
		longest = Math.max(longest, runLen);
		maxDef = Math.max(maxDef, runDef);
		runLen = 0;
		runDef = 0;
	};
	for (let t = from; t <= to; t++) {
		const d = n.demand[t]!;
		const g = n.supplied[t]!;
		demandM3 += d;
		suppliedM3 += g;
		const m = months[cal.col[t]!]!;
		m.demandM3 += d;
		m.suppliedM3 += g;
		const y = years.get(cal.row[t]!) ?? { d: 0, g: 0, days: 0 };
		y.d += d;
		y.g += g;
		y.days++;
		years.set(cal.row[t]!, y);
		if (!(d > 0)) {
			endRun();
			continue;
		}
		demandDays++;
		m.demandDays++;
		if (isMet(d, g)) {
			metDays++;
			m.metDays++;
			endRun();
		} else {
			runLen++;
			runDef += d - g;
		}
	}
	endRun();
	let wyCount = 0;
	let wyMet = 0;
	let wyPart = 0;
	for (const [row, y] of years) {
		if (!(y.d > 0)) continue;
		// Only a whole water year counts (engine ≥ 1.11.0): a part year at either end of the window would weigh a few months as a year.
		if (y.days < waterYearLength(cal.wy0 + row)) {
			wyPart++;
			continue;
		}
		wyCount++;
		if (y.g / y.d >= threshold) wyMet++;
	}
	return {
		nodeId: n.nodeId,
		name: n.name,
		kind: n.kind,
		demandM3: nz(demandM3),
		suppliedM3: nz(suppliedM3),
		demandDays,
		metDays,
		timeReliability: demandDays > 0 ? metDays / demandDays : null,
		volumetricReliability: ratio(suppliedM3, demandM3),
		waterYears: wyCount,
		partWaterYears: wyPart,
		waterYearsMet: wyMet,
		annualReliability: wyCount > 0 ? wyMet / wyCount : null,
		failureRuns: runs,
		meanFailureDays: runs > 0 ? totalRunDays / runs : null,
		longestFailureDays: longest,
		meanFailureDeficitM3: runs > 0 ? totalRunDef / runs : null,
		maxFailureDeficitM3: maxDef,
		months: months.map((m) => ({
			demandDays: m.demandDays,
			metDays: m.metDays,
			demandM3: nz(m.demandM3),
			suppliedM3: nz(m.suppliedM3),
			timeReliability: m.demandDays > 0 ? m.metDays / m.demandDays : null,
			volumetricReliability: ratio(m.suppliedM3, m.demandM3)
		}))
	};
}

function stressGrid(nodeId: string | null, name: string, kind: StressGrid['kind'], parts: DemandNodeInput[], cal: Calendar, days: number): StressGrid {
	const d = Array.from({ length: cal.rows }, () => new Array<number>(12).fill(0));
	const g = Array.from({ length: cal.rows }, () => new Array<number>(12).fill(0));
	for (const p of parts) {
		for (let t = 0; t < days; t++) {
			d[cal.row[t]!]![cal.col[t]!]! += p.demand[t]!;
			g[cal.row[t]!]![cal.col[t]!]! += p.supplied[t]!;
		}
	}
	const r = d.map((row, i) => row.map((v, j) => ratio(g[i]![j]!, v)));
	return { nodeId, name, kind, ratio: r, stressClass: r.map((row) => row.map(stressClassOf)) };
}

/** Days not met at a site: the day's own shortfall is below zero (as the EWR grid, model.md §2.9). */
function accountRow(x: SupplyAssuranceInput, cum: DailyTotals, waterYear: number | null, from: number, to: number): WaterAccountRow {
	const s = (a: Float64Array) => {
		let v = 0;
		for (let t = from; t <= to; t++) v += a[t]!;
		return v;
	};
	const natural = s(cum.natural);
	const rainOnDams = s(cum.rainOnDam);
	const groundwater = s(cum.groundwater);
	const transfers = s(cum.transfer);
	const storageSet = cum.storageSet ? s(cum.storageSet) : null;
	const landCover = s(cum.landCover);
	const unallocated = natural - s(cum.runoff) - landCover;
	const irrSupplied = s(cum.farmSupplied);
	const consumptive = irrSupplied - s(cum.farmReturned);
	const otherUse = s(cum.userSupplied) - s(cum.userReturned);
	const evap = s(cum.evaporation);
	const seepageLost = s(cum.seepageLost);
	const depletion = s(cum.depletion);
	const conveyance = cum.conveyance ? s(cum.conveyance) : null;
	const outflow = s(cum.outflow);
	const opening = from === 0 ? cum.initialStorage : cum.storage[from - 1]!;
	const closing = to < from ? opening : cum.storage[to]!;
	const inBase = natural + rainOnDams + groundwater + transfers;
	const inM3 = storageSet === null ? inBase : inBase + storageSet;
	const outBase = landCover + unallocated + consumptive + otherUse + evap + seepageLost + depletion + outflow;
	const outM3 = conveyance === null ? outBase : outBase + conveyance;
	const terms = [natural, rainOnDams, groundwater, transfers, ...(storageSet === null ? [] : [storageSet]), landCover, unallocated, consumptive, otherUse, evap, seepageLost, depletion, ...(conveyance === null ? [] : [conveyance]), outflow, opening, closing];
	let rainM3: number | null = null;
	if (x.rainMm && x.areaKm2 && x.areaKm2 > 0) {
		let mm = 0;
		let n = 0;
		for (let t = from; t <= to; t++) {
			const v = x.rainMm[t];
			if (v !== null && v !== undefined && Number.isFinite(v)) {
				mm += v;
				n++;
			}
		}
		// mm × km² = 1000 m³.
		if (n > 0) rainM3 = mm * x.areaKm2 * 1000;
	}
	return {
		waterYear,
		days: to - from + 1,
		rainM3,
		catchmentLossM3: rainM3 === null ? null : nz(rainM3 - natural),
		naturalFlowM3: nz(natural),
		rainOnDamsM3: nz(rainOnDams),
		groundwaterM3: nz(groundwater),
		...(storageSet !== null ? { storageSetM3: nz(storageSet) } : {}),
		transfersM3: nz(transfers),
		inM3: nz(inM3),
		landCoverM3: nz(landCover),
		unallocatedM3: nz(unallocated),
		consumptiveIrrigationM3: nz(consumptive),
		otherUseM3: nz(otherUse),
		damEvaporationM3: nz(evap),
		damSeepageLostM3: nz(seepageLost),
		streamDepletionM3: nz(depletion),
		...(conveyance !== null ? { conveyanceLossM3: nz(conveyance) } : {}),
		outflowM3: nz(outflow),
		outM3: nz(outM3),
		damSeepageM3: nz(s(cum.seepage) - seepageLost),
		damReleaseM3: nz(s(cum.release)),
		irrigationSuppliedM3: nz(irrSupplied),
		openingStorageM3: nz(opening),
		closingStorageM3: nz(closing),
		storageChangeM3: nz(closing - opening),
		residualM3: nz(inM3 - outM3 - (closing - opening)),
		scaleM3: terms.reduce((a, v) => a + Math.abs(v), 0),
		ewr: x.sites.map((site) => {
			let req = 0;
			let met = 0;
			let notMet = 0;
			for (let t = from; t <= to; t++) {
				const r = site.required[t]!;
				const sh = site.shortfall[t]!;
				req += r;
				met += r + Math.min(sh, 0);
				if (sh < 0) notMet++;
			}
			return { nodeId: site.nodeId, name: site.name, requiredM3: nz(req), metM3: nz(met), daysNotMet: notMet, ...(site.ewrSource ? { ewrSource: site.ewrSource } : {}) };
		})
	};
}

/**
 * Each account term summed over nodes per day, in the order given (node id).
 * Rows sum these over their days; a prefix sum would carry the whole run's
 * rounding into a dry year's small totals (fuzz seed 1486: a 3e-9 m³ residual
 * on a 5 m³ year).
 */
interface DailyTotals {
	natural: Float64Array;
	runoff: Float64Array;
	landCover: Float64Array;
	transfer: Float64Array;
	farmSupplied: Float64Array;
	farmReturned: Float64Array;
	userSupplied: Float64Array;
	userReturned: Float64Array;
	rainOnDam: Float64Array;
	evaporation: Float64Array;
	seepage: Float64Array;
	seepageLost: Float64Array;
	release: Float64Array;
	groundwater: Float64Array;
	depletion: Float64Array;
	outflow: Float64Array;
	/** End-of-day storage over all nodes (not a prefix sum). */
	storage: Float64Array;
	/** The storage reset's steps over all nodes; null without one (engine ≥ 0.46.0). */
	storageSet: Float64Array | null;
	/** River off-takes' conveyance losses (taken − delivered) over all nodes; null without off-takes (engine ≥ 1.14.0). */
	conveyance: Float64Array | null;
	initialStorage: number;
}

function dailyTotals(x: SupplyAssuranceInput): DailyTotals {
	const { days } = x;
	const keys = ['natural', 'runoff', 'landCover', 'transfer', 'farmSupplied', 'farmReturned', 'userSupplied', 'userReturned', 'rainOnDam', 'evaporation', 'seepage', 'seepageLost', 'release', 'groundwater', 'depletion', 'outflow'] as const;
	const c = Object.fromEntries(keys.map((k) => [k, new Float64Array(days)])) as unknown as DailyTotals;
	c.storage = new Float64Array(days);
	c.storageSet = x.accountNodes.some((n) => n.storageSet) ? new Float64Array(days) : null;
	c.conveyance = x.accountNodes.some((n) => n.offtakeOut) ? new Float64Array(days) : null;
	c.initialStorage = x.accountNodes.reduce((a, n) => a + n.initialStorageM3, 0);
	// Node by node, each over every day: a day's total still adds the nodes in
	// the list's (node-id) order, starting from 0, so every total is the same
	// float as summing the day's nodes in turn; a column at a time avoids a
	// keyed read and write per term per day (~5 ms a run on an example).
	const add = (into: Float64Array, a: ArrayLike<number>) => {
		for (let t = 0; t < days; t++) into[t] = into[t]! + a[t]!;
	};
	// A missing optional series adds 0, which leaves a total unchanged (a total starts at +0, so it is never -0).
	const addOptional = (into: Float64Array, a: ArrayLike<number> | undefined) => {
		if (a) for (let t = 0; t < days; t++) into[t] = into[t]! + (a[t] ?? 0);
	};
	for (let t = 0; t < days; t++) {
		c.natural[t] = x.natural[t]!;
		c.outflow[t] = x.outflow[t]!;
	}
	for (const n of x.accountNodes) {
		add(c.runoff, n.runoff);
		add(c.landCover, n.landCover);
		add(c.transfer, n.transfer);
		if (n.kind === 'farm') {
			add(c.farmSupplied, n.supplied);
			add(c.farmReturned, n.returned);
		} else if (n.kind === 'user') {
			add(c.userSupplied, n.supplied);
			add(c.userReturned, n.returned);
		}
		addOptional(c.rainOnDam, n.rainOnDam);
		addOptional(c.evaporation, n.evaporation);
		addOptional(c.seepage, n.seepage);
		addOptional(c.seepageLost, n.seepageLost);
		addOptional(c.release, n.release);
		// Groundwater into supply and (WP-3.9) into the dam: both come into the network.
		const gw = n.groundwater;
		const gwDam = n.groundwaterToDam;
		for (let t = 0; t < days; t++) c.groundwater[t] = c.groundwater[t]! + (gw[t]! + (gwDam?.[t] ?? 0));
		add(c.depletion, n.depletion);
		add(c.storage, n.storage);
		if (c.storageSet) addOptional(c.storageSet, n.storageSet);
		if (c.conveyance) {
			const o = n.offtakeOut;
			const d = n.offtakeIn;
			if (o) for (let t = 0; t < days; t++) c.conveyance[t] = c.conveyance[t]! + o[t]!;
			if (d) for (let t = 0; t < days; t++) c.conveyance[t] = c.conveyance[t]! - d[t]!;
		}
	}
	return c;
}

export function waterAccount(x: SupplyAssuranceInput, cal: Calendar = calendarOf(x.startDate, x.days)): WaterAccount {
	const cum = dailyTotals(x);
	const years: WaterAccountRow[] = [];
	let from = 0;
	for (let t = 1; t <= x.days; t++) {
		if (t === x.days || cal.row[t] !== cal.row[from]) {
			years.push(accountRow(x, cum, cal.wy0 + cal.row[from]!, from, t - 1));
			from = t;
		}
	}
	const total = accountRow(x, cum, null, 0, x.days - 1);
	return { areaKm2: x.areaKm2 && x.areaKm2 > 0 ? x.areaKm2 : null, years, total };
}

export function supplyAssurance(x: SupplyAssuranceInput): SupplyAssurance {
	const cal = calendarOf(x.startDate, x.days);
	const { from, to } = x.window;
	const threshold = x.annualThreshold;
	return {
		reportStart: x.window.reportStart,
		reportEnd: x.window.reportEnd,
		days: to - from + 1,
		annualThreshold: threshold,
		reliability: x.demandNodes.map((n) => nodeReliability(n, cal, from, to, threshold)),
		stress: {
			waterYears: Array.from({ length: cal.rows }, (_, i) => cal.wy0 + i),
			days: cal.cellDays,
			thresholds: STRESS_THRESHOLDS,
			// Summed in node-id order, so the system's ratios don't depend on the list order.
			system: stressGrid(null, 'All demand', 'system', [...x.demandNodes].sort((a, b) => cmpStr(a.nodeId, b.nodeId)), cal, x.days),
			nodes: x.demandNodes.map((n) => stressGrid(n.nodeId, n.name, n.kind, [n], cal, x.days))
		},
		waterAccount: waterAccount(x, cal)
	};
}
