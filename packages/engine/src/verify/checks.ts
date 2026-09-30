// Physical invariants of a model run. runModel runs them on every run and
// reports the result in summary.verification (./verify.ts); the random-network
// fuzz tests (../run.invariants.test.ts), the example catchments (backend) and
// the client catchment (when data/ is present) assert them. Each check returns the first broken
// property as text, or null. They state what must hold for *any* sound water
// balance (mass conservation, bounds, limits honoured, totals that add up),
// not what the workbook happens to produce, so they stay valid when the
// algorithms change. See docs/model.md §6 "Verification".
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from '../calendar';
import { compareAllocations, DEFAULT_ALLOCATION_TOLERANCE } from '../allocations/compare';
import { ALLOCATION_SERIES, dailyLimits, limitBoundKind, matchAllocations, outsideMonths, registeredOver, resolveAllocationMode, yearBudgets } from '../allocations/mode';
import { excludedDayMask, exclusionRanges, sanitizeExclusions } from '../calibrate/provenance';
import { boreholeOf, boreholesByNode, type PlanBorehole } from '../network/boreholes';
import { curveAreaAt, fixedReleaseFloor, resolveDamCurve, resolveRelease } from '../network/dam';
import { abstractionStartDay, capacityScaleOf, DAM_CAPACITY_SERIES } from '../network/development';
import { landCoverReduction, lowFlowThreshold, resolveLandCover } from '../network/landcover';
import { flowShares } from '../network/shares';
import { EWR_BINDING_SERIES } from '../network/bindingSeries';
import { canMove, farmRules, readRuleVolumes, transferRuleKey } from '../network/transferSeries';
import { transferActiveMonths, transferDailyLimit } from '../network/transferRates';
import { isRiverOfftake, offtakeOf, offtakeReturnAt } from '../network/offtake';
import { cmpStr } from '../order';
import { divertCapacityToday, handsOffToday, operatingOf, supplyOf, type PlanSupply } from '../network/supply';
import { BASIC_NEEDS_SERIES, basicNeedsM3Day, dayFloor, demandObjectsByNode, objectDemandKey, objectMonthlyM3Day, objectReturnShare, objectSuppliedKey, PRIORITY_TIER } from '../network/demandObjects';
import { scheduleFactors } from '../network/demandSchedule';
import { resolveDroughtRestriction, restrictionCutKey, RESTRICTION_SERIES } from '../network/restriction';
import { dailyDemandFactor, damWorkings, lakeEvaporationMmDay, runEfficiency } from './workings';
import { DEMAND_PARTS, defaultProjectSettings, type AllocationLimitBound, type CurtailmentFarm, type DemandObject, type DemandPart, type DroughtRestrictionRule, type EwrComplianceGrid, type ModelInput, type ModelOutput, type NetworkNode, type Transfer } from '../project';
import { RAIN_SOURCE_CODE, RAIN_SOURCE_COLUMN } from '../rainSourcePeriods';
import { FLOW_DAY_FLAGS, FLOW_QUALITY_COLUMN } from '../calibrate/dayFlags';
import { resolveQualityFlags } from '../calibrate/qualityFlagSettings';
import { FLOW_FILL_COLUMNS } from '../flowGapFill';

const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);

type SeriesMap = Map<string, number[]>;
const seriesMap = (out: ModelOutput): SeriesMap => new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));

/**
 * Daily balance identities and bounds, every node, every day:
 * - every value finite (observed flow may be NaN on missing days, the Reserve
 *   rule requirement outside complete months);
 * - routed inflow = Σ upstream outflow (gauges pass it through);
 * - farm balance H + I + J + rain on dam + Q[t−1] = U + G − T + evaporation
 *   + Q (T = return flow β·(1 − e)·G, audit N1; rain on the dam and
 *   evaporation from it, audit N2; seepage is part of U, less the share lost
 *   from the catchment, WP-3.5, which is a loss here), each loss ≥ 0;
 * - 0 ≤ storage ≤ capacity, spill only from a full dam, 0 ≤ supplied ≤ demand,
 *   deficit = demand − supplied, EWR shortfall = MIN(U − Z, 0) ≤ 0;
 * - transfers net to zero across farms each day;
 * - the catchment balance closes over the run: opening storage + runoff =
 *   outflow + consumptive use + closing storage.
 */
// ewr_rule (engine ≥ 0.21.0) is NaN outside complete calendar months: a part
// month at either end of the run is not assessed against the Reserve rules.
// ewr_binding_site (engine ≥ 1.5.0) is NaN on a day the farm isn't charged: no site set a charge.
// rain_areal (engine ≥ 1.13.0) is rain_final × the areal factor, so NaN where rain_final is.
// rain_source (every run with rain from engine 1.27.0) is NaN where no source has a value, as rain_final is.
// observed_flow_filled / observed_flow_other_filled (engine ≥ 1.23.0) are NaN on every day the gap fill didn't fill.
// rain_chirps_mapped (engine ≥ 1.53.0, the CHIRPS gap map) is NaN where rain_chirps_corrected is (checkChirpsGapMap).
const GAPPY_SERIES = new Set(['observed_flow', 'observed_flow_other', FLOW_FILL_COLUMNS.observed_flow.values.key, FLOW_FILL_COLUMNS.observed_flow_other.values.key, 'rain_final', 'rain_areal', 'rain_source', 'rain_chirps', 'rain_chirps_corrected', 'rain_chirps_mapped', 'chirps_factor', 'ewr_rule', 'ewr_binding_site']);

/**
 * A unit's enabled demand objects (engine ≥ 1.7.0) as the run stored them:
 * each one's demand and supply series, return share and priority class; null
 * for a unit without any, an error when a series is missing.
 */
interface ObjectColumns {
	demand: number[][];
	supplied: number[][];
	returnShare: number[];
	tier: number[];
	monthly: Float64Array[];
	/** Each object's schedule factor per day (engine ≥ 1.17.0), recomputed from the model; null without one. */
	schedule: (Float64Array | null)[];
	/** Each object's basic-needs floor (engine ≥ 1.44.0), recomputed from the model; null without one. */
	floor: (number | null)[];
	/** Each object's category, for its part's demand factor (engine ≥ 1.45.0). */
	category: DemandObject['category'][];
}
function objectColumns(input: ModelInput, n: NetworkNode, get: SeriesMap, run: Pick<ModelOutput, 'startDate' | 'days'>): ObjectColumns | string | null {
	const list = demandObjectsByNode(input.model, []).get(n.id);
	if (!list) return null;
	const out: ObjectColumns = { demand: [], supplied: [], returnShare: [], tier: [], monthly: [], schedule: [], floor: [], category: [] };
	for (const o of list) {
		const d = get.get(`${n.id}|${objectDemandKey(o.id)}`);
		const g = get.get(`${n.id}|${objectSuppliedKey(o.id)}`);
		if (!d || !g) return `${n.id}: demand object ${o.id} has no ${d ? 'supplied' : 'demand'} series`;
		out.demand.push(d);
		out.supplied.push(g);
		out.returnShare.push(objectReturnShare(o));
		out.tier.push(PRIORITY_TIER[o.priority] ?? 1);
		out.monthly.push(objectMonthlyM3Day(o, []));
		out.schedule.push(scheduleFactors(o.schedule, toEpochDay(run.startDate), run.days, [], ''));
		out.floor.push(basicNeedsM3Day(o));
		out.category.push(o.category);
	}
	return out;
}

/** Return flow of a unit on day t: β(1 − e) × what its crops got + Σ each object's return share × what it got. */
function unitReturn(G: number, returnPerSupplied: number, objs: ObjectColumns | null, t: number): number {
	if (!objs) return G * returnPerSupplied;
	let got = 0;
	let back = 0;
	for (let k = 0; k < objs.supplied.length; k++) {
		got += objs.supplied[k]![t]!;
		back += objs.returnShare[k]! * objs.supplied[k]![t]!;
	}
	return (G - got) * returnPerSupplied + back;
}

/**
 * The `rain_source` column (every run with rain from engine 1.27.0) against
 * `rain_final`: blank on exactly the days rain_final is, and without
 * rain-source periods only catchment, CHIRPS or forecast, the fall-through
 * order both are built with (rainSourceCodes, reference/wr2012.ts runRain).
 */
export function checkRainSource(out: ModelOutput): string | null {
	const final = out.series.find((s) => s.nodeId === null && s.key === 'rain_final')?.values;
	const source = out.series.find((s) => s.nodeId === null && s.key === RAIN_SOURCE_COLUMN.key)?.values;
	if (!final || !source) return null;
	if (source.length !== final.length) return `rain_source has ${source.length} days, rain_final ${final.length}`;
	const periods = (out.summary.rainSource?.periods.length ?? 0) > 0;
	const plain: readonly number[] = [RAIN_SOURCE_CODE.catchment, RAIN_SOURCE_CODE.chirps, RAIN_SOURCE_CODE.forecast];
	for (let t = 0; t < final.length; t++) {
		const v = source[t]!;
		if (Number.isNaN(v) !== Number.isNaN(final[t]!)) return `rain_source[${t}] is ${v} where rain_final is ${final[t]}`;
		if (!periods && !Number.isNaN(v) && !plain.includes(v)) return `rain_source[${t}] is ${v} in a run without rain-source periods`;
	}
	return null;
}

/**
 * The CHIRPS gap map's column (engine ≥ 1.53.0, CR-23) against
 * `rain_chirps_corrected`: blank on exactly the same days, never below 0
 * where CHIRPS isn't, and over every calendar month the run holds whole,
 * the same total: the map moves rain between a month's days, never in or
 * out of the month (docs/model.md §2.4b *Quantile map*). And the rain the
 * run used on a day CHIRPS filled (`rain_source` 2, `rain_final`) is the
 * column's value: the fill and the column come from separate calls.
 */
export function checkChirpsGapMap(out: ModelOutput): string | null {
	const mapped = out.series.find((s) => s.nodeId === null && s.key === 'rain_chirps_mapped')?.values;
	const corrected = out.series.find((s) => s.nodeId === null && s.key === 'rain_chirps_corrected')?.values;
	if (!mapped) return null;
	if (!corrected || corrected.length !== mapped.length) return 'rain_chirps_mapped without a rain_chirps_corrected of the same length';
	const d0 = toEpochDay(out.startDate);
	let month = -1;
	let from = 0;
	let a = 0;
	let b = 0;
	const close = (t: number): string | null => {
		// A month is whole when it starts on the 1st inside the run and its last day (t − 1) is the month's last.
		const whole = (from > 0 || monthOfEpochDay(d0 - 1) !== month) && monthOfEpochDay(d0 + t) !== month;
		if (whole && Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) return `rain_chirps_mapped totals ${a} over days ${from}–${t - 1}, the corrected CHIRPS ${b}`;
		return null;
	};
	const final = out.series.find((s) => s.nodeId === null && s.key === 'rain_final')?.values;
	const source = out.series.find((s) => s.nodeId === null && s.key === RAIN_SOURCE_COLUMN.key)?.values;
	if (final && source) {
		for (let t = 0; t < mapped.length; t++) {
			if (source[t] === RAIN_SOURCE_CODE.chirps && final[t] !== mapped[t]) return `rain_final[${t}] is ${final[t]} on a CHIRPS day, rain_chirps_mapped ${mapped[t]}`;
		}
	}
	for (let t = 0; t < mapped.length; t++) {
		const x = mapped[t]!;
		const y = corrected[t]!;
		if (Number.isNaN(x) !== Number.isNaN(y)) return `rain_chirps_mapped[${t}] is ${x} where rain_chirps_corrected is ${y}`;
		if (x < 0 && !(y < 0)) return `rain_chirps_mapped[${t}] is ${x}`;
		const m = monthOfEpochDay(d0 + t);
		if (m !== month) {
			if (month !== -1) {
				const bad = close(t);
				if (bad) return bad;
			}
			month = m;
			from = t;
			a = 0;
			b = 0;
		}
		if (!Number.isNaN(x)) {
			a += x;
			b += y;
		}
	}
	return month === -1 ? null : close(mapped.length);
}

/**
 * The `observed_flow_quality` column (engine ≥ 1.48.0, ../calibrate/dayFlags.ts
 * recordFlowFlags) against the record it flags: stored once, beside the
 * scored `observed_flow` (the calibration site's node, else the catchment's),
 * as many days long, each day a class code; missing exactly where the record
 * has no reading and no gap fill, infilled exactly on the filled days, and
 * the gauged-range classes agreeing with the record's rating (settings
 * .qualityFlags; a gauge inside the network has none, and no fill). Human
 * use is never set. A run with filled days stores the column (they are
 * flagged). A column with no flagged day is allowed: a run resumed from a
 * snapshot keeps its capture run's column whatever its own days hold.
 */
export function checkFlowQuality(input: ModelInput, out: ModelOutput): string | null {
	const cols = out.series.filter((s) => s.key === FLOW_QUALITY_COLUMN.key);
	const site = out.summary.calibration?.siteNodeId ?? null;
	const fillCode = out.series.find((s) => s.nodeId === site && s.key === FLOW_FILL_COLUMNS.observed_flow.code.key)?.values;
	if (!cols.length) {
		if (out.summary.calibration && fillCode?.some((v) => v !== 0)) return `the scored record has gap-filled days but no ${FLOW_QUALITY_COLUMN.key} column`;
		return null;
	}
	if (cols.length > 1) return `${cols.length} ${FLOW_QUALITY_COLUMN.key} columns; one is stored, beside the scored record`;
	const q = cols[0]!;
	if (q.nodeId !== site) return `${FLOW_QUALITY_COLUMN.key} is stored at ${q.nodeId ?? 'the catchment'}, but the run scores ${site ?? 'the outlet'}`;
	const obsCol = out.series.find((s) => s.nodeId === site && s.key === 'observed_flow');
	if (!obsCol) return `${FLOW_QUALITY_COLUMN.key} has no observed_flow beside it`;
	const obs = obsCol.values;
	if (q.values.length !== obs.length) return `${FLOW_QUALITY_COLUMN.key} has ${q.values.length} days, observed_flow ${obs.length}`;
	// The scored record's kind (summary.calibration is set whenever the column is).
	const kind = out.summary.calibration?.flowKind;
	const rating = site === null && kind ? resolveQualityFlags(input.settings.qualityFlags).ratings[kind] : undefined;
	const hi = rating?.gaugedMaxM3s ?? null;
	const lo = rating?.gaugedMinM3s ?? null;
	const SEC = 86_400;
	for (let t = 0; t < obs.length; t++) {
		const c = q.values[t]!;
		const f = FLOW_DAY_FLAGS[c];
		if (!Number.isInteger(c) || !f) return `${FLOW_QUALITY_COLUMN.key}[day ${t}] is ${c}, not a class code`;
		if (f === 'humanUse') return `${FLOW_QUALITY_COLUMN.key}[day ${t}] is human use, which no run sets`;
		const filled = !!fillCode?.[t];
		const reading = Number.isFinite(obs[t]!);
		if ((f === 'infilled') !== filled) return `${FLOW_QUALITY_COLUMN.key}[day ${t}] is ${f} where the gap fill ${filled ? 'filled the day' : 'filled nothing'}`;
		if (!filled && (f === 'missing') === reading) return `${FLOW_QUALITY_COLUMN.key}[day ${t}] is ${f} where observed_flow is ${obs[t]}`;
		if (!reading) continue;
		const m3s = obs[t]! / SEC;
		const above = hi !== null && m3s > hi * (1 + 1e-12);
		if (f === 'aboveRating' && (hi === null || m3s <= hi * (1 - 1e-12))) return `day ${t} is flagged above the highest gauging, but reads ${m3s} m³/s (highest gauging ${hi ?? 'none'})`;
		if (f === 'belowRating' && (lo === null || !(m3s > 0) || m3s >= lo * (1 + 1e-12))) return `day ${t} is flagged below the lowest gauging, but reads ${m3s} m³/s (lowest gauging ${lo ?? 'none'})`;
		if (f === 'inRange' && (above || (lo !== null && m3s > 0 && m3s < lo * (1 - 1e-12))))
			return `day ${t} reads ${m3s} m³/s, outside the gauged range ${lo ?? '0'} … ${hi ?? '∞'} m³/s, but is flagged in range`;
	}
	return null;
}

export function checkBalance(input: ModelInput, out: ModelOutput): string | null {
	const bores = boreholesByNode(input.model, []);
	const get = seriesMap(out);
	for (const s of out.series) {
		// Inputs shown as they are: a missing day is NaN (a gap), never a made-up value.
		if (GAPPY_SERIES.has(s.key)) continue;
		for (let t = 0; t < s.values.length; t++) {
			if (!Number.isFinite(s.values[t]!)) return `${s.nodeId}/${s.key}[${t}] is ${s.values[t]}`;
		}
	}
	const rainSourceProblem = checkRainSource(out);
	if (rainSourceProblem) return rainSourceProblem;
	const gapMapProblem = checkChirpsGapMap(out);
	if (gapMapProblem) return gapMapProblem;
	const flowQualityProblem = checkFlowQuality(input, out);
	if (flowQualityProblem) return flowQualityProblem;
	const nodes = input.model.nodes;
	const outlet = nodes.find((n) => n.downstreamNodeId === null)!;
	let totIn = 0;
	let totOut = 0;
	for (const n of nodes) {
		const ups = nodes.filter((u) => u.downstreamNodeId === n.id);
		const U = get.get(`${n.id}|outflow`)!;
		// Series looked up once per node, not per day: this runs on every saved run.
		const upU = ups.map((u) => get.get(`${u.id}|outflow`)!);
		const upAAs = ups.map((u) => get.get(`${u.id}|ewr_shortfall`)!);
		const routed = n.kind === 'gauge' ? U : get.get(`${n.id}|inflow_upstream`)!;
		for (let t = 0; t < out.days; t++) {
			let H = 0;
			for (const a of upU) H += a[t]!;
			if (Math.abs(routed[t]! - H) > tol(H))
				return `${n.id} day ${t}: routed inflow ${H} ≠ upstream sum`;
		}
		if (n.kind === 'gauge') continue;
		if (n.kind === 'user') {
			const bad = checkUserDay(n, bores.get(n.id) ?? [], toEpochDay(out.startDate), get, ups.map((u) => u.id), out.days);
			if (bad) return bad;
			const G = get.get(`${n.id}|supplied`)!;
			const T = get.get(`${n.id}|return_flow`)!;
			const GW = get.get(`${n.id}|groundwater_used`);
			const DEP = get.get(`${n.id}|baseflow_depletion`);
			for (let t = 0; t < out.days; t++) {
				totOut += G[t]! - T[t]! + (DEP?.[t] ?? 0);
				totIn += GW?.[t] ?? 0;
			}
			continue;
		}
		const g = (k: string) => get.get(`${n.id}|${k}`)!;
		const [F, G, W, H, I, J, Q, R, AA, Z, ABs] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_cumulative', 'ewr_shortfall_incremental'].map(g) as number[][];
		// The engine keeps full precision (docs/engine-audit.md R1): no rounding here either.
		const cap = n.damCapacityM3;
		// A dam whose capacity changes (engine ≥ 1.30.0) starts at its share of the first day's capacity.
		const ks = capacityScaleOf(n, toEpochDay(out.startDate), out.days, []);
		let qPrev = n.damInitialPct * cap * (ks?.[0] ?? 1);
		totIn += qPrev;
		// Return flow: the share β of the application losses (1 − e)·G (audit N1),
		// of the crops' part when the unit has demand objects, which return their own shares (engine ≥ 1.7.0).
		const returnPerSupplied = n.lossReturnFraction * (1 - runEfficiency(input, n));
		const objs = objectColumns(input, n, get, out);
		if (typeof objs === 'string') return objs;
		// Rain on the dam and evaporation from it (audit N2); runs before engine 0.16.0 have neither.
		const Pd = get.get(`${n.id}|rain_on_dam`);
		const Ev = get.get(`${n.id}|dam_evaporation`);
		const Sp = get.get(`${n.id}|dam_seepage`);
		// Seepage lost from the catchment (WP-3.5): present only when a share of it is.
		const SPL = get.get(`${n.id}|dam_seepage_lost`);
		// Boreholes (WP-1.34, WP-3.9): groundwater comes in with the supply and into the dam, stream depletion leaves with the river.
		const GW = get.get(`${n.id}|groundwater_used`);
		const GD = get.get(`${n.id}|groundwater_to_dam`);
		const DEP = get.get(`${n.id}|baseflow_depletion`);
		// The storage reset (engine ≥ 0.46.0): its step starts the day, an input to the balance.
		const SET = get.get(`${n.id}|dam_storage_set`);
		// River off-takes (engine ≥ 1.14.0): delivered in, taken out of the flow leaving the unit.
		const XIN = get.get(`${n.id}|offtake_in`);
		const XOUT = get.get(`${n.id}|offtake_out`);
		// Their conveyance losses seeping back to the river below this unit (engine ≥ 1.42.0), part of its outflow.
		const XRET = get.get(`${n.id}|offtake_loss_return`);
		for (let t = 0; t < out.days; t++) {
			if (SET) {
				qPrev += SET[t]!;
				totIn += SET[t]!;
			}
			const xin = XIN?.[t] ?? 0;
			const xout = XOUT?.[t] ?? 0;
			const xret = XRET?.[t] ?? 0;
			if (xin < 0 || xout < 0 || xret < 0) return `${n.id} day ${t}: river off-take in ${xin} / out ${xout} / seepage returned ${xret} must be ≥ 0`;
			const T = unitReturn(G![t]!, returnPerSupplied, objs, t);
			const pd = Pd?.[t] ?? 0;
			const ev = Ev?.[t] ?? 0;
			const gw = (GW?.[t] ?? 0) + (GD?.[t] ?? 0);
			const dep = DEP?.[t] ?? 0;
			const spl = SPL?.[t] ?? 0;
			const lhs = H![t]! + I![t]! + J![t]! + qPrev + pd + gw + xin + xret;
			const rhs = U[t]! + G![t]! - T + Q![t]! + ev + dep + spl + xout;
			const where = `${n.id} day ${t}`;
			if (Math.abs(lhs - rhs) > tol(lhs)) return `${where}: farm balance ${lhs} ≠ ${rhs}`;
			if (spl < 0 || spl > (Sp?.[t] ?? 0) + tol(spl)) return `${where}: seepage lost ${spl} outside [0, seepage ${Sp?.[t]}]`;
			if (pd < 0 || ev < 0 || (Sp?.[t] ?? 0) < 0) return `${where}: rain on dam ${pd}, evaporation ${ev} and seepage ${Sp?.[t]} must be ≥ 0`;
			const capT = ks ? cap * ks[t]! : cap;
			if (Q![t]! < -1e-9 || Q![t]! > capT + 1e-9) return `${where}: storage ${Q![t]} outside [0, ${capT}]`;
			if (R![t]! < 0 || (R![t]! > 0 && Math.abs(Q![t]! - capT) > 1e-9)) return `${where}: spill ${R![t]} with storage ${Q![t]}/${capT}`;
			if (G![t]! > F![t]! + 1e-9) return `${where}: supplied ${G![t]} > demand ${F![t]}`;
			if (G![t]! < -1e-9) return `${where}: supplied ${G![t]} < 0`;
			if (Math.abs(W![t]! - (F![t]! - G![t]!)) > 1e-9) return `${where}: deficit ≠ demand − supplied`;
			// The engine reports float noise below 1e-12 of the volumes as no shortfall (review F8).
			const noise = 1e-12 * Math.max(Math.abs(U[t]!), Math.abs(Z![t]!));
			if (AA![t]! > 0 || Math.abs(AA![t]! - Math.min(U[t]! - Z![t]!, 0)) > tol(U[t]!) + noise) return `${where}: EWR shortfall ${AA![t]}`;
			let upAA = 0;
			let upAbs = 0;
			for (const a of upAAs) {
				upAA += a[t]!;
				upAbs += Math.abs(a[t]!);
			}
			const AB = ABs![t]!;
			const abNoise = noise + 1e-12 * upAbs;
			if (AB > 0 || Math.abs(AB - Math.min(AA![t]! - upAA, 0)) > tol(upAA) + abNoise) return `${where}: incremental EWR shortfall ${AB} ≠ MIN(${AA![t]} − ${upAA}, 0)`;
			totIn += I![t]! + pd + gw + xin + xret;
			totOut += G![t]! - T + ev + dep + spl + xout;
			qPrev = Q![t]!;
		}
		totOut += qPrev;
	}
	const sim = get.get('null|simulated_outflow')!;
	const outletU = get.get(`${outlet.id}|outflow`)!;
	const farmJ = nodes.filter((n) => n.kind === 'farm').map((n) => get.get(`${n.id}|transfer`)!);
	const catEwr = get.get('null|ewr')!;
	const catShort = get.get('null|ewr_shortfall')!;
	for (let t = 0; t < out.days; t++) {
		if (sim[t] !== outletU[t]) return `day ${t}: simulated outflow ≠ outlet node outflow`;
		totOut += sim[t]!;
		let Jsum = 0;
		for (const a of farmJ) Jsum += a[t]!;
		if (Math.abs(Jsum) > 1e-6) return `day ${t}: transfers do not net to 0 (${Jsum})`;
		const e = catEwr[t]!;
		const sh = catShort[t]!;
		if (sh > 0 || Math.abs(sh - Math.min(sim[t]! - e, 0)) > 1e-12 * Math.max(Math.abs(sim[t]!), Math.abs(e))) return `day ${t}: catchment EWR shortfall ${sh}`;
	}
	if (Math.abs(totIn - totOut) > 1e-6 * Math.max(1, totIn)) return `catchment mass balance: in ${totIn} ≠ out ${totOut}`;
	return null;
}

/**
 * The checks' own replay of a node's borehole supply order (WP-1.34, WP-3.9,
 * docs/model.md §2.7d), from the day's published columns: primary units to
 * the crop first, then the units that pump into the dam (primary fill it,
 * supplemental add what it lacks for the demand left, emergency fill it while
 * triggered; primary and emergency only on a day with demand left for the dam;
 * never above capacity), then the dam and river, then supplemental
 * and triggered emergency units. Each unit pumps at most MIN(capacity, its
 * annual cap − what it pumped since 1 October). A farm's river pump (WP-3.8,
 * `river` what it may take today) is part of the surface: before the dam
 * under rules 1 and 2, after it under run of river (rule 3); a supplemental
 * dam-target unit fills only for the demand the river leaves. Under an
 * allocation cap (engine ≥ 1.18.0) the surface gives at most `sRoom` and the
 * units together pump at most `gRoom` (the day's allocation_room columns;
 * Infinity without a cap). Call it once per day, in order. It assumes a fresh
 * run: each unit starts at 0, not a resumed run's saved volumes.
 */
function boreholeReplay(b: PlanBorehole | undefined, day0: number) {
	const used = b ? b.units.map(() => 0) : [];
	const units = b?.units ?? [];
	const ks = units.map((_, k) => k);
	const primary = ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 1);
	const toDam = ks.filter((k) => units[k]!.toDam);
	const later = [...ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 0), ...ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 2)];
	return (t: number, D: number, qPrev: number, avail: number, dead: number, cap: number, river = 0, rule: PlanSupply['rule'] = 1, sRoom = Infinity, gRoom = Infinity) => {
		if (monthOfEpochDay(day0 + t) === 10 && (t === 0 || monthOfEpochDay(day0 + t - 1) !== 10)) used.fill(0);
		let gLeft = gRoom;
		const pump = (k: number, want: number) => {
			const u = units[k]!;
			const v = Math.max(0, Math.min(u.capacityM3Day, u.annualCapM3 - used[k]!, want, gLeft));
			used[k]! += v;
			gLeft -= v;
			return v;
		};
		let direct = 0;
		for (const k of primary) direct += pump(k, D - direct);
		let dam = 0;
		const left = rule !== 3 ? Math.min(D - direct, sRoom) - Math.min(river, D - direct, sRoom) : Math.min(D - direct, sRoom);
		for (const k of toDam) {
			const u = units[k]!;
			const room = cap - avail - dam;
			// Primary and emergency top the dam up only on a day it is drawn for demand (engine ≥ 1.8.0).
			const drawn = left > D * 1e-12;
			const want = u.mode === 1 ? (drawn ? room : 0) : u.mode === 2 ? (drawn && qPrev < u.triggerM3 ? room : 0) : left - (avail + dam - dead);
			dam += pump(k, Math.min(want, room));
		}
		const fromDam = Math.max(avail + dam - dead, 0);
		let surface: number;
		let fromRiver: number;
		const want = Math.min(D - direct, sRoom);
		if (rule === 3) {
			surface = Math.min(fromDam, want);
			fromRiver = Math.max(0, Math.min(river, want - surface));
		} else {
			fromRiver = Math.max(0, Math.min(river, want));
			surface = Math.min(fromDam, want - fromRiver);
		}
		for (const k of later) if (units[k]!.mode === 0 || qPrev < units[k]!.triggerM3) direct += pump(k, D - surface - fromRiver - direct);
		return { direct, dam, surface, river: fromRiver };
	};
}

/**
 * One other water user's day (WP-1.33, docs/model.md §2.7c): it takes
 * 0 ≤ G ≤ D from what reaches it, G = MIN(D, H) when senior and
 * MIN(D, MAX(0, H − Zs)) when junior (Zs = the senior requirement passing it);
 * it returns T = r × G; U = H − G + T; deficit = D − G; its EWR shortfall is
 * MIN(U − Z, 0) with Z the upstream requirement (it has no share of its own);
 * a senior user takes its demand out of the senior requirement below it.
 */
function checkUserDay(n: ModelInput['model']['nodes'][number], own: NonNullable<ModelInput['model']['boreholes']>, day0: number, get: SeriesMap, ups: string[], days: number): string | null {
	const g = (k: string) => get.get(`${n.id}|${k}`);
	const [D, G, W, H, U, T, Z, AA] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'outflow', 'return_flow', 'ewr_cumulative', 'ewr_shortfall'].map(g);
	if (!D || !G || !W || !H || !U || !T || !Z || !AA) return `${n.id}: user series missing`;
	const r = Math.min(Math.max(Number.isFinite(n.userReturnPct) ? n.userReturnPct! : 0, 0), 1);
	const senior = (n.userPriority ?? 'senior') !== 'junior';
	const Zs = g('senior_requirement');
	const upZs = ups.map((u) => get.get(`${u}|senior_requirement`));
	// Boreholes (WP-1.34): G = river take + groundwater; the river part follows the priority rule.
	const GW = g('groundwater_used');
	const DEP = g('baseflow_depletion');
	const bore = boreholeOf(n, own, []).borehole;
	const replay = boreholeReplay(bore, day0);
	// An allocation cap (engine ≥ 1.18.0): what the river and the boreholes may still give this water year.
	const RS = g(ALLOCATION_SERIES.surfaceRoom.key);
	const RG = g(ALLOCATION_SERIES.groundwaterRoom.key);
	for (let t = 0; t < days; t++) {
		const where = `${n.id} day ${t}`;
		let zIn = 0;
		for (const a of upZs) zIn += a?.[t] ?? 0;
		const h = H[t]!;
		const d = D[t]!;
		const gw = GW?.[t] ?? 0;
		const dep = DEP?.[t] ?? 0;
		const river = senior ? h : Math.max(0, h - zIn);
		// Primary boreholes pump first; otherwise the river goes first and groundwater tops it up.
		const rp = replay(t, d, 0, river, 0, 0, 0, 1, RS?.[t] ?? Infinity, RG?.[t] ?? Infinity);
		const wantGw = rp.direct;
		const want = rp.surface + wantGw;
		if (G[t]! < 0 || G[t]! > d + tol(d) || Math.abs(G[t]! - want) > tol(Math.max(h, d, zIn))) return `${where}: user took ${G[t]} ≠ MIN(demand ${d}, ${senior ? 'inflow' : 'inflow − senior requirement'} ${senior ? h : h - zIn})${bore ? ` + groundwater ${wantGw}` : ''}`;
		if (Math.abs(gw - wantGw) > tol(d)) return `${where}: user pumped ${gw} ≠ ${wantGw} (borehole rule)`;
		if (Math.abs(W[t]! - (d - G[t]!)) > tol(d)) return `${where}: user deficit ≠ demand − taken`;
		if (Math.abs(T[t]! - r * G[t]!) > tol(G[t]!)) return `${where}: user return ${T[t]} ≠ ${r} × taken ${G[t]}`;
		if (Math.abs(U[t]! - (h - (G[t]! - gw) + T[t]! - dep)) > tol(Math.max(h, gw))) return `${where}: user balance: outflow ${U[t]} ≠ inflow ${h} − taken from the river ${G[t]! - gw} + returned ${T[t]} − depletion ${dep}`;
		const noise = 1e-12 * Math.max(Math.abs(U[t]!), Math.abs(Z[t]!));
		if (AA[t]! > 0 || Math.abs(AA[t]! - Math.min(U[t]! - Z[t]!, 0)) > tol(U[t]!) + noise) return `${where}: EWR shortfall ${AA[t]}`;
		if (Zs && (Zs[t]! < 0 || Zs[t]! > zIn + tol(zIn))) return `${where}: senior requirement ${Zs[t]} below the user outside [0, ${zIn}]`;
	}
	return null;
}

interface Rule {
	from: string;
	to: string;
	/** Whether the rule runs, by calendar month (index 1–12). */
	on: Uint8Array;
	/** The most it may move in a day, by calendar month (the month's rate × 86 400, capped by the daily cap). */
	limit: Float64Array;
	/** The share of the source dam's capacity (the day's, engine ≥ 1.30.0) it keeps. */
	reserve: number;
	priority: number;
}

/**
 * Per-day transfer limits, whatever the priority between rules (docs/model.md
 * Q18), checked on each farm's net transfer J:
 * - months: a farm no active rule touches today has J = 0;
 * - rate and daily cap: J ≤ Σ limits of today's rules into the farm, and
 *   −J ≤ Σ limits of today's rules out of it (limit = MIN(the month's rate ×
 *   86 400, daily cap); the month's rate is the rule's own for that month
 *   when it has monthly rates, engine ≥ 1.14.0, so no rule moves more than
 *   its month's rate);
 * - minimum storage: −J ≤ yesterday's storage − the lowest reserve among
 *   today's outgoing rules (never below 0); a rule's reserve is the source
 *   dam's capacity × MAX(the rule's minimum, the dam's minimum operating level);
 *   and, per rule, no rule takes the dam below its own reserve
 *   (checkRuleReserves, engine ≥ 1.36.0);
 * - room at the destination (audit N4): a farm that sends nothing receives
 *   at most MAX(0, capacity − (yesterday's storage + rain on the dam −
 *   evaporation − seepage) + the most its dam is drawn today + a fixed
 *   release's floor, engine ≥ 1.29.0), the draw being today's demand D less
 *   its primary direct boreholes' room, within its allocation rooms
 *   (engine ≥ 1.31.0, issue #200; transferDrawBound);
 * - no water left on the table: for a source whose rules all go to farms fed
 *   only by it, the volume that left is at least MIN(Σ over its destinations
 *   of MIN(Σ limits into it, its room), yesterday's storage − the highest
 *   reserve).
 */
export function checkTransferLimits(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const byId = new Map(input.model.nodes.map((n) => [n.id, n]));
	const rules: Rule[] = [];
	const ruleDefs: Transfer[] = [];
	for (const tr of input.model.transfers) {
		const a = byId.get(tr.fromNodeId);
		const b = byId.get(tr.toNodeId);
		// River off-takes (engine ≥ 1.14.0) have their own limits (checkOfftakes, below).
		if (!tr.enabled || !a || !b || a.kind !== 'farm' || b.kind !== 'farm' || isRiverOfftake(tr)) continue;
		// The month's own rate (engine ≥ 1.14.0), or the one max rate in the listed months.
		// The source keeps the rule's minimum or its dam's minimum operating level, whichever is higher (audit Q5).
		rules.push({ from: a.id, to: b.id, on: transferActiveMonths(tr), limit: transferDailyLimit(tr), reserve: Math.max(tr.minStoragePct, a.damMinPct), priority: Number.isFinite(tr.priority) ? tr.priority : 0 });
		ruleDefs.push(tr);
	}
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const d0 = toEpochDay(out.startDate);
	// A dam whose capacity changes over the run (engine ≥ 1.30.0): its dam_capacity column, else the entered capacity.
	const capOn = (id: string, t: number) => get.get(`${id}|${DAM_CAPACITY_SERIES.key}`)?.[t] ?? byId.get(id)!.damCapacityM3;
	const storage = (id: string, t: number) => {
		// The storage reset's step (engine ≥ 0.46.0) starts its day.
		const set = get.get(`${id}|dam_storage_set`)?.[t] ?? 0;
		if (t > 0) return get.get(`${id}|dam_storage`)![t - 1]! + set;
		const n = byId.get(id)!;
		return n.damInitialPct * capOn(id, 0) + set;
	};
	// Per calendar month, the active rules and each farm's incoming and outgoing
	// ones, worked out once rather than every day.
	const byMonth = Array.from({ length: 13 }, (_, month) => {
		const active = rules.filter((r) => r.on[month] === 1).map((r) => ({ ...r, maxDaily: r.limit[month]! }));
		return { active, ins: farms.map((f) => active.filter((r) => r.to === f.id)), outs: farms.map((f) => active.filter((r) => r.from === f.id)) };
	});
	const farmJ = farms.map((f) => get.get(`${f.id}|transfer`)!);
	const farmIndex = new Map(farms.map((f, i) => [f.id, i]));
	// What a destination's sources are asked for: its demand after the drought restriction when the rule is on (engine ≥ 1.54.0).
	const farmD = farms.map((f) => get.get(`${f.id}|${RESTRICTION_SERIES.restricted.key}`) ?? get.get(`${f.id}|demand`)!);
	const farmLoss = farms.map((f) => ['rain_on_dam', 'dam_evaporation', 'dam_seepage'].map((k) => get.get(`${f.id}|${k}`)));
	const farmRelease = farms.map((f) => resolveRelease(f, []));
	// The most each destination's dam is drawn each day (engine ≥ 1.31.0, issue #200).
	const bores = boreholesByNode(input.model, []);
	const dests = new Set(rules.map((r) => r.to));
	const farmDraw = farms.map((f, fi) => (dests.has(f.id) ? transferDrawBound(f, bores.get(f.id) ?? [], get, d0, out.days, farmD[fi]!) : null));
	/**
	 * A destination's room that day (audit N4): capacity − (yesterday's storage
	 * + rain on the dam − evaporation − seepage) + the most its dam is drawn
	 * today (engine ≥ 1.31.0: D less its primary boreholes, within its
	 * allocation rooms; engine ≥ 0.19.0 counts the dam's gains and losses, N2) + a fixed release's floor
	 * (engine ≥ 1.29.0: the release with no inflow and nothing transferred
	 * in, fixedReleaseFloor). The reported evaporation
	 * and seepage are capped at what the dam held with the transfer in; on the
	 * days that cap bites the room read here is smaller than the engine's but
	 * still at least capacity + the volume that moved + D, so neither check
	 * below can trip on it (the dam is then empty, and the floor 0 in both).
	 */
	const roomOf = (fi: number, t: number) => {
		const [pd, e, sp] = farmLoss[fi]!.map((v) => v?.[t] ?? 0);
		const f = farms[fi]!;
		const cap = capOn(f.id, t);
		const held = storage(f.id, t) + pd! - e! - sp!;
		const rel = farmRelease[fi] ? fixedReleaseFloor(farmRelease[fi]!, monthOfEpochDay(d0 + t), held, f.damMinPct * cap) : 0;
		return cap - held + (farmDraw[fi]?.[t] ?? farmD[fi]![t]!) + rel;
	};
	for (let t = 0; t < out.days; t++) {
		const month = monthOfEpochDay(d0 + t);
		const { active, ins: insOf, outs: outsOf } = byMonth[month]!;
		for (const [fi, f] of farms.entries()) {
			const J = farmJ[fi]![t]!;
			const ins = insOf[fi]!;
			const outs = outsOf[fi]!;
			const where = `${f.id} day ${t}`;
			if (ins.length === 0 && outs.length === 0) {
				if (J !== 0) return `${where}: transfer ${J} with no rule active in month ${month}`;
				continue;
			}
			const inMax = ins.reduce((s, r) => s + r.maxDaily, 0);
			const outMax = outs.reduce((s, r) => s + r.maxDaily, 0);
			if (J > inMax + tol(inMax)) return `${where}: received ${J} > the rules' limit ${inMax}`;
			const prev = storage(f.id, t);
			const avail = outs.length ? Math.max(prev - capOn(f.id, t) * Math.min(...outs.map((r) => r.reserve)), 0) : 0;
			const outCap = Math.min(outMax, avail);
			if (-J > outCap + tol(outCap)) return `${where}: sent ${-J} > MIN(limit ${outMax}, storage ${prev} − reserve) = ${outCap}`;
			if (outs.length === 0 && J > 0) {
				const room = roomOf(fi, t);
				if (J > Math.max(0, room) + tol(Math.max(Math.abs(room), J))) return `${where}: received ${J} > its room ${room} (capacity − storage after the dam's gains and losses + the demand its dam meets)`;
			}
		}
		// Identifiable sources: every destination is fed by this source alone and sends nothing.
		for (const [fi, f] of farms.entries()) {
			const outs = outsOf[fi]!;
			if (outs.length === 0 || insOf[fi]!.length) continue;
			const dests = new Set(outs.map((r) => r.to));
			if ([...dests].some((d) => active.some((r) => (r.to === d && r.from !== f.id) || r.from === d))) continue;
			const sent = -get.get(`${f.id}|transfer`)![t]!;
			const got = [...dests].reduce((s, d) => s + get.get(`${d}|transfer`)![t]!, 0);
			const where = `${f.id} day ${t}`;
			if (Math.abs(sent - got) > tol(sent)) return `${where}: sent ${sent} but its destinations got ${got}`;
			const prev = storage(f.id, t);
			// What the destinations could take: per destination MIN(Σ limits into it, its room).
			let limit = 0;
			for (const d of dests) {
				const di = farmIndex.get(d)!;
				limit += Math.min(
					outs.filter((r) => r.to === d).reduce((s, r) => s + r.maxDaily, 0),
					Math.max(0, roomOf(di, t))
				);
			}
			const floor = Math.min(limit, Math.max(prev - capOn(f.id, t) * Math.max(...outs.map((r) => r.reserve)), 0));
			if (sent < floor - tol(Math.max(floor, prev))) return `${where}: sent only ${sent}; the rules and the destinations' room allowed ${floor} (storage ${prev})`;
		}
	}
	return checkRuleReserves(rules, ruleDefs, out, get, storage, capOn) ?? checkOfftakes(input, out, get);
}

/**
 * No rule takes its source dam below its own reserve (engine ≥ 1.36.0), read
 * from each rule's own volume (transfer_rule@, engine ≥ 1.6.0; skipped for an
 * older run). Rules of a lower priority draw first, so a rule of priority p
 * starts from A = yesterday's storage − what the lower priorities took. Of its
 * own priority, the rules keeping at least its reserve r draw only above their
 * own, so together they take at most MAX(0, A − r · capacity): the rule itself
 * too. A rule that moves nothing, or keeps less, doesn't count against it.
 */
function checkRuleReserves(rules: readonly Rule[], defs: readonly Transfer[], out: ModelOutput, get: SeriesMap, storage: (id: string, t: number) => number, capOn: (id: string, t: number) => number): string | null {
	const vol = readRuleVolumes(defs, out.days, (id, k) => get.get(`${id}|${k}`));
	if (!vol) return null;
	for (let t = 0; t < out.days; t++) {
		for (let k = 0; k < rules.length; k++) {
			const r = rules[k]!;
			let earlier = 0;
			let above = 0;
			for (let j = 0; j < rules.length; j++) {
				const o = rules[j]!;
				if (o.from !== r.from) continue;
				if (o.priority < r.priority) earlier += vol[j]![t]!;
				else if (o.priority === r.priority && o.reserve >= r.reserve) above += vol[j]![t]!;
			}
			if (!(above > 0)) continue;
			const prev = storage(r.from, t);
			const free = Math.max(0, prev - earlier - capOn(r.from, t) * r.reserve);
			if (above > free + tol(Math.max(prev, above))) return `${r.from} day ${t}: rule ${defs[k]!.id} and the rules of its priority keeping at least its reserve sent ${above} > storage ${prev} − ${earlier} sent first − its reserve = ${free}`;
		}
	}
	return null;
}

/**
 * The checks' own reading of the most a transfer's destination draws from its
 * dam each day (engine ≥ 1.31.0, issue #200; the engine's damDrawBound): the
 * demand D less its primary direct boreholes' room (each unit's MIN(capacity,
 * annual cap − pumped since 1 October), together within the day's
 * allocation_room_groundwater), capped at allocation_room_surface. The
 * primary direct units pump first, for the demand the off-take water left
 * (D − offtake_used), so replaying them from those columns gives each unit's
 * volume so far this water year. Like boreholeReplay it assumes a fresh run:
 * each unit starts at 0, not a resumed run's saved volumes.
 */
function transferDrawBound(n: NetworkNode, own: NonNullable<ModelInput['model']['boreholes']>, get: SeriesMap, day0: number, days: number, D: readonly number[]): Float64Array {
	const g = (k: string) => get.get(`${n.id}|${k}`);
	const RS = g(ALLOCATION_SERIES.surfaceRoom.key);
	const RG = g(ALLOCATION_SERIES.groundwaterRoom.key);
	const XUSED = g('offtake_used');
	const units = (boreholeOf(n, own, []).borehole?.units ?? []).filter((u) => !u.toDam && u.mode === 1);
	const used = units.map(() => 0);
	const out = new Float64Array(days);
	for (let t = 0; t < days; t++) {
		if (monthOfEpochDay(day0 + t) === 10 && (t === 0 || monthOfEpochDay(day0 + t - 1) !== 10)) used.fill(0);
		const d = D[t]!;
		const gRoom = RG?.[t] ?? Infinity;
		let room = 0;
		for (let k = 0; k < units.length; k++) room += Math.max(0, Math.min(units[k]!.capacityM3Day, units[k]!.annualCapM3 - used[k]!));
		const primary = Math.min(room, gRoom);
		out[t] = Math.min(Math.max(0, d - primary), RS?.[t] ?? Infinity);
		// Today's pumping, as groundwaterDay's first step: in order, each for what the others left.
		let gLeft = gRoom;
		let got = 0;
		const want = d - (XUSED?.[t] ?? 0);
		for (let k = 0; k < units.length; k++) {
			const u = units[k]!;
			const v = Math.max(0, Math.min(u.capacityM3Day, u.annualCapM3 - used[k]!, want - got, gLeft));
			used[k]! += v;
			gLeft -= v;
			got += v;
		}
	}
	return out;
}

/**
 * River off-takes (engine ≥ 1.14.0, docs/model.md §2.6a), each day, from each
 * rule's stored volume v (what it took, before losses):
 * - 0 ≤ v ≤ its capacity that day (the month's rate × 86 400, capped by the
 *   daily cap; 0 in a month it is off), so never more than capacity;
 * - at the source, Σ v = offtake_out, and the flow there before the off-takes
 *   (outflow + Σ v) gave each rule at most what lay above what it must leave
 *   (the senior users' requirement passing, its hands-off flow, the EWR here
 *   when asked), so never more than the river there; the outflow is what was
 *   left, reduced by exactly Σ v;
 * - at the destination, Σ v × (1 − loss) = offtake_in;
 * - at the farm each rule's seepage rejoins (engine ≥ 1.42.0: the source or
 *   a farm below it), Σ v × loss × its return share = offtake_loss_return,
 *   which joins the outflow after the farm's own off-takes (so the flow the
 *   source's rules saw is outflow − offtake_loss_return + Σ v);
 * - no water left in the river it could have taken: when every rule from a
 *   source is sized to capacity, Σ v ≥ MIN(Σ capacities, flow − the most any
 *   rule must leave).
 */
function checkOfftakes(input: ModelInput, out: ModelOutput, get: SeriesMap): string | null {
	const byId = new Map(input.model.nodes.map((n) => [n.id, n]));
	const warnings: string[] = [];
	const rules = input.model.transfers
		.filter((tr) => tr.enabled && isRiverOfftake(tr) && byId.get(tr.fromNodeId)?.kind === 'farm' && byId.get(tr.toNodeId)?.kind === 'farm' && tr.fromNodeId !== tr.toNodeId)
		.map((tr) => ({ tr, o: offtakeOf(tr, 0, 0, '', '', warnings), volume: get.get(`${tr.fromNodeId}|${transferRuleKey(tr.id)}`) }));
	if (!rules.length) return null;
	// Where each rule's returned seepage rejoins (engine ≥ 1.42.0), as planOfftakes resolves it; −1 = none returns.
	const index = new Map(input.model.nodes.map((n, i) => [n.id, i]));
	const returnAt = rules.map((r) => (r.o.lossReturn > 0 ? (offtakeReturnAt(r.tr, index.get(r.tr.fromNodeId)!, input.model.nodes, index) ?? -1) : -1));
	const returnUnits = new Set(input.model.nodes.filter((n) => get.has(`${n.id}|offtake_loss_return`)).map((n) => n.id));
	for (const [k, at] of returnAt.entries()) if (at >= 0 && rules[k]!.volume && !returnUnits.has(input.model.nodes[at]!.id)) return `river off-take ${rules[k]!.tr.id}: no offtake_loss_return series on ${input.model.nodes[at]!.id}, where its seepage rejoins`;
	const d0 = toEpochDay(out.startDate);
	const sources = [...new Set(rules.filter((r) => r.volume).map((r) => r.tr.fromNodeId))];
	const dests = [...new Set(rules.filter((r) => r.volume).map((r) => r.tr.toNodeId))];
	// A rule without a stored volume moved nothing: it can never take water, or the run skipped it (its
	// destination drains into its source); a planned rule's missing series shows in offtake_out / offtake_in.
	for (let t = 0; t < out.days; t++) {
		const month = monthOfEpochDay(d0 + t);
		for (const src of sources) {
			const mine = rules.filter((r) => r.volume && r.tr.fromNodeId === src);
			// The flow left after the off-takes: the outflow without the seepage rejoining below the source (engine ≥ 1.42.0).
			const U = get.get(`${src}|outflow`)![t]! - (get.get(`${src}|offtake_loss_return`)?.[t] ?? 0);
			const taken = get.get(`${src}|offtake_out`)?.[t];
			const Zs = get.get(`${src}|senior_requirement`)?.[t] ?? 0;
			const Z = get.get(`${src}|ewr_cumulative`)![t]!;
			const where = `${src} day ${t}`;
			let sum = 0;
			let caps = 0;
			let keepMax = 0;
			for (const r of mine) {
				const v = r.volume![t]!;
				const cap = r.o.capM3Day[month]!;
				if (!(v >= -tol(0)) || v > cap + tol(cap)) return `${where}: river off-take ${r.tr.id} took ${v}, outside [0, its capacity today ${cap}]`;
				sum += v;
				caps += cap;
				const keep = Math.max(Zs, r.o.handsOffM3Day, r.o.handsOffEwr ? Z : 0);
				keepMax = Math.max(keepMax, cap > 0 ? keep : 0);
				if (v > 0 && v > Math.max(0, U + sumAll(mine, t) - keep) + tol(Math.max(U, keep))) return `${where}: river off-take ${r.tr.id} took ${v}, more than the flow above what it must leave (${keep})`;
			}
			if (taken === undefined || Math.abs(taken - sum) > tol(sum)) return `${where}: offtake_out ${taken} ≠ Σ its river off-takes ${sum}`;
			if (sum > 0 && U < -tol(sum)) return `${where}: the river off-takes left ${U} in the river`;
			if (mine.every((r) => r.o.sizing === 1)) {
				const floor = Math.min(caps, Math.max(0, U + sum - keepMax));
				if (sum < floor - tol(Math.max(floor, U + sum))) return `${where}: the river off-takes took only ${sum}; their capacity and the flow allowed ${floor}`;
			}
		}
		for (const dst of dests) {
			let got = 0;
			for (const r of rules) if (r.volume && r.tr.toNodeId === dst) got += r.volume[t]! * (1 - r.o.loss);
			const xin = get.get(`${dst}|offtake_in`)?.[t];
			if (xin === undefined || Math.abs(xin - got) > tol(got)) return `${dst} day ${t}: offtake_in ${xin} ≠ what its river off-takes delivered, ${got}`;
		}
		for (const unit of returnUnits) {
			let back = 0;
			for (const [k, r] of rules.entries()) if (r.volume && returnAt[k]! >= 0 && input.model.nodes[returnAt[k]!]!.id === unit) back += r.volume[t]! * r.o.loss * r.o.lossReturn;
			const xret = get.get(`${unit}|offtake_loss_return`)![t]!;
			if (Math.abs(xret - back) > tol(back)) return `${unit} day ${t}: offtake_loss_return ${xret} ≠ the river off-takes' losses seeping back there, ${back}`;
		}
	}
	return null;
}

/** Σ over rules of what each took on day t. */
function sumAll(rules: readonly { volume?: number[] }[], t: number): number {
	let s = 0;
	for (const r of rules) s += r.volume?.[t] ?? 0;
	return s;
}

/**
 * The EWR compliance grid and the curtailment report agree with the daily
 * series they summarise:
 * - grid days add up to the run, every cell has 0 ≤ not met ≤ days ≤ days in
 *   the month, volumes are ≥ 0, and each site's Σ volume and Σ days not met
 *   equal −Σ daily shortfall and the count of short days (outlet: the
 *   catchment summary; farm: its FarmSummary);
 * - curtailment: H, I, R are the window means of demand, supplied and
 *   the EWR charge (unrounded, R1; the incremental shortfall AB before engine
 *   0.17.0); I ≤ H and R ≤ 0; totals are
 *   the column sums; the equitable fraction is ΣI / ΣH; targets redistribute
 *   the supplied water (Σ M = Σ I) and never exceed demand; N = M − I,
 *   the l/s columns are m³/day ÷ 86.4; from engine 0.17.0 (audit Q13)
 *   R_irr + R_store = R, R ≤ R_irr ≤ 0, the supply cut −ΔG ≤ 0, S = N − ΔG,
 *   U = MAX(M − ΔG, 0), the cut beyond the share = MAX(ΔG − M, 0) and
 *   demand left U / H lies in 0–1; before 0.17.0 S = N + R and U = M + R.
 * Tolerances are float noise only: 1e-12 of the operands' magnitude for single
 * operations, 1e-10 of Σ|x| for sums over a run.
 */
export function checkReportTotals(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const sum = (a: number[], from = 0, to = a.length - 1) => {
		let s = 0;
		for (let t = from; t <= to; t++) s += a[t]!;
		return s;
	};
	const sumAbs = (a: number[]) => a.reduce((s, v) => s + Math.abs(v), 0);
	/** |a − b| within `rel` of `scale` (default: the larger magnitude). */
	const close = (a: number, b: number, rel = 1e-12, scale = Math.max(Math.abs(a), Math.abs(b))) => Math.abs(a - b) <= rel * scale;
	const c = out.summary.ewrCompliance!;
	const cellDays = c.days.flat();
	if (sum(cellDays) !== out.days) return `EWR grid: cells hold ${sum(cellDays)} days, the run has ${out.days}`;
	const d0 = toEpochDay(out.startDate);
	const monthLen = (wy: number, m: number) => {
		const cal = ((m + 9) % 12) + 1; // water-year index 0 = Oct
		const year = cal >= 10 ? wy : wy + 1;
		return new Date(Date.UTC(year, cal, 0)).getUTCDate();
	};
	const grid = (g: EwrComplianceGrid, daily: number[], label: string, daysNotMet: number): string | null => {
		for (let r = 0; r < c.waterYears.length; r++) {
			for (let m = 0; m < 12; m++) {
				const n = c.days[r]![m]!;
				const nm = g.daysNotMet[r]![m]!;
				const v = g.shortfallM3[r]![m]!;
				if (n > monthLen(c.waterYears[r]!, m)) return `EWR grid ${label} ${c.waterYears[r]}/${m}: ${n} days in a month`;
				if (nm < 0 || nm > n || v < 0 || (n === 0 && v !== 0)) return `EWR grid ${label} ${c.waterYears[r]}/${m}: ${nm} of ${n} days, ${v} m³`;
			}
		}
		const vol = sum(g.shortfallM3.flat());
		if (!close(vol, -sum(daily), 1e-10, sumAbs(daily))) return `EWR grid ${label}: Σ volume ${vol} ≠ −Σ daily shortfall ${-sum(daily)}`;
		const short = daily.filter((v) => v < 0).length;
		if (sum(g.daysNotMet.flat()) !== short || short !== daysNotMet) return `EWR grid ${label}: ${sum(g.daysNotMet.flat())} days not met, daily series ${short}, summary ${daysNotMet}`;
		return null;
	};
	if (c.waterYears[0] !== waterYearOfDay(d0) || c.waterYears.at(-1) !== waterYearOfDay(d0 + out.days - 1)) return 'EWR grid: water years do not span the run';
	const bad = grid(c.outlet, get.get('null|ewr_shortfall')!, 'outlet', out.summary.catchment.ewrDaysNotMet);
	if (bad) return bad;
	// A farm's grid is its EWR charge (engine ≥ 0.17.0, audit Q17); older runs gridded AB.
	const farmEwr = (id: string) => get.get(`${id}|ewr_charge`) ?? get.get(`${id}|ewr_shortfall_incremental`)!;
	for (const g of c.farms) {
		const fs = out.summary.farms.find((f) => f.nodeId === g.nodeId)!;
		const b = grid(g, farmEwr(g.nodeId!), g.nodeId ?? '?', fs.daysEwrNotMet);
		if (b) return b;
	}

	// EWR agreement with the observed record: it counts every observed day once,
	// either scored or left out by a calibration exclusion; on the scored days
	// the model side is exactly the outlet test, and the breakdowns add back up.
	const ag = out.summary.catchment.ewrAgreement;
	const obsSeries = get.get('null|observed_flow');
	if (ag) {
		if (!obsSeries) return 'EWR agreement without an observed_flow series';
		const shortDaily = get.get('null|ewr_shortfall')!;
		const excluded = excludedDayMask(exclusionRanges(sanitizeExclusions(input.settings.calibrationExclusions, [])), out.startDate, out.days);
		let observed = 0;
		let modelBelow = 0;
		for (let t = 0; t < out.days; t++) {
			if (!Number.isFinite(obsSeries[t]!)) continue;
			observed++;
			if (!excluded[t] && shortDaily[t]! < 0) modelBelow++;
		}
		const o = ag.overall;
		if (ag.days + ag.excludedDays !== observed || o.days !== ag.days) return `EWR agreement: ${ag.days} days counted, ${observed} observed`;
		if (o.bothBelow + o.falseAlarm + o.miss + o.bothAbove !== o.days) return 'EWR agreement: the 2×2 cells do not add up to its days';
		if (o.bothBelow + o.falseAlarm !== modelBelow) return `EWR agreement: model below on ${o.bothBelow + o.falseAlarm} days, the outlet test on ${modelBelow}`;
		for (const k of ['days', 'bothBelow', 'falseAlarm', 'miss', 'bothAbove'] as const) {
			if (sum(ag.byMonth.map((m) => m[k])) !== o[k] || sum(ag.byWaterYear.map((y) => y[k])) !== o[k]) return `EWR agreement: ${k} by month / water year ≠ overall`;
		}
	} else if (obsSeries) {
		return 'EWR agreement missing although the run has a gauge or logger record';
	}

	// FarmSummary: whole-run means of the daily series.
	for (const f of out.summary.farms) {
		const dm = sum(get.get(`${f.nodeId}|demand`)!) / out.days;
		const sp = sum(get.get(`${f.nodeId}|supplied`)!) / out.days;
		if (!close(f.avgDemandM3Day, dm) || !close(f.avgSuppliedM3Day, sp)) return `farm summary ${f.nodeId}: means differ from the daily series`;
		if (f.fractionSupplied < 0 || f.fractionSupplied > 1 + 1e-12) return `farm summary ${f.nodeId}: fraction supplied ${f.fractionSupplied}`;
		// Boreholes (WP-1.34): means present exactly when the farm has them.
		const gwS = get.get(`${f.nodeId}|groundwater_used`);
		if (!!gwS !== (f.avgGroundwaterM3Day !== undefined)) return `farm summary ${f.nodeId}: groundwater mean ${gwS ? 'missing' : 'without boreholes'}`;
		if (gwS && (!close(f.avgGroundwaterM3Day!, sum(gwS) / out.days) || !close(f.avgBaseflowDepletionM3Day!, sum(get.get(`${f.nodeId}|baseflow_depletion`)!) / out.days)))
			return `farm summary ${f.nodeId}: groundwater means differ from the daily series`;
	}

	// Curtailment over its reporting window.
	const k = out.summary.curtailment!;
	const from = toEpochDay(k.reportStart) - d0;
	const to = toEpochDay(k.reportEnd) - d0;
	if (from < 0 || to >= out.days || to < from || k.days !== to - from + 1) return `curtailment window ${k.reportStart} … ${k.reportEnd} outside the run`;
	const n = to - from + 1;
	let sumH = 0;
	let sumI = 0;
	let sumM = 0;
	for (const row of k.farms) {
		const w = `curtailment ${row.nodeId}`;
		const mean = (key: string) => sum(get.get(`${row.nodeId}|${key}`)!, from, to) / n;
		const mH = mean('demand');
		const mI = mean('supplied');
		const mR = sum(farmEwr(row.nodeId), from, to) / n;
		if (!close(row.demandM3Day, mH) || !close(row.suppliedM3Day, mI) || !close(row.ewrShortfallM3Day, mR))
			return `${w}: H/I/R ${row.demandM3Day}/${row.suppliedM3Day}/${row.ewrShortfallM3Day} ≠ window means ${mH}/${mI}/${mR}`;
		// Daily supplied ≤ demand and shortfall ≤ 0, so their means are too (float sums are monotone).
		if (row.ewrShortfallM3Day > 0 || row.suppliedM3Day > row.demandM3Day) return `${w}: shortfall ${row.ewrShortfallM3Day} > 0 or supplied ${row.suppliedM3Day} > demand ${row.demandM3Day}`;
		if (row.targetM3Day > row.demandM3Day || row.targetM3Day < 0) return `${w}: target ${row.targetM3Day} outside [0, demand ${row.demandM3Day}]`;
		const M = row.targetM3Day;
		// Engine ≥ 0.17.0: −ΔG, the supply cut for the EWR (audit Q13).
		const cut = row.ewrSupplyCutM3Day;
		const id = (x: CurtailmentFarm, a: number, b: number, what: string, ...ops: number[]) =>
			close(a, b, 1e-12, Math.max(Math.abs(a), Math.abs(b), ...ops.map(Math.abs))) ? null : `${w}: ${what} (${a} vs ${b}) in ${JSON.stringify(x)}`;
		const e =
			id(row, row.reduceGainM3Day, M - row.suppliedM3Day, 'N ≠ M − I', M, row.suppliedM3Day) ??
			(cut === undefined
				? id(row, row.totalChangeM3Day, row.reduceGainM3Day + row.ewrShortfallM3Day, 'S ≠ N + R', row.reduceGainM3Day, row.ewrShortfallM3Day) ??
					id(row, row.volumeLeftM3Day, M + row.ewrShortfallM3Day, 'U ≠ M + R', M, row.ewrShortfallM3Day)
				: id(row, row.ewrChargeIrrigationM3Day! + row.ewrChargeStorageM3Day!, row.ewrShortfallM3Day, 'R_irr + R_store ≠ R', row.ewrChargeIrrigationM3Day!, row.ewrChargeStorageM3Day!) ??
					(row.basicNeedsM3Day === undefined
						? id(row, row.totalChangeM3Day, row.reduceGainM3Day + cut, 'S ≠ N − ΔG', row.reduceGainM3Day, cut) ??
							id(row, row.volumeLeftM3Day, Math.max(M + cut, 0), 'U ≠ MAX(M − ΔG, 0)', M, cut)
						: // The basic-needs floor (engine ≥ 1.44.0): the window mean of basic_needs, the volume left never below it.
							id(row, row.basicNeedsM3Day, sum(get.get(`${row.nodeId}|${BASIC_NEEDS_SERIES.key}`) ?? [NaN], from, to) / n, 'floor ≠ the window mean of basic_needs') ??
							id(row, row.totalChangeM3Day, Math.max(row.reduceGainM3Day + cut, row.basicNeedsM3Day - row.suppliedM3Day), 'S ≠ MAX(N − ΔG, floor − I)', row.reduceGainM3Day, cut, row.suppliedM3Day) ??
							id(row, row.volumeLeftM3Day, Math.max(M + cut, 0, row.basicNeedsM3Day), 'U ≠ MAX(M − ΔG, 0, floor)', M, cut) ??
							id(row, row.basicNeedsHeldM3Day ?? NaN, row.volumeLeftM3Day - Math.max(M + cut, 0), 'held ≠ U − MAX(M − ΔG, 0)', M, cut) ??
							(row.basicNeedsM3Day > row.demandM3Day * (1 + 1e-12) ? `${w}: basic-needs floor ${row.basicNeedsM3Day} above the demand ${row.demandM3Day}` : null)) ??
					id(row, row.ewrCutBeyondShareM3Day ?? NaN, Math.max(-cut - M, 0), 'cut beyond share ≠ MAX(ΔG − M, 0)', M, cut) ??
					(row.ewrChargeIrrigationM3Day! > 0 || row.ewrChargeIrrigationM3Day! < row.ewrShortfallM3Day - 1e-12 * Math.abs(row.ewrShortfallM3Day) || cut > 0
						? `${w}: EWR charge ${row.ewrShortfallM3Day}, irrigation part ${row.ewrChargeIrrigationM3Day}, supply cut ${cut}`
						: null) ??
					(row.fractionOfDemandLeft !== null && (row.fractionOfDemandLeft < 0 || row.fractionOfDemandLeft > 1 + 1e-12)
						? `${w}: demand left ${row.fractionOfDemandLeft} outside 0–1`
						: null)) ??
			id(row, row.reduceGainLs, row.reduceGainM3Day / 86.4, 'l/s ≠ m³/day ÷ 86.4') ??
			id(row, row.totalChangeLs, row.totalChangeM3Day / 86.4, 'total l/s ≠ m³/day ÷ 86.4');
		if (e) return e;
		const H = row.demandM3Day;
		const I = row.suppliedM3Day;
		if ((row.fractionSupplied === null) !== (H === 0)) return `${w}: fraction supplied null iff demand 0`;
		sumH += H;
		sumI += I;
		sumM += row.targetM3Day;
	}
	if (!close(k.totals.demandM3Day, sumH) || !close(k.totals.suppliedM3Day, sumI)) return `curtailment totals ${k.totals.demandM3Day}/${k.totals.suppliedM3Day} ≠ Σ farms ${sumH}/${sumI}`;
	if (sumH === 0 ? k.equitableFraction !== null : !close(k.equitableFraction!, sumI / sumH)) return `curtailment equitable fraction ${k.equitableFraction} ≠ ${sumI}/${sumH}`;
	if (sumH > 0 && !close(sumM, sumI, 1e-12 * Math.max(1, k.farms.length))) return `curtailment targets Σ ${sumM} do not redistribute the supplied ${sumI}`;
	return checkUserReports(input, out, get, from, to);
}

/**
 * Other water users' summaries and curtailment rows (WP-1.33): present exactly
 * when the network has users; whole-run and window means of the daily series;
 * 0 ≤ supplied ≤ demand; a senior user is never cut and keeps its whole
 * charge; a junior user's cut −ΔG = MAX(charge ÷ k, −supplied) ≤ 0 with
 * k = 1 − return share, and the charge left standing = MIN(0, charge − k·cut).
 */
function checkUserReports(input: ModelInput, out: ModelOutput, get: SeriesMap, from: number, to: number): string | null {
	const users = input.model.nodes.filter((n) => n.kind === 'user');
	const sum = (a: number[], a0 = 0, b = a.length - 1) => {
		let x = 0;
		for (let t = a0; t <= b; t++) x += a[t]!;
		return x;
	};
	const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) + 1e-12;
	const us = out.summary.users;
	const rows = out.summary.curtailment?.otherUsers;
	if (!users.length) return us || rows ? 'user summaries without user nodes' : null;
	if (!us || !rows || us.length !== users.length || rows.length !== users.length) return 'user summaries missing for the user nodes';
	const n = to - from + 1;
	for (const u of users) {
		const s = us.find((x) => x.nodeId === u.id);
		const row = rows.find((x) => x.nodeId === u.id);
		if (!s || !row) return `user ${u.id}: no summary or curtailment row`;
		const col = (k: string) => get.get(`${u.id}|${k}`)!;
		const [D, G, T, C] = ['demand', 'supplied', 'return_flow', 'ewr_charge'].map(col) as number[][];
		if (!close(s.avgDemandM3Day, sum(D!) / out.days) || !close(s.avgSuppliedM3Day, sum(G!) / out.days) || !close(s.avgReturnedM3Day, sum(T!) / out.days) || !close(s.avgEwrChargeM3Day, -sum(C!) / out.days))
			return `user summary ${u.id}: means differ from the daily series`;
		if (s.fractionSupplied < 0 || s.fractionSupplied > 1 + 1e-12) return `user summary ${u.id}: fraction supplied ${s.fractionSupplied}`;
		const w = `curtailment user ${u.id}`;
		if (!close(row.demandM3Day, sum(D!, from, to) / n) || !close(row.suppliedM3Day, sum(G!, from, to) / n) || !close(row.ewrChargeM3Day, sum(C!, from, to) / n)) return `${w}: window means differ from the daily series`;
		if (row.suppliedM3Day > row.demandM3Day || row.ewrChargeM3Day > 0) return `${w}: supplied ${row.suppliedM3Day} > demand or charge ${row.ewrChargeM3Day} > 0`;
		const k = 1 - Math.min(Math.max(u.userReturnPct ?? 0, 0), 1);
		const senior = (u.userPriority ?? 'senior') !== 'junior';
		const cut = senior || !(k > 0) ? 0 : Math.max(row.ewrChargeM3Day / k, -row.suppliedM3Day);
		if (row.curtailed === senior || !close(row.supplyCutM3Day, cut) || row.supplyCutM3Day > 0) return `${w}: supply cut ${row.supplyCutM3Day} ≠ ${cut} (${senior ? 'senior: not curtailed' : 'junior'})`;
		if (!close(row.uncurtailedChargeM3Day, Math.min(0, row.ewrChargeM3Day - cut * k))) return `${w}: charge left standing ${row.uncurtailedChargeM3Day}`;
		if (!close(row.supplyCutLs, row.supplyCutM3Day / 86.4)) return `${w}: l/s ≠ m³/day ÷ 86.4`;
	}
	return null;
}

function waterYearOfDay(day: number): number {
	const d = new Date(day * 86_400_000);
	return d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * The runoff model's water balance, from the run's own series (nothing to
 * check when the caller supplied the natural flow):
 * - every day, rain − AET − Q + exchange = Δ(Σ stores), Q = natural flow in
 *   mm over the catchment, starting from the post-warm-up storage (whose
 *   stores, when recorded, sum to it and sit in their bounds);
 * - Q ≥ 0, 0 ≤ AET ≤ PET, stores ≥ 0 and the production store ≤ X1;
 * - the summary's totals are the sums of the series and close the balance.
 */
export function checkRunoffBalance(input: ModelInput, out: ModelOutput): string | null {
	const b = out.summary.runoff;
	const get = seriesMap(out);
	// Natural flow a caller supplied (runModelWith: tests, the workbook replay) has no runoff model, so no stores and no balance.
	if (!b) return get.has('null|aet') ? `runoff model ${String(input.settings.runoffModel ?? defaultProjectSettings().runoffModel)} reported its stores but no water balance` : null;
	const s = (k: string) => get.get(`null|${k}`);
	const rain = s('rain_used')!;
	const pet = s('pet')!;
	const aet = s('aet')!;
	const nat = s('natural_flow')!;
	const stores = ['production_store', 'routing_store', 'uh_store'].map((k) => s(k)!);
	const ex = s('exchange');
	if (!rain || !pet || !aet || stores.some((x) => !x)) return 'runoff series missing';
	if (!ex && b.params.x2 !== 0) return 'exchange series missing with X2 ≠ 0';
	const toMm = 1 / (b.areaKm2 * 1000);
	const t9 = (x: number) => 1e-9 + 1e-12 * Math.abs(x);
	// Each store's start (engine ≥ 1.20.0) sums to the total and sits in its bounds.
	if (b.storesStartMm) {
		const start = ['production_store', 'routing_store', 'uh_store'].map((k) => b.storesStartMm![k]);
		if (start.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < -t9(0)) || start[0]! > b.params.x1! + t9(b.params.x1!))
			return `runoff stores at the start ${JSON.stringify(b.storesStartMm)} are missing or outside their bounds`;
		const sum = start[0]! + start[1]! + start[2]!;
		if (Math.abs(sum - b.storageStartMm) > t9(b.storageStartMm)) return `runoff stores at the start sum to ${sum} mm, not the ${b.storageStartMm} mm storage`;
	}
	let before = b.storageStartMm;
	const tot = { rain: 0, pet: 0, aet: 0, flow: 0, ex: 0 };
	for (let t = 0; t < out.days; t++) {
		const q = nat[t]! * toMm;
		const e = ex ? ex[t]! : 0;
		const after = stores[0]![t]! + stores[1]![t]! + stores[2]![t]!;
		const d = rain[t]! - aet[t]! - q + e - (after - before);
		if (Math.abs(d) > t9(Math.max(before, after, rain[t]!))) return `runoff day ${t}: rain − AET − Q + exchange − Δstorage = ${d}`;
		if (q < 0 || aet[t]! < 0 || aet[t]! > pet[t]! + t9(pet[t]!)) return `runoff day ${t}: Q ${q}, AET ${aet[t]}, PET ${pet[t]}`;
		if (stores.some((x) => x[t]! < -t9(0)) || stores[0]![t]! > b.params.x1! + t9(b.params.x1!)) return `runoff day ${t}: a store is outside its bounds`;
		tot.rain += rain[t]!;
		tot.pet += pet[t]!;
		tot.aet += aet[t]!;
		tot.flow += q;
		tot.ex += e;
		before = after;
	}
	const scale = Math.max(1, tot.rain + tot.aet + tot.flow + Math.abs(tot.ex) + b.storageStartMm + before);
	const near = (a: number, c: number) => Math.abs(a - c) <= 1e-9 * scale;
	if (!near(b.rainMm, tot.rain) || !near(b.petMm, tot.pet) || !near(b.aetMm, tot.aet) || !near(b.flowMm, tot.flow) || !near(b.exchangeMm, tot.ex) || !near(b.storageEndMm, before))
		return `runoff summary ${JSON.stringify(b)} disagrees with the series`;
	if (!near(b.rainMm - b.aetMm - b.flowMm + b.exchangeMm, b.storageEndMm - b.storageStartMm)) return 'runoff summary does not close its balance';
	return null;
}

/**
 * A farm's intermediate columns (verify/columns.ts) follow their formulas and
 * add up to the published ones, so the export can be trusted for redoing a
 * day by hand:
 * - crop requirement F = MAX(0, gross demand) − effective rain used, F ≥ 0
 *   (checkSoilWater checks where the effective rain used came from), and the
 *   abstraction demand D = F / e (audit N1);
 * - the splits conserve water: K + L = H, M + N = I, with 0 ≤ K ≤ H × % and
 *   0 ≤ M ≤ I × %; 0 ≤ O ≤ MIN(diversion capacity (the month's, when set by
 *   month, engine ≥ 1.32.0), L + N);
 * - the dam's surface A = A_full × (Q[t−1] / capacity)^b (A_full as entered,
 *   or capacity ÷ 3 m), or linear in the survey curve when there is one
 *   (WP-3.5); rain on it Pd = rain × A / 1000; evaporation
 *   E = MIN(lake factor (that month's, when monthly) × A-pan ÷ days in month
 *   × A / 1000, Q[t−1] + Pd + J), and for b > 1 also ≤ (1 − seepage) ×
 *   Q[t−1] / b (engine 0.21.1; a curve's local b = Q·A′/A);
 *   seepage Sp = MIN(seepage × Q[t−1], Q[t−1] + Pd + J − E) (audit N2), and
 *   S0 = Q[t−1] + Pd − E − Sp is what the day starts from;
 * - the release (WP-3.5) X ≤ the outlet: under pass inflow X = MIN(K + M + O,
 *   required below the dam − S, outlet, S0 + M + O + K + J), the requirement
 *   being the rule's monthly amount or the EWR required at the node (Z);
 *   under fixed X = MIN(the month's amount, outlet, S0 + M + O + K + J −
 *   dead storage), never < 0; no rule, no release column;
 * - G = MIN(MAX(S0 + M + O + K + J − X − dead storage, 0), D): irrigation
 *   takes what is above the minimum operating level, up to demand (Q5);
 * - a farm with a supply rule that pumps from the river (WP-3.8) has the
 *   column river_abstraction Gr, and only such a farm: while it pumps from
 *   the river (always under river first and run of river; under trigger from
 *   the day the start-of-day storage falls below the trigger until the day it
 *   is back at the stop level) Gr = MIN(pump capacity, MAX(0, S − MAX(Zs,
 *   a pass-inflow release's target, the hands-off flow)), demand) taken before the dam, or after
 *   it under run of river, and 0 otherwise; run of river sends everything
 *   below the dam (K = M = O = 0); the dam gives G − Gr;
 * - P = S0 + M + O + K + J − X − (G − Gr), Q = MIN(P, capacity), R = MAX(P − capacity, 0);
 * - S = L + N − O, T = β·(1 − e)·G, U = R + S − Gr + T + returned seepage + X,
 *   returned seepage = Sp × the seepage return share (WP-3.5), the rest lost;
 * - V is the recomputed balance residual and is float noise.
 */
export function checkWorkings(input: ModelInput, out: ModelOutput): string | null {
	const bores = boreholesByNode(input.model, []);
	const get = seriesMap(out);
	// Open-water evaporation depth per day and the day's rain on a dam (audit N2), from the run's own settings and rain.
	const day0 = toEpochDay(out.startDate);
	const evapMmDay = lakeEvaporationMmDay(input, out.startDate, out.days);
	const rainFinal = get.get('null|rain_final');
	const damRain = (t: number) => {
		const v = rainFinal?.[t];
		return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
	};
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const keys = ['gross_demand', 'effective_rain', 'crop_requirement', 'demand', 'supplied', 'inflow_upstream', 'runoff', 'transfer', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam', 'diverted_to_dam', 'dam_area', 'rain_on_dam', 'dam_evaporation', 'dam_seepage', 'interim_storage', 'dam_storage', 'spill', 'below_dam_not_diverted', 'return_flow', 'outflow', 'balance_residual'];
		const cols = keys.map(g);
		const missing = keys.find((_, i) => !cols[i]);
		if (missing) return `${n.id}: working column ${missing} missing`;
		const [gross, eff, F, D, G, H, I, J, K, L, M, N, O, AREA, PD, EV, SP, P, Q, R, S, T, U, V] = cols as number[][];
		// The senior users' requirement (WP-1.33): present only when a senior user's demand is passed down.
		const ZS = g('senior_requirement');
		const PASSED = g('passed_for_senior');
		if (ZS && !PASSED) return `${n.id}: working column passed_for_senior missing`;
		const upZS = input.model.nodes.filter((u) => u.downstreamNodeId === n.id).map((u) => get.get(`${u.id}|senior_requirement`));
		// Boreholes (WP-1.34, WP-3.9).
		const bore = boreholeOf(n, bores.get(n.id) ?? [], []).borehole;
		const replay = boreholeReplay(bore, day0);
		const GW = g('groundwater_used');
		const GD = g('groundwater_to_dam');
		const DEP = g('baseflow_depletion');
		if (bore && (!GW || !DEP)) return `${n.id}: groundwater columns missing for a farm with boreholes`;
		if (!!GD !== !!bore?.units.some((u) => u.toDam)) return `${n.id}: groundwater_to_dam ${GD ? 'without' : 'missing for'} a borehole that pumps into the dam`;
		if (ZS && upZS.some((a) => !a)) return `${n.id}: an upstream node has no senior_requirement series`;
		// The dam's area–storage relation, as runModel resolves it (audit N2).
		const { areaFull, b, seep, seepReturn: seepRet } = damWorkings(n);
		// Survey curve, release and seepage destination (WP-3.5).
		const curve = n.damCapacityM3 > 0 ? resolveDamCurve(n) : null;
		const rel = resolveRelease(n, []);
		const REL = g('dam_release');
		const SPL = g('dam_seepage_lost');
		if (!!rel !== !!REL) return `${n.id}: dam_release column ${REL ? 'without' : 'missing for'} a release rule`;
		// Supply rule and river pump (WP-3.8).
		const sup = supplyOf(n, []).supply;
		// Hands-off flow and River to dam by month (engine ≥ 1.32.0).
		const ops = operatingOf(n, []);
		const divertOf = { divertCapacityM3Day: n.divertCapacityM3Day, ...(ops.divertM3DayByMonth ? { divertM3DayByMonth: ops.divertM3DayByMonth } : {}) };
		const RA = g('river_abstraction');
		if (!!sup !== !!RA) return `${n.id}: river_abstraction column ${RA ? 'without' : 'missing for'} a supply rule that pumps from the river`;
		let onRiver = false;
		if ((seepRet < 1) !== !!SPL) return `${n.id}: dam_seepage_lost column ${SPL ? 'with all seepage returning' : 'missing'}`;
		const Zc = g('ewr_cumulative')!;
		const e = runEfficiency(input, n);
		const returnPerSupplied = n.lossReturnFraction * (1 - e);
		// Registered volumes (engine ≥ 1.18.0): a full allocation's factor on the demand, a cap's room per source.
		const KF = g(ALLOCATION_SERIES.demandFactor.key);
		const RS = g(ALLOCATION_SERIES.surfaceRoom.key);
		const RG = g(ALLOCATION_SERIES.groundwaterRoom.key);
		// The demand factor on F each day (the demand.scale scenario op from settings.demandFactorFrom, × a full allocation's).
		// On F, the crops' own factor too (engine ≥ 1.45.0, demand.scale with part 'crops').
		const { perDay: DF, scaled } = dailyDemandFactor(input.settings, n, day0, out.days, KF, 'crops');
		// Demand objects (engine ≥ 1.7.0): their demand adds to F / e, and G splits between crops and objects.
		const objs = objectColumns(input, n, get, out);
		if (typeof objs === 'string') return objs;
		// The basic-needs floor (engine ≥ 1.44.0): the scenario's restriction alone (a floor holds against it), and
		// the unit's basic_needs column, Σ MIN(floor, demand) over its floored objects, exactly when it has one.
		const SC = objs && objs.floor.some((f) => f !== null) ? dailyDemandFactor(input.settings, n, day0, out.days, undefined).perDay : null;
		// Each object's own factor (engine ≥ 1.45.0): the unit's × its category's, with and without a full allocation's.
		const objFactors = objs
			? objs.category.map((c) => ({ df: dailyDemandFactor(input.settings, n, day0, out.days, KF, c).perDay, sc: dailyDemandFactor(input.settings, n, day0, out.days, undefined, c).perDay }))
			: null;
		const abstractFrom = SC ? abstractionStartDay(n, day0, out.days, []) : 0;
		const BN = g(BASIC_NEEDS_SERIES.key);
		if (!!BN !== !!SC) return `${n.id}: ${BN ? 'a basic_needs column without a domestic or municipal object with people' : 'no basic_needs column for its basic-needs floor'}`;
		if (BN && objs) {
			for (let t = 0; t < out.days; t++) {
				let b = 0;
				objs.floor.forEach((f, k) => {
					if (f !== null) b += dayFloor(f, objs.demand[k]![t]!);
				});
				if (Math.abs(BN[t]! - b) > tol(b)) return `${n.id} day ${t}: basic_needs ${BN[t]} ≠ Σ MIN(floor, demand) ${b}`;
			}
		}
		// A dam whose capacity changes over the run (engine ≥ 1.30.0, ../network/development.ts): the
		// day's factor k, as runModel resolves it, and the dam_capacity column it reports.
		const ks = capacityScaleOf(n, day0, out.days, []);
		const CAPS = g(DAM_CAPACITY_SERIES.key);
		if (!!ks !== !!CAPS) return `${n.id}: ${CAPS ? 'a dam_capacity column for a dam whose capacity doesn\'t change' : 'no dam_capacity column for a dam whose capacity changes'}`;
		const cap0 = n.damCapacityM3;
		const dead0 = n.damMinPct * cap0;
		let qPrev = n.damInitialPct * cap0 * (ks && out.days ? ks[0]! : 1);
		const near = (a: number, b: number, scale: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b), scale));
		// The storage reset (engine ≥ 0.46.0): its step starts the day.
		const SET = g('dam_storage_set');
		// River off-takes (engine ≥ 1.14.0): what arrived here (used first, then into the dam for the rules
		// that top it up, the rest flowing on) and what was taken from the flow leaving here.
		const XIN = g('offtake_in');
		const XUSED = g('offtake_used');
		const XDAM = g('offtake_to_dam');
		const XOUT = g('offtake_out');
		// Conveyance losses seeping back below this unit (engine ≥ 1.42.0): they join the outflow.
		const XRET = g('offtake_loss_return');
		if (!!XIN !== !!XUSED || !!XIN !== !!XDAM) return `${n.id}: river off-take working columns (offtake_used, offtake_to_dam) ${XIN ? 'missing' : 'without an off-take in'}`;
		const topUps = XIN ? offtakeInto(input, n.id, get) : null;
		if (typeof topUps === 'string') return topUps;
		// The drought restriction (engine ≥ 1.54.0): the unit's sources supply its demand after the day's cut, and
		// its objects and crops share by their cut demands (checkDroughtRestriction checks the cut itself).
		const DR = g(RESTRICTION_SERIES.restricted.key);
		const rule = DR ? resolveDroughtRestriction(input.settings.droughtRestriction, []) : null;
		// The unit's own level under the 'own' basis (engine ≥ 1.54.0), else the catchment's.
		const LV = g(RESTRICTION_SERIES.level.key) ?? get.get(`null|${RESTRICTION_SERIES.level.key}`);
		if (DR && (!rule || !LV)) return `${n.id}: a restricted_demand column without a drought restriction rule and its level column`;
		for (let t = 0; t < out.days; t++) {
			if (SET) qPrev += SET[t]!;
			const gr = gross![t]!, ef = eff![t]!, f = F![t]!, d = D![t]!, gg = G![t]!, h = H![t]!, i = I![t]!, j = J![t]!, k = K![t]!, l = L![t]!, m = M![t]!;
			const nn = N![t]!, o = O![t]!, p = P![t]!, q = Q![t]!, r = R![t]!, ss = S![t]!, tt = T![t]!, u = U![t]!, v = V![t]!;
			const where = `${n.id} day ${t}`;
			const kd = ks ? ks[t]! : 1;
			const cap = cap0 * kd;
			const dead = kd === 1 ? dead0 : dead0 * kd;
			// The dam-level triggers read the storage at the entered capacity's scale.
			const qLevel = kd === 1 ? qPrev : kd > 0 ? qPrev / kd : 0;
			if (CAPS && !near(CAPS[t]!, cap, cap0)) return `${where}: dam_capacity ${CAPS[t]} ≠ the capacity ${cap0} × ${kd}`;
			const df = DF[t]!;
			if (!near(f, df * (Math.max(0, gr) - ef), df * Math.max(Math.abs(gr), Math.abs(ef))) || f < 0)
				return `${where}: crop requirement ${f} ≠ ${scaled ? `demand factor ${df} × (` : ''}MAX(0, gross ${gr}) − effective rain used ${ef}${scaled ? ')' : ''}`;
			const lvl = LV ? LV[t]! : 0;
			const dr = DR ? DR[t]! : d;
			if (objs) {
				const cuts = rule ? { cut: (c: DemandObject['category']) => checkedCut(rule, lvl, c), crop: f * (1 - checkedCut(rule, lvl, 'crops')) / e } : null;
				const bad = checkObjectsDay(objs, t, (monthOfEpochDay(day0 + t) + 2) % 12, df, f / e, gg, where, SC ? SC[t]! : df, KF ? KF[t]! : 1, t >= abstractFrom, objFactors, cuts);
				if (bad) return bad;
				let od = 0;
				for (const x of objs.demand) od += x[t]!;
				if (!near(d, f / e + od, Math.max(f, od))) return `${where}: demand ${d} ≠ crop requirement ${f} ÷ efficiency ${e} + the demand objects' ${od}`;
			} else if (!near(d, f / e, f)) return `${where}: demand ${d} ≠ crop requirement ${f} ÷ efficiency ${e}`;
			if (!near(k + l, h, 0) || k < 0 || k > h * n.pctUpstreamToDam + tol(h)) return `${where}: upstream split K ${k} + L ${l} ≠ H ${h}`;
			if (!near(m + nn, i, 0) || m < 0 || m > i * n.pctRunoffToDam + tol(i)) return `${where}: runoff split M ${m} + N ${nn} ≠ I ${i}`;
			const divCap = divertCapacityToday(divertOf, monthOfEpochDay(day0 + t));
			if (o < 0 || o > Math.min(divCap, l + nn) + tol(l + nn)) return `${where}: diverted ${o} outside [0, MIN(capacity ${divCap}, L + N)]`;
			{
				// River to dam's replay (docs/model.md §2.7c, §2.7h): O₀ = MIN(capacity, L + N), then the senior
				// users' pass and the hands-off flow cut it, so S = MAX(L + N − O₀, MIN(Zs, H + I), MIN(L + N, keep)).
				// They cut K and M only once O is 0 (the pass, and the hands-off flow on a farm with no dam today).
				const ror = sup !== undefined && sup.rule === 3;
				const K0 = ror ? 0 : Math.min(h * n.pctUpstreamToDam, h);
				const M0 = ror ? 0 : Math.min(i * n.pctRunoffToDam, i);
				const hk = ops.handsOff ? handsOffToday(ops.handsOff, monthOfEpochDay(day0 + t), Zc[t]!) : 0;
				const zs = ZS?.[t] ?? 0;
				if (k === K0 && m === M0) {
					const o0 = ror ? 0 : Math.min(divCap, l + nn);
					const wantO = Math.max(0, Math.min(o0, l + nn - Math.max(Math.min(zs, h + i), Math.min(l + nn, hk))));
					if (!near(o, wantO, Math.max(l, nn, zs, hk)))
						return `${where}: diverted ${o} ≠ ${wantO} (MIN(capacity ${divCap}, L + N) less what passes for ${zs > 0 ? `the senior requirement ${zs}${hk > 0 ? ' and ' : ''}` : ''}${hk > 0 ? `the hands-off flow ${hk}` : ''})`;
				} else if (o !== 0) return `${where}: took less of K or M into the dam (${k} of ${K0}, ${m} of ${M0}) while still diverting ${o}`;
			}
			const area = AREA![t]!, pd = PD![t]!, ev = EV![t]!, sp = SP![t]!;
			const c = curve && cap > 0 && qPrev > 0 ? curveAreaAt(curve, kd === 1 ? qPrev : qPrev / kd) : null;
			const onCurve = c && kd !== 1 ? { area: c.area, slope: c.slope / kd } : c;
			const a = !(cap > 0 && qPrev > 0) ? 0 : onCurve ? onCurve.area : areaFull * Math.pow(Math.min(qPrev / cap, 1), b);
			if (!near(area, a, a)) return `${where}: dam area ${area} ≠ ${onCurve ? 'the survey curve at' : `A_full ${areaFull} × (`}Q[t−1] ${qPrev}${onCurve ? '' : ` / capacity ${cap})^${b}`}`;
			const pdWant = (damRain(t) * a) / 1000;
			const there = Math.max(qPrev + pdWant + j, 0);
			const evRaw = (evapMmDay[t]! * a) / 1000;
			const limited = onCurve
				? a > 0 && qPrev * onCurve.slope > a
					? Math.min(evRaw, ((1 - seep) * a) / onCurve.slope)
					: evRaw
				: b > 1
					? Math.min(evRaw, ((1 - seep) * qPrev) / b)
					: evRaw;
			const evWant = Math.min(limited, there);
			// A dam with no capacity today (engine ≥ 1.30.0: filled with sediment, or not in service yet) holds
			// nothing to seep: yesterday's water spills.
			const spWant = cap > 0 ? Math.min(seep * qPrev, there - evWant) : 0;
			if (!near(pd, pdWant, qPrev) || !near(ev, evWant, qPrev) || !near(sp, spWant, qPrev))
				return `${where}: rain on dam ${pd} / evaporation ${ev} / seepage ${sp} ≠ ${pdWant} / ${evWant} / ${spWant}`;
			const s0 = qPrev + pd - ev - sp;
			if (s0 + j < -tol(qPrev)) return `${where}: the dam losses and transfers take it below empty (${s0 + j})`;
			const xin = XIN?.[t] ?? 0;
			const xused = XUSED?.[t] ?? 0;
			const xdam = XDAM?.[t] ?? 0;
			const xout = XOUT?.[t] ?? 0;
			const xret = XRET?.[t] ?? 0;
			if (XIN) {
				let delivered = 0;
				let toppers = 0;
				for (const r of topUps!) {
					const v = r.volume[t]! * (1 - r.loss);
					delivered += v;
					if (r.topUp) toppers += v;
				}
				if (!near(xin, delivered, delivered)) return `${where}: off-take water in ${xin} ≠ what its rules took less their losses, ${delivered}`;
				if (!near(xused, Math.min(xin, dr, RS?.[t] ?? Infinity), Math.max(xin, d))) return `${where}: off-take water used ${xused} ≠ MIN(what arrived ${xin}, demand ${dr}${RS ? `, the allocation room ${RS[t]}` : ''})`;
				const rest = xin - xused;
				const wantDam = rest > 0 && toppers > 0 ? Math.min(rest, (rest * toppers) / xin) : 0;
				if (!near(xdam, wantDam, xin)) return `${where}: off-take water into the dam ${xdam} ≠ ${wantDam} (the top-up rules' share of the ${rest} left)`;
			}
			const xpass = xin - xused - xdam;
			// The unit's own sources supply what the off-take water didn't.
			const dl = xused > 0 ? dr - xused : dr;
			const avail0 = s0 + m + o + k + j + xdam;
			const availScale = Math.max(Math.abs(qPrev), pd, ev, sp, m, o, k, Math.abs(j), dead, d, xin);
			// Release (WP-3.5), before irrigation.
			const x = REL?.[t] ?? 0;
			if (rel) {
				const month = monthOfEpochDay(day0 + t);
				const passing = l + nn - o;
				const want =
					rel.rule === 1
						? Math.max(0, Math.min(m + o + k, (rel.m3DayByMonth ? rel.m3DayByMonth[month]! : Zc[t]!) - passing, rel.outletM3Day, Math.max(avail0, 0)))
						: Math.max(0, Math.min(rel.m3DayByMonth![month]!, rel.outletM3Day, Math.max(avail0, 0) - dead));
				if (x < 0 || x > rel.outletM3Day + tol(x)) return `${where}: release ${x} outside [0, outlet ${rel.outletM3Day}]`;
				if (!near(x, want, availScale)) return `${where}: release ${x} ≠ ${want} (${rel.rule === 1 ? 'pass inflow' : 'fixed'} rule)`;
			}
			const avail = avail0 - x;
			const surface = Math.max(avail - dead, 0);
			const gw = GW?.[t] ?? 0;
			const gd = GD?.[t] ?? 0;
			const dep = DEP?.[t] ?? 0;
			// The river pump (WP-3.8): what it may take today, from the flow below the dam above what must pass it.
			const gRiv = RA?.[t] ?? 0;
			let room = 0;
			let keep = 0;
			if (sup) {
				if (sup.rule === 3 && (k !== 0 || m !== 0 || o !== 0)) return `${where}: run of river has no dam, but K ${k}, M ${m}, O ${o} went into it`;
				onRiver = sup.rule !== 2 || (onRiver ? qLevel < sup.stopM3 : qLevel < sup.triggerM3);
				const month = monthOfEpochDay(day0 + t);
				keep = Math.max(ZS?.[t] ?? 0, rel && rel.rule === 1 ? (rel.m3DayByMonth ? rel.m3DayByMonth[month]! : Zc[t]!) : 0, ops.handsOff ? handsOffToday(ops.handsOff, month, Zc[t]!) : 0);
				if (onRiver) room = Math.max(0, Math.min(sup.pumpM3Day, ss - keep));
				if (gRiv < 0 || gRiv > sup.pumpM3Day + tol(gRiv)) return `${where}: pumped ${gRiv} from the river, outside [0, pump capacity ${sup.pumpM3Day}]`;
				if (gRiv > Math.max(0, ss - keep) + tol(Math.max(ss, keep))) return `${where}: pumped ${gRiv} from the river, more than the ${ss} below the dam less the ${keep} that must pass`;
			}
			// Boreholes: primary pump first, dam-target ones into the dam, supplemental (and emergency, while the dam is below its trigger) top up what the dam leaves.
			// The surface's room under an allocation cap, after the off-take water used (Infinity without one).
			const sLeft = (RS?.[t] ?? Infinity) - xused;
			const rp = replay(t, dl, qLevel, avail, dead, cap, room, sup?.rule ?? 1, sLeft, RG?.[t] ?? Infinity);
			let wantGs: number;
			let wantGr = 0;
			const dsl = Math.min(dl, sLeft);
			if (bore) {
				wantGs = rp.surface;
				wantGr = rp.river;
			} else if (sup && sup.rule === 3) {
				wantGs = Math.min(surface, dsl);
				wantGr = Math.max(0, Math.min(room, dsl - wantGs));
			} else {
				wantGr = Math.max(0, Math.min(room, dsl));
				wantGs = Math.min(surface, dsl - wantGr);
			}
			if (!near(gRiv, wantGr, Math.max(ss, d, keep))) return `${where}: pumped ${gRiv} from the river ≠ ${wantGr} (supply rule ${sup?.rule}, ${onRiver ? 'on the river' : 'on the dam'})`;
			if (!near(gw, rp.direct, Math.max(availScale, d))) return `${where}: groundwater ${gw} ≠ ${rp.direct} (borehole supply order and caps)`;
			if (!near(gd, rp.dam, Math.max(availScale, d, cap))) return `${where}: groundwater into the dam ${gd} ≠ ${rp.dam}`;
			if (gd > 0 && avail + gd > cap + tol(Math.max(cap, availScale))) return `${where}: pumped ${gd} into a dam with no room for it`;
			if (!near(gg - xused - gw - gRiv, wantGs, Math.max(availScale, gd, gRiv)))
				return `${where}: supplied ${gg} ≠ MIN(MAX(Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J${gd ? ' + groundwater into the dam' : ''} − dead storage ${dead}, 0), D ${dr}${DR ? ' after the drought restriction' : ''})${bore ? ` + groundwater ${gw}` : ''}${sup ? ` + from the river ${gRiv}` : ''}`;
			if (!near(p, avail + gd - (gg - xused - gw - gRiv), Math.max(availScale, gg, gd))) return `${where}: interim storage ${p} ≠ Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J + groundwater into the dam − what the dam gave`;
			if (!near(q, Math.min(p, cap), cap) || !near(r, Math.max(p - cap, 0), cap)) return `${where}: storage ${q} / spill ${r} don't split interim storage ${p} at capacity ${cap}`;
			if (!near(ss, l + nn - o, Math.max(l, nn, o))) return `${where}: below-dam flow S ${ss} ≠ L + N − O`;
			if (ZS) {
				// Senior users below (WP-1.33): the farm passes MIN(Zs, H + I) below the dam, and keeps nothing back without them.
				let zIn = 0;
				for (const a of upZS) zIn += a![t]!;
				const zs = ZS[t]!;
				const pass = PASSED![t]!;
				if (zs < zIn - tol(zIn)) return `${where}: senior requirement ${zs} below the ${zIn} arriving from upstream`;
				if (ss < Math.min(zs, h + i) - tol(Math.max(h + i, zs))) return `${where}: below-dam flow S ${ss} does not pass the senior requirement MIN(${zs}, H + I)`;
				if (pass < -tol(0) || (zs === 0 && pass !== 0)) return `${where}: kept back ${pass} for a senior requirement of ${zs}`;
			}
			if (!near(tt, unitReturn(gg, returnPerSupplied, objs, t), gg))
				return objs ? `${where}: return flow ${tt} ≠ β·(1 − e) × the crops' part of G + Σ each demand object's return share × its part` : `${where}: return flow ${tt} ≠ β·(1 − e)·G = G × ${returnPerSupplied}`;
			const spl = SPL?.[t] ?? 0;
			if (!near(spl, sp * (1 - seepRet), sp)) return `${where}: seepage lost ${spl} ≠ seepage ${sp} × (1 − return ${seepRet})`;
			if (!near(u, r + (ss - gRiv) + tt + (sp - spl) + x + xpass - dep - xout + xret, Math.max(r, ss, tt, sp, x, xin, xout, xret)))
				return `${where}: outflow ${u} ≠ R + S${sup ? ' − from the river' : ''} + T + returned seepage${rel ? ' + release' : ''}${XIN ? ' + off-take water passed on' : ''}${bore ? ' − stream depletion' : ''}${XOUT ? ' − taken by river off-takes' : ''}${XRET ? ' + off-take losses seeping back' : ''}`;
			const vv = h + i + j + pd + gw + gd + xin + xret - xout - (gg - tt) - ev - (q - qPrev) - u - dep - spl;
			const scale = Math.max(Math.abs(h), Math.abs(i), Math.abs(j), Math.abs(gg), Math.abs(q), Math.abs(qPrev), Math.abs(u), pd, ev, gw, gd, xin, xout, xret);
			if (Math.abs(v - vv) > tol(scale) || Math.abs(v) > tol(scale)) return `${where}: balance check V ${v} (recomputed ${vv}) is not float noise`;
			qPrev = q;
		}
	}
	return null;
}

/**
 * The river off-takes into unit `nodeId` (engine ≥ 1.14.0) that the run
 * moves water with: each one's stored daily volume (what it took, before
 * losses), its loss share and whether it tops up the dam. An error when a
 * rule that can move water has no stored volume.
 */
function offtakeInto(input: ModelInput, nodeId: string, get: SeriesMap): { volume: number[]; loss: number; topUp: boolean }[] | string {
	const out: { volume: number[]; loss: number; topUp: boolean }[] = [];
	const warnings: string[] = [];
	for (const tr of input.model.transfers) {
		if (!tr.enabled || !isRiverOfftake(tr) || tr.toNodeId !== nodeId || !canMove(tr)) continue;
		const v = get.get(`${tr.fromNodeId}|${transferRuleKey(tr.id)}`);
		if (!v) continue;
		const o = offtakeOf(tr, 0, 0, '', '', warnings);
		out.push({ volume: v, loss: o.loss, topUp: o.topUpDam });
	}
	return out;
}

/**
 * A unit's demand objects on day t (engine ≥ 1.7.0, docs/model.md §2.7f):
 * each one's demand is its month's value × the day's demand factor `df`
 * (the scenario's restriction `sc` × a full allocation's factor `alloc`, 0
 * before the unit abstracts), where a restriction (sc < 1) never takes an
 * object with a basic-needs floor below MIN(floor, its unrestricted demand),
 * nor does a full allocation's factor on a restricted day (engine ≥ 1.44.0);
 * each gets between 0 and its demand, together no more than G; classes are
 * served in order (a later class, or the crops after class 0, gets water
 * only once every earlier one is met), and within a class every member
 * (the crops, demand `crop`, in class 1) gets the same share of its demand.
 */
function checkObjectsDay(
	objs: ObjectColumns,
	t: number,
	wy: number,
	unitDf: number,
	crop: number,
	G: number,
	where: string,
	unitSc = unitDf,
	alloc = 1,
	abstracts = true,
	factors: { df: Float64Array; sc: Float64Array }[] | null = null,
	/** The drought restriction's cut today (engine ≥ 1.54.0): each object shares by its cut demand, the crops by theirs. */
	restriction: { cut: (c: DemandObject['category']) => number; crop: number } | null = null
): string | null {
	const n = objs.demand.length;
	let got = 0;
	if (restriction) crop = restriction.crop;
	let scale = Math.max(G, crop);
	for (let k = 0; k < n; k++) scale = Math.max(scale, objs.demand[k]![t]!);
	const eps = tol(scale);
	const share = [NaN, NaN, NaN];
	const want = [0, crop, 0];
	const gotBy = [0, 0, 0];
	for (let k = 0; k < n; k++) {
		// What it asks its unit for: its demand, cut by the drought restriction when the rule is on (engine ≥ 1.54.0).
		const d = restriction ? checkedObjectDemand(objs.demand[k]![t]!, restriction.cut(objs.category[k]!), objs.floor[k]!) : objs.demand[k]![t]!;
		const g = objs.supplied[k]![t]!;
		const sf = objs.schedule[k] ? objs.schedule[k]![t]! : 1;
		const fl = objs.floor[k];
		// Its own factor (engine ≥ 1.45.0): the unit's × its category's.
		const df = factors ? factors[k]!.df[t]! : unitDf;
		const sc = factors ? factors[k]!.sc[t]! : unitSc;
		const floored = fl !== null && abstracts && sc < 1;
		// Restricted: MAX(demand × sc, MIN(floor, demand)); a full allocation's factor then scales it, holding that floor too.
		const pre = floored ? Math.max(objs.monthly[k]![wy]! * sc * sf, dayFloor(fl!, objs.monthly[k]![wy]! * sf)) : 0;
		const expect = floored ? Math.max(alloc * pre, dayFloor(fl!, pre)) : objs.monthly[k]![wy]! * df * sf;
		if (Math.abs(objs.demand[k]![t]! - expect) > tol(expect))
			return `${where}: demand object ${k}'s demand ${objs.demand[k]![t]} ≠ its month's ${objs.monthly[k]![wy]} × demand factor ${df}${objs.schedule[k] ? ` × schedule factor ${sf}` : ''}${floored ? `, held at its basic-needs floor ${fl}` : ''}`;
		if (g < -eps || g > d + eps) return `${where}: demand object ${k} got ${g}, outside [0, its demand ${d}${restriction ? ' after the drought restriction' : ''}]`;
		got += g;
		want[objs.tier[k]!]! += d;
		gotBy[objs.tier[k]!]! += g;
		if (d > eps) {
			const s = g / d;
			const c = share[objs.tier[k]!]!;
			if (c === c && Math.abs(c - s) > 1e-9) return `${where}: demand objects of one priority got different shares of their demand (${c} vs ${s})`;
			share[objs.tier[k]!] = s;
		}
	}
	if (got > G + eps) return `${where}: the demand objects got ${got}, more than the ${G} the unit was supplied`;
	// The crops' part is what the objects didn't get; in class 1 it takes the class's share.
	const cropGot = G - got;
	gotBy[1]! += cropGot;
	if (crop > eps && share[1] === share[1] && Math.abs(cropGot / crop - share[1]!) > 1e-9 * Math.max(1, scale / crop)) return `${where}: the crops got ${cropGot} of ${crop}, not the share ${share[1]} the demand objects they share with got`;
	for (let c = 1; c < 3; c++) {
		if (!(gotBy[c]! > eps)) continue;
		for (let e = 0; e < c; e++) if (gotBy[e]! < want[e]! - eps) return `${where}: a later priority class got water while class ${e} was short (${gotBy[e]} of ${want[e]})`;
	}
	return null;
}

/**
 * Boreholes and stream depletion (WP-1.34, WP-3.9, docs/model.md §2.7d), on
 * every farm and other user with boreholes:
 * - 0 ≤ groundwater to the crop ≤ supplied, 0 ≤ into the dam, and together
 *   ≤ Σ the pumping units' capacities;
 * - the lag store S[t] = S[t−1] + infeed − due, due = α × (S[t−1] + infeed),
 *   S ≥ 0, starting empty, with the day's infeed between the smallest and the
 *   largest depletion factor × what was pumped;
 * - the deficit carries over (engine ≥ 1.10.0): taken + deficit[t] =
 *   deficit[t−1] + due, both ≥ 0, starting at 0, and a deficit only when
 *   nothing flows out, so the river never goes negative and is repaid first;
 * - volume is conserved: Σ taken + the deficit at the end = Σ due (depletion
 *   generated), Σ infeed = Σ due + S at the end, and Σ infeed = Σ over the
 *   boreholes of d × their volume
 *   (RunSummary.groundwaterAnnualUse);
 * - groundwaterAnnualUse has one row per water year of the run, its volumes
 *   add up to the daily columns and over its boreholes, and no borehole
 *   pumps more than its annual cap in a water year.
 * A node without boreholes has none of these columns or rows.
 */
export function checkGroundwater(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const bores = boreholesByNode(input.model, []);
	const annual = out.summary.groundwaterAnnualUse ?? [];
	const day0 = toEpochDay(out.startDate);
	for (const n of input.model.nodes) {
		const b = boreholeOf(n, bores.get(n.id) ?? [], []).borehole;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const rows = annual.filter((r) => r.nodeId === n.id);
		if (!b) {
			if (g('groundwater_used') || g('groundwater_to_dam')) return `${n.id}: groundwater series without boreholes`;
			if (rows.length) return `${n.id}: groundwater annual use without boreholes`;
			continue;
		}
		const [GW, DEP, UN, ST, G, U] = ['groundwater_used', 'baseflow_depletion', 'depletion_deficit', 'depletion_store', 'supplied', 'outflow'].map(g);
		if (!GW || !DEP || !UN || !ST || !G || !U) return `${n.id}: groundwater series missing`;
		const GD = g('groundwater_to_dam');
		const capSum = b.units.reduce((s, u) => s + u.capacityM3Day, 0);
		const dMin = Math.min(...b.units.map((u) => u.depletionFrac));
		const dMax = Math.max(...b.units.map((u) => u.depletionFrac));
		let prev = 0;
		let owedBefore = 0;
		let infeed = 0;
		let generated = 0;
		let taken = 0;
		let row = -1;
		let wy = NaN;
		const sums = rows.map(() => ({ days: 0, all: 0, dam: 0, dep: 0 }));
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const gw = GW[t]!;
			const gd = GD?.[t] ?? 0;
			if (gw < 0 || gw > G[t]! + tol(G[t]!) || gd < 0 || gw + gd > capSum + tol(capSum)) return `${where}: groundwater ${gw} outside [0, MIN(Σ capacity ${capSum}, supplied ${G[t]})]${gd ? ` (with ${gd} into the dam)` : ''}`;
			const scale = Math.max(prev, U[t]! + DEP[t]!, gw + gd);
			// One depletion factor: the infeed is d × pumped. Several: it lies between the smallest and largest share of it.
			// Worked back from the store and the deficit, the infeed carries their float noise too: a deficit of
			// 6.2e9 m³ (ulp 9.5e-7) left 1.2e-6 m³ on a day nothing was pumped (fuzz seed 10306).
			const inf = dMin === dMax ? dMin * (gw + gd) : ST[t]! + DEP[t]! + UN[t]! - owedBefore - prev;
			const infScale = dMin === dMax ? scale : Math.max(scale, ST[t]!, UN[t]!, owedBefore);
			if (inf < dMin * (gw + gd) - tol(infScale) || inf > dMax * (gw + gd) + tol(infScale)) return `${where}: depletion infeed ${inf} outside [${dMin}, ${dMax}] × pumped ${gw + gd}`;
			const inStore = prev + inf;
			const due = b.depletionAlpha * inStore;
			const owed = owedBefore + due;
			if (DEP[t]! < 0 || UN[t]! < -tol(0) || Math.abs(DEP[t]! + UN[t]! - owed) > tol(Math.max(scale, inStore, owed)))
				return `${where}: depletion ${DEP[t]} + deficit ${UN[t]} ≠ yesterday's deficit ${owedBefore} + due ${due}`;
			if (Math.abs(ST[t]! - (inStore - due)) > tol(Math.max(scale, inStore)) || ST[t]! < -tol(scale)) return `${where}: depletion store ${ST[t]} ≠ ${inStore - due}`;
			if (U[t]! < -tol(scale)) return `${where}: stream depletion took the river below 0 (outflow ${U[t]})`;
			if (UN[t]! > tol(Math.max(scale, owed)) && U[t]! > tol(Math.max(scale, owed))) return `${where}: depletion deficit ${UN[t]} left owed while ${U[t]} still flowed`;
			infeed += inf;
			generated += due;
			taken += DEP[t]!;
			prev = ST[t]!;
			owedBefore = UN[t]!;
			const y = waterYearOfDay(day0 + t);
			if (y !== wy) {
				wy = y;
				row++;
				if (rows[row]?.waterYear !== y) return `${n.id}: groundwater annual use has no row for water year ${y}`;
			}
			const s = sums[row]!;
			s.days++;
			s.all += gw + gd;
			s.dam += gd;
			s.dep += DEP[t]!;
		}
		if (rows.length !== row + 1) return `${n.id}: groundwater annual use has ${rows.length} rows for ${row + 1} water years`;
		if (Math.abs(infeed - generated - prev) > 1e-9 * Math.max(1, infeed)) return `${n.id}: the depletion lag does not conserve volume: Σ infeed ${infeed} ≠ Σ due ${generated} + still to come ${prev}`;
		if (Math.abs(generated - taken - owedBefore) > 1e-9 * Math.max(1, generated)) return `${n.id}: the depletion deficit does not conserve volume: Σ due ${generated} ≠ Σ taken ${taken} + owed at the end ${owedBefore}`;
		let byBorehole = 0;
		for (const [k, r] of rows.entries()) {
			const s = sums[k]!;
			const where = `${n.id} water year ${r.label}`;
			if (r.days !== s.days || Math.abs(r.abstractionM3 - s.all) > tol(s.all) || Math.abs(r.toDamM3 - s.dam) > tol(s.all) || Math.abs(r.streamDepletionM3 - s.dep) > tol(s.dep))
				return `${where}: annual use ${r.abstractionM3} / into the dam ${r.toDamM3} / depletion ${r.streamDepletionM3} over ${r.days} days ≠ the daily columns ${s.all} / ${s.dam} / ${s.dep} over ${s.days}`;
			if (r.boreholes.length !== b.units.length) return `${where}: ${r.boreholes.length} boreholes ≠ ${b.units.length}`;
			let sum = 0;
			for (const [j, u] of r.boreholes.entries()) {
				const unit = b.units[j]!;
				if (u.abstractionM3 < 0 || u.abstractionM3 > unit.capacityM3Day * r.days + tol(unit.capacityM3Day * r.days)) return `${where}: borehole ${u.name} pumped ${u.abstractionM3}, more than its capacity allows`;
				if (u.annualCapM3 !== null && u.abstractionM3 > u.annualCapM3 + tol(u.annualCapM3)) return `${where}: borehole ${u.name} pumped ${u.abstractionM3} over its annual cap ${u.annualCapM3}`;
				sum += u.abstractionM3;
				byBorehole += unit.depletionFrac * u.abstractionM3;
			}
			if (Math.abs(sum - r.abstractionM3) > tol(r.abstractionM3)) return `${where}: the boreholes' ${sum} ≠ the node's ${r.abstractionM3}`;
		}
		if (Math.abs(byBorehole - infeed) > 1e-9 * Math.max(1, infeed)) return `${n.id}: Σ d × each borehole's volume ${byBorehole} ≠ the depletion infeed ${infeed}`;
	}
	for (const r of annual) if (!input.model.nodes.some((n) => n.id === r.nodeId)) return `groundwater annual use for unknown node ${r.nodeId}`;
	return null;
}

/**
 * Land-cover streamflow reductions (WP-1.35, docs/model.md §2.5a), from the
 * run's own natural flow and the model's patches:
 * - a farm with land cover: runoff I + reduction = natural flow × its share,
 *   0 ≤ reduction ≤ that natural runoff, and the reduction is
 *   lowFlow × MIN(I0, q) + mar × MAX(I0 − q, 0) with q = share × the natural
 *   flow exceeded 75 % of the days;
 * - the catchment `landcover_reduction` is the sum over the farms, and the
 *   summary's mean and class split add up to it;
 * - without land cover there is no reduction series or summary.
 */
export function checkLandCover(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const cover = resolveLandCover(input.model, []);
	const total = get.get('null|landcover_reduction');
	const any = cover.some(Boolean);
	if (!any) return total || out.summary.landCover ? 'land-cover reduction reported without land cover' : null;
	if (!total || !out.summary.landCover) return 'land-cover reduction series or summary missing';
	const natural = get.get('null|natural_flow')!;
	const d = defaultProjectSettings();
	const method = ['area', 'hiLo', 'manual'].includes(String(input.settings.flowShareMethod)) ? (input.settings.flowShareMethod as 'area' | 'hiLo' | 'manual') : d.flowShareMethod;
	const share = flowShares(input.model.nodes, method, { ...d.hiLoSplit, ...((input.settings.hiLoSplit as object | undefined) ?? {}) }).share;
	const q0 = lowFlowThreshold(natural.slice(0, out.summary.historyDays ?? natural.length));
	if (Math.abs(out.summary.landCover.lowFlowThresholdM3Day - q0) > tol(q0)) return `land-cover low-flow threshold ${out.summary.landCover.lowFlowThresholdM3Day} ≠ ${q0}`;
	const sum = new Float64Array(out.days);
	for (const [i, n] of input.model.nodes.entries()) {
		const u = cover[i];
		const red = get.get(`${n.id}|landcover_reduction`);
		if (!u) {
			if (red) return `${n.id}: land-cover reduction without land cover`;
			continue;
		}
		if (!red) return `${n.id}: land-cover reduction series missing`;
		const I = get.get(`${n.id}|runoff`)!;
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const i0 = natural[t]! * share[i]!;
			if (Math.abs(I[t]! + red[t]! - i0) > tol(i0)) return `${where}: runoff ${I[t]} + land-cover reduction ${red[t]} ≠ natural × share ${i0}`;
			const want = landCoverReduction(i0, q0 * share[i]!, u);
			if (red[t]! < 0 || red[t]! > i0 + tol(i0) || Math.abs(red[t]! - want) > tol(i0)) return `${where}: land-cover reduction ${red[t]} ≠ ${want}`;
			sum[t]! += red[t]!;
		}
	}
	let tot = 0;
	for (let t = 0; t < out.days; t++) {
		if (Math.abs(total[t]! - sum[t]!) > tol(sum[t]!)) return `day ${t}: catchment land-cover reduction ${total[t]} ≠ Σ farms ${sum[t]}`;
		tot += total[t]!;
	}
	const lc = out.summary.landCover;
	const mean = out.days ? tot / out.days : 0;
	const byClass = lc.byClass.reduce((a, c) => a + c.reductionM3Day, 0);
	if (Math.abs(lc.reductionM3Day - mean) > 1e-9 * Math.max(1, mean) || Math.abs(byClass - mean) > 1e-9 * Math.max(1, mean)) return `land-cover summary ${lc.reductionM3Day} (classes ${byClass}) ≠ the series mean ${mean}`;
	return null;
}

/**
 * Each farm's soil-water store (N3, engine ≥ 0.14.0, ../demand.ts
 * farmDailyDemand), redone from the run's own rain (rain_final, zeroed at or
 * below the threshold) and settings, every day:
 * - 0 ≤ store ≤ its size (effectiveRainStoreMm);
 * - effective rain used = MIN(store[t−1] + Pe, MAX(0, gross)) ≥ 0, so it
 *   never takes more than the store held plus the day's effective rain Pe;
 * - store = MIN(size, store[t−1] + Pe − used): nothing appears from nowhere;
 * - over the run, Σ used ≤ Σ Pe: the store hands out no more rain than fell.
 * A run from before engine 0.14.0 has no soil_water column: nothing to check.
 */
export function checkSoilWater(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const d = defaultProjectSettings();
	const s = input.settings ?? {};
	const one = typeof s.effectiveRainFraction === 'number' ? s.effectiveRainFraction : d.effectiveRainFraction;
	// Monthly fractions (engine ≥ 0.43.0, issue #54): used only when all twelve are in [0, 1], as runModel does.
	const fm = s.effectiveRainFractionMonthly;
	const monthlyFraction = Array.isArray(fm) && fm.length === 12 && fm.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1) ? fm : null;
	const day0 = toEpochDay(out.startDate);
	const fraction = (t: number) => (monthlyFraction ? monthlyFraction[(monthOfEpochDay(day0 + t) + 2) % 12]! : one);
	const size = s.effectiveRainStoreMm;
	// runModel falls back to the default for a size that isn't one (and warns).
	const sizeMm = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : d.effectiveRainStoreMm;
	const thr = (s.calibration as { rainThresholdMm?: number } | undefined)?.rainThresholdMm ?? d.calibration.rainThresholdMm;
	const rainFinal = get.get('null|rain_final');
	const rain = Array.from({ length: out.days }, (_, t) => {
		const v = rainFinal?.[t];
		return typeof v === 'number' && Number.isFinite(v) && v > thr ? v : 0;
	});
	const cropIds = new Set(input.model.crops.map((c) => c.id));
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const W = get.get(`${n.id}|soil_water`);
		if (!W) continue;
		const used = get.get(`${n.id}|effective_rain`);
		const gross = get.get(`${n.id}|gross_demand`);
		if (!used || !gross) return `${n.id}: effective rain or gross demand column missing`;
		let area = 0;
		for (const ca of input.model.cropAreas) if (ca.nodeId === n.id && cropIds.has(ca.cropId)) area += ca.areaM2;
		const toM3 = area / 1000;
		const sizeM3 = sizeMm * toM3;
		let prev = 0;
		let sumUsed = 0;
		let sumPe = 0;
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const w = W[t]!;
			const u = used[t]!;
			const pe = area * (fraction(t) / 1000) * rain[t]!;
			const available = prev + pe;
			const scale = Math.max(available, Math.abs(gross[t]!), sizeM3);
			if (w < -tol(sizeMm) || w > sizeMm + tol(sizeMm)) return `${where}: soil-water store ${w} mm outside 0 … ${sizeMm} mm`;
			if (u < 0 || Math.abs(u - Math.min(available, Math.max(0, gross[t]!))) > tol(scale))
				return `${where}: effective rain used ${u} ≠ MIN(store ${prev} + effective rain ${pe}, gross ${gross[t]}) m³`;
			const wM3 = w * toM3;
			if (Math.abs(wM3 - Math.min(sizeM3, available - u)) > tol(scale))
				return `${where}: soil-water store ${wM3} m³ ≠ MIN(size ${sizeM3}, ${prev} + ${pe} − ${u})`;
			sumUsed += u;
			sumPe += pe;
			prev = wM3;
		}
		if (sumUsed > sumPe + tol(sumPe)) return `${n.id}: effective rain used ${sumUsed} m³ over the run > effective rain ${sumPe} m³`;
	}
	return null;
}

/**
 * EWR shortfall attribution (engine ≥ 0.17.0, audit Q17; docs/model.md
 * §2.7b), from the run's own series. Sites are the outlet (the catchment
 * series) and every other gauge that is an EWR site (engine ≥ 1.5.0).
 * - per site per day: charged + natural = shortfall, both ≤ 0, and a day the
 *   EWR is met has neither;
 * - per farm per day: charge ≤ irrigation part ≤ 0, and the irrigation part is
 *   at most the farm's consumptive irrigation G − T;
 * - the stored per-rule transfer volumes (engine ≥ 1.6.0,
 *   network/transferSeries.ts): one for every rule that can move water or
 *   none (an older run), each ≥ 0, and at every farm they add up to its net
 *   transfer J;
 * - per site per day, with e = H + I + J_int − U for each farm upstream
 *   (J_int: only the rules with both ends upstream of the site), the charged
 *   part is MIN(shortfall, Σ MAX(e, 0)), each farm's share is
 *   charged × MAX(e, 0) / Σ MAX(e, 0), and a farm's charge is at least that
 *   share (it carries the largest over its sites) and, when every site it is
 *   upstream of can be recomputed, exactly the largest. With the per-rule
 *   volumes every site can be; a run saved before 1.6.0 stores none, and
 *   there a site is recomputed only where no rule crosses its catchment
 *   boundary (always at the outlet), since J is then J_int;
 * - Σ farm charges upstream of a site ≥ the site's charged part;
 * - the stored binding site (engine ≥ 1.5.0, farms upstream of two or more
 *   sites): given exactly on the days the farm is charged, one of the sites
 *   below it, and, where that site can be recomputed, the charge is exactly
 *   the farm's share there. That checks a charge set at an exact site even
 *   when another site above the farm is crossed by a transfer.
 * Runs saved before 0.17.0 have no attribution series: nothing to check.
 */
export function checkEwrAttribution(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const nodes = input.model.nodes;
	// Farms and other water users (WP-1.33) are charged; gauges only measure.
	const farms = nodes.filter((n) => n.kind !== 'gauge');
	if (farms.length && !get.has(`${farms[0]!.id}|ewr_charge`)) return null;
	const outlet = nodes.find((n) => n.downstreamNodeId === null);
	if (!outlet) return null;
	// The EWR sites (engine ≥ 1.5.0: a gauge whose ewrSite flag is false isn't one).
	// In the engine's order (outlet, then gauges by id): the stored binding site is an index into it.
	const sites = [outlet, ...nodes.filter((n) => n.kind === 'gauge' && n !== outlet && n.ewrSite !== false).sort((a, b) => cmpStr(a.id, b.id))];
	const ancestors = (site: string) => {
		const set = new Set([site]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const n of nodes) {
				if (n.downstreamNodeId !== null && set.has(n.downstreamNodeId) && !set.has(n.id)) {
					set.add(n.id);
					grew = true;
				}
			}
		}
		return set;
	};
	const rules = farmRules(input.model.transfers, nodes);
	const col = (id: string, k: string) => get.get(`${id}|${k}`)!;
	// Each rule's daily volume (engine ≥ 1.6.0: a series for every rule that can move water; null for an older run, which stores none).
	const movable = rules.filter(canMove);
	const storedRules = movable.filter((r) => get.has(`${r.fromNodeId}|${transferRuleKey(r.id)}`)).length;
	if (storedRules > 0 && storedRules < movable.length) return `transfer rules: ${storedRules} of the ${movable.length} that can move water have a stored volume`;
	const ruleVol = readRuleVolumes(rules, out.days, (id, k) => get.get(`${id}|${k}`));
	if (ruleVol) {
		const err = checkRuleVolumes(rules, ruleVol, farms, get, out.days);
		if (err) return err;
	}
	const byRule = input.settings.ewrChargeSource === 'ruleTable';
	// River off-takes' seepage returning to the river (engine ≥ 1.42.0): each rule's daily return and the farm it joins.
	const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
	const returnLegs = ruleVol
		? rules.flatMap((r, k) => {
				if (!isRiverOfftake(r)) return [];
				const o = offtakeOf(r, 0, 0, '', '', []);
				const at = o.lossReturn > 0 ? offtakeReturnAt(r, nodeIndex.get(r.fromNodeId)!, nodes, nodeIndex) : undefined;
				return at === undefined ? [] : [{ source: r.fromNodeId, destination: r.toNodeId, at: nodes[at]!.id, volume: Float64Array.from(ruleVol[k]!, (v) => v * o.loss * o.lossReturn) }];
			})
		: [];
	const siteInfo = sites.map((s, si) => {
		const up = ancestors(s.id);
		const key = si === 0 ? 'null' : s.id;
		// A rule with one end inside counts at neither end here: without the per-rule volumes it can't be told apart from the farm's other transfers.
		// A river off-take (engine ≥ 1.14.0) isn't in the farms' J: with one, the per-rule volumes always count.
		const crossed = rules.some((r) => up.has(r.fromNodeId) !== up.has(r.toNodeId)) || rules.some(isRiverOfftake);
		return {
			name: s.id,
			key,
			farms: farms.filter((f) => up.has(f.id)),
			exact: !crossed || !!ruleVol,
			// The rules with both ends upstream, when the per-rule volumes say what each moved (J_int); null = the farms' own J.
			// A return rejoining upstream of the site moves into its farm from the destination (from the source when the destination is outside).
			internal: crossed && ruleVol
				? [
						...rules.flatMap((r, k) => (up.has(r.fromNodeId) && up.has(r.toNodeId) ? [{ from: r.fromNodeId, to: r.toNodeId, volume: ruleVol[k]! as ArrayLike<number> }] : [])),
						...returnLegs.flatMap((x) => (up.has(x.at) ? [{ from: up.has(x.destination) ? x.destination : x.source, to: x.at, volume: x.volume }] : []))
					]
				: null,
			// The shortfall the charge follows (engine ≥ 1.3.0): the rule table's where it drives the charge.
			D: get.get(`${key}|ewr_charge_shortfall`) ?? get.get(`${key}|ewr_shortfall`)!,
			charged: get.get(`${key}|ewr_charged`),
			natural: get.get(`${key}|ewr_natural`)
		};
	});
	for (const s of siteInfo) if (!s.charged || !s.natural) return `EWR site ${s.name}: no ewr_charged / ewr_natural series`;
	// settings.ewrChargeSource 'ruleTable' (engine ≥ 1.3.0): a site with a rule table (an ewr_rule series)
	// charges MIN(flow − the month's requirement, 0) inside complete months and the pragmatic shortfall
	// outside them; every other site, and every site under 'pragmatic', has no ewr_charge_shortfall.
	for (const [si, s] of siteInfo.entries()) {
		const own = get.get(`${s.key}|ewr_charge_shortfall`);
		const rule = get.get(`${s.key}|ewr_rule`);
		if (!!own !== (byRule && !!rule)) return `EWR site ${s.name}: ewr_charge_shortfall ${own ? 'present' : 'missing'} with the charge following the ${byRule ? 'rule table' : 'pragmatic EWR'}${rule ? '' : ' and no rule table'}`;
		if (!own || !rule) continue;
		const flow = si === 0 ? get.get('null|simulated_outflow')! : get.get(`${s.key}|outflow`)!;
		const prag = get.get(`${s.key}|ewr_shortfall`)!;
		for (let t = 0; t < out.days; t++) {
			const r = rule[t]!;
			// The engine's shortfall(): below the requirement by more than float noise (SHORTFALL_NOISE, 1e-12).
			const d = Number.isFinite(r) ? (flow[t]! - r < -1e-12 * Math.max(flow[t]!, r) ? flow[t]! - r : 0) : prag[t]!;
			if (!Object.is(own[t]! + 0, d + 0)) return `EWR site ${s.name} day ${t}: ewr_charge_shortfall ${own[t]} ≠ ${Number.isFinite(r) ? `MIN(flow − rule-table requirement, 0) = ${d}` : `the pragmatic shortfall ${d}`}`;
		}
	}
	const zeros = new Array<number>(out.days).fill(0);
	const F = new Map(
		farms.map((f) => {
			const user = f.kind === 'user';
			const G = col(f.id, 'supplied');
			const k = user ? 1 - Math.min(Math.max(f.userReturnPct ?? 0, 0), 1) : 1 - f.lossReturnFraction * (1 - runEfficiency(input, f));
			// A unit with demand objects (engine ≥ 1.7.0): consumptive use is G − T day by day, its objects returning their own shares.
			const T = !user && demandObjectsByNode(input.model, []).has(f.id) ? col(f.id, 'return_flow') : null;
			// A user has no runoff or transfers, and no irrigation-part series (checked as 0).
			return [f.id, { H: col(f.id, 'inflow_upstream'), I: user ? zeros : col(f.id, 'runoff'), J: user ? zeros : col(f.id, 'transfer'), U: col(f.id, 'outflow'), G, R: col(f.id, 'ewr_charge'), Ri: user ? zeros : col(f.id, 'ewr_charge_irrigation'), k, T }];
		})
	);
	const allExact = new Map(farms.map((f) => [f.id, siteInfo.every((s) => s.exact || !s.farms.includes(f))]));
	// The stored binding site, for every farm upstream of two or more sites (engine ≥ 1.5.0; older runs have none).
	const binding = new Map<string, ArrayLike<number>>();
	for (const f of farms) {
		const v = get.get(`${f.id}|${EWR_BINDING_SERIES.key}`);
		if (v) binding.set(f.id, v);
	}
	const best = new Map<string, number>();
	/** Each farm's share at each exact site today (the binding check reads the binding site's). */
	const shareAt = siteInfo.map(() => new Map<string, number>());
	for (let t = 0; t < out.days; t++) {
		best.clear();
		for (const m of shareAt) m.clear();
		for (const [si, s] of siteInfo.entries()) {
			const D = Math.max(-s.D[t]!, 0);
			const ch = -s.charged![t]!;
			const nat = -s.natural![t]!;
			const where = `EWR site ${s.name} day ${t}`;
			if (ch < 0 || nat < 0) return `${where}: charged ${-ch} and natural ${-nat} must be ≤ 0`;
			if (Math.abs(ch + nat - D) > tol(D)) return `${where}: charged ${-ch} + natural ${-nat} ≠ shortfall ${-D}`;
			if (D === 0 && (ch !== 0 || nat !== 0)) return `${where}: the EWR is met but ${-ch} is charged`;
			let sumR = 0;
			for (const f of s.farms) sumR -= F.get(f.id)!.R[t]!;
			if (sumR < ch - tol(ch)) return `${where}: the farms upstream carry ${sumR} in all, less than the ${ch} charged`;
			if (!s.exact || D === 0) continue;
			let jInt: Map<string, number> | null = null;
			if (s.internal) {
				jInt = new Map();
				for (const r of s.internal) {
					jInt.set(r.to, (jInt.get(r.to) ?? 0) + r.volume[t]!);
					jInt.set(r.from, (jInt.get(r.from) ?? 0) - r.volume[t]!);
				}
			}
			let E = 0;
			let scale = D;
			const e = s.farms.map((f) => {
				const x = F.get(f.id)!;
				const J = jInt ? (jInt.get(f.id) ?? 0) : x.J[t]!;
				const v = x.H[t]! + x.I[t]! + J - x.U[t]!;
				scale = Math.max(scale, Math.abs(x.H[t]!) + Math.abs(x.I[t]!) + Math.abs(J), Math.abs(x.U[t]!));
				E += Math.max(v, 0);
				return Math.max(v, 0);
			});
			if (Math.abs(ch - Math.min(D, E)) > tol(scale)) return `${where}: charged ${-ch} ≠ MIN(shortfall ${D}, Σ net impact ${E})`;
			s.farms.forEach((f, k) => {
				const A = E > 0 ? (ch * e[k]!) / E : 0;
				best.set(f.id, Math.max(best.get(f.id) ?? 0, A));
				shareAt[si]!.set(f.id, A);
			});
			for (const [k, f] of s.farms.entries()) {
				const A = E > 0 ? (ch * e[k]!) / E : 0;
				if (-F.get(f.id)!.R[t]! < A - tol(scale)) return `${f.id} day ${t}: EWR charge ${-F.get(f.id)!.R[t]!} below its share ${A} at site ${s.name}`;
			}
		}
		for (const f of farms) {
			const x = F.get(f.id)!;
			const R = -x.R[t]!;
			const Ri = -x.Ri[t]!;
			const where = `${f.id} day ${t}`;
			if (R < 0 || Ri < 0 || Ri > R + tol(R)) return `${where}: EWR charge ${-R} and its irrigation part ${-Ri} must satisfy charge ≤ irrigation part ≤ 0`;
			const used = x.T ? x.G[t]! - x.T[t]! : x.G[t]! * x.k;
			if (Ri > used + tol(x.G[t]!)) return `${where}: irrigation part ${Ri} of the EWR charge > consumptive irrigation ${used}`;
			if (allExact.get(f.id) && Math.abs(R - (best.get(f.id) ?? 0)) > tol(Math.max(R, x.U[t]!, x.H[t]! + x.I[t]!))) return `${where}: EWR charge ${-R} ≠ its largest share ${best.get(f.id) ?? 0} over the sites below it`;
			const b = binding.get(f.id)?.[t];
			if (b === undefined) continue;
			if (!Number.isFinite(b)) {
				if (R > 0) return `${where}: charged ${-R} but no binding site stored`;
				continue;
			}
			if (!(R > 0)) return `${where}: binding site ${b} stored on a day without a charge`;
			const site = siteInfo[b];
			if (!Number.isInteger(b) || !site || !site.farms.includes(f)) return `${where}: binding site ${b} is not an EWR site below it`;
			const A = shareAt[b]!.get(f.id);
			if (A !== undefined && Math.abs(R - A) > tol(Math.max(R, x.U[t]!, x.H[t]! + x.I[t]!))) return `${where}: EWR charge ${-R} ≠ its share ${A} at its binding site ${site.name}`;
		}
	}
	return null;
}

/**
 * The stored per-rule transfer volumes (engine ≥ 1.6.0): each ≥ 0 and the
 * run's length, and at every farm Σ in − Σ out = its net transfer J.
 */
function checkRuleVolumes(
	rules: readonly Transfer[],
	vol: readonly Float64Array[],
	farms: readonly NetworkNode[],
	get: SeriesMap,
	days: number
): string | null {
	for (const [k, r] of rules.entries()) {
		const stored = get.get(`${r.fromNodeId}|${transferRuleKey(r.id)}`);
		if (stored && stored.length !== days) return `transfer rule ${r.id}: ${stored.length} days stored, expected ${days}`;
		for (let t = 0; t < days; t++) if (!(vol[k]![t]! >= 0)) return `transfer rule ${r.id} day ${t}: moved ${vol[k]![t]}, must be ≥ 0`;
	}
	for (const f of farms) {
		if (f.kind !== 'farm') continue;
		const J = get.get(`${f.id}|transfer`);
		if (!J) continue;
		// A river off-take (engine ≥ 1.14.0) isn't in the farms' transfer J; checkOfftakes holds it to its own columns.
		const ins = rules.flatMap((r, k) => (r.toNodeId === f.id && !isRiverOfftake(r) ? [vol[k]!] : []));
		const outs = rules.flatMap((r, k) => (r.fromNodeId === f.id && !isRiverOfftake(r) ? [vol[k]!] : []));
		for (let t = 0; t < days; t++) {
			let net = 0;
			let scale = 0;
			for (const v of ins) {
				net += v[t]!;
				scale += v[t]!;
			}
			for (const v of outs) {
				net -= v[t]!;
				scale += v[t]!;
			}
			if (Math.abs(net - J[t]!) > tol(scale)) return `${f.id} day ${t}: its transfer rules move ${net} net, but its transfer is ${J[t]}`;
		}
		// Its river off-takes (engine ≥ 1.14.0): Σ taken = offtake_out, Σ taken × (1 − loss) into it = offtake_in.
		const warnings: string[] = [];
		const out = rules.flatMap((r, k) => (r.fromNodeId === f.id && isRiverOfftake(r) ? [vol[k]!] : []));
		const into = rules.flatMap((r, k) => (r.toNodeId === f.id && isRiverOfftake(r) ? [{ v: vol[k]!, keep: 1 - offtakeOf(r, 0, 0, '', '', warnings).loss }] : []));
		const XOUT = get.get(`${f.id}|offtake_out`);
		const XIN = get.get(`${f.id}|offtake_in`);
		for (let t = 0; t < days; t++) {
			let o = 0;
			for (const v of out) o += v[t]!;
			let i = 0;
			for (const x of into) i += x.v[t]! * x.keep;
			if (Math.abs(o - (XOUT?.[t] ?? 0)) > tol(o)) return `${f.id} day ${t}: its river off-takes take ${o}, but its offtake_out is ${XOUT?.[t] ?? 0}`;
			if (Math.abs(i - (XIN?.[t] ?? 0)) > tol(i)) return `${f.id} day ${t}: its river off-takes deliver ${i}, but its offtake_in is ${XIN?.[t] ?? 0}`;
		}
	}
	return null;
}

/**
 * A farm's operating rules (engine ≥ 1.32.0, WP-3.8, issue #204, docs/model.md
 * §2.7h), every farm, every day, from the published columns and the node's
 * rules as runModel resolves them:
 * - the river pump never takes more than its capacity: 0 ≤ Gr ≤ pump capacity;
 * - the flow left after the pump is at least MIN(the flow before it, the
 *   hands-off keep): S − Gr ≥ MIN(S, keep);
 * - on a farm with a dam today, the flow left after River to dam is at least
 *   MIN(the flow before it, the hands-off keep): S = L + N − O ≥ MIN(L + N, keep);
 * - on a farm without one (capacity 0 today), where K, M and O are irrigated
 *   straight from the river, the flow left after all three is at least
 *   MIN(the farm's inflow, the keep): S = H + I − (K + M + O) ≥ MIN(H + I, keep);
 * - no diversion above the month's capacity: 0 ≤ O ≤ River to dam's
 *   capacity that month (by month when set, else the one value);
 * with keep = MAX(the month's hands-off amount, the EWR required here Z when
 * kept); 0 without a hands-off flow, where the two keep checks hold trivially.
 */
export function checkOperatingRules(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const day0 = toEpochDay(out.startDate);
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const sup = supplyOf(n, []).supply;
		const ops = operatingOf(n, []);
		const L = g('upstream_below_dam');
		const N = g('runoff_below_dam');
		const O = g('diverted_to_dam');
		const S = g('below_dam_not_diverted');
		const Z = g('ewr_cumulative');
		const GR = g('river_abstraction');
		if (!L || !N || !O || !S || !Z) return `${n.id}: the columns L, N, O, S and Z are needed to check its operating rules`;
		if (sup && !GR) return `${n.id}: river_abstraction column missing for a supply rule that pumps from the river`;
		const H = g('inflow_upstream');
		const I = g('runoff');
		if (!H || !I) return `${n.id}: the columns H and I are needed to check its operating rules`;
		const divertOf = { divertCapacityM3Day: n.divertCapacityM3Day, ...(ops.divertM3DayByMonth ? { divertM3DayByMonth: ops.divertM3DayByMonth } : {}) };
		// The day's dam capacity factor (engine ≥ 1.30.0), as runModel resolves it: a dam with capacity 0 today is none.
		const ks = capacityScaleOf(n, day0, out.days, []);
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const month = monthOfEpochDay(day0 + t);
			const l = L[t]!, nn = N[t]!, o = O[t]!, ss = S[t]!;
			const keep = ops.handsOff ? handsOffToday(ops.handsOff, month, Z[t]!) : 0;
			const cap = divertCapacityToday(divertOf, month);
			if (o < -tol(0) || o > cap + tol(cap)) return `${where}: River to dam diverted ${o}, outside [0, its capacity that month ${cap}]`;
			if (n.damCapacityM3 * (ks ? ks[t]! : 1) > 0) {
				if (ss < Math.min(l + nn, keep) - tol(Math.max(l + nn, keep))) return `${where}: River to dam left ${ss} below it, less than MIN(the ${l + nn} before it, the hands-off flow ${keep})`;
			} else {
				const hi = H[t]! + I[t]!;
				if (ss < Math.min(hi, keep) - tol(Math.max(hi, keep)))
					return `${where}: with no dam, what it took into the dam and River to dam left ${ss} in the river, less than MIN(the ${hi} reaching it, the hands-off flow ${keep})`;
			}
			if (sup) {
				const gr = GR![t]!;
				if (gr < -tol(0) || gr > sup.pumpM3Day + tol(gr)) return `${where}: the river pump took ${gr}, outside [0, its capacity ${sup.pumpM3Day}]`;
				if (ss - gr < Math.min(ss, keep) - tol(Math.max(ss, keep))) return `${where}: the river pump left ${ss - gr} in the river, less than MIN(the ${ss} before it, the hands-off flow ${keep})`;
			}
		}
	}
	return null;
}

/**
 * The drought restriction rule's three formulas (docs/model.md §2.7i), written
 * out here rather than imported from network/restriction.ts, so a slip in the
 * engine's own (a `<` become `<=`, the floor dropped) can't pass its check:
 * the level is the number of thresholds the share is below (they fall level
 * by level); a level's cut on a part (0 at level 0 or for a part it doesn't
 * list); an object's demand after the cut, never below MIN(floor, demand).
 */
function checkedLevel(share: number, thresholds: readonly number[]): number {
	let k = 0;
	for (const th of thresholds) if (share < th) k++;
	return k;
}
function checkedCut(rule: DroughtRestrictionRule, level: number, part: DemandPart): number {
	return level > 0 ? (rule.levels[level - 1]!.cuts[part] ?? 0) : 0;
}
function checkedObjectDemand(d: number, cut: number, floor: number | null): number {
	const r = d * (1 - cut);
	return floor === null ? r : Math.max(r, Math.min(floor, d));
}

/**
 * The drought restriction rule (engine ≥ 1.54.0, WP-3.8, ../network/restriction.ts,
 * docs/model.md §2.7i), from the run's own columns and the input's rule:
 * - without the rule (or with one it can't use) no restriction column and no
 *   summary block;
 * - with it, each unit's level each day is the one its review decided: on a
 *   review date (and a fresh run's first day, when the latest date before it
 *   is a review) the deepest level whose threshold the storage it reads at
 *   the start of the day (the day before's storage plus any storage reset;
 *   every farm dam, the listed dams, or its own) is below, as a share of
 *   capacity that day, raised to the EWR trigger's level when the trigger's
 *   site wasn't met the day before; 0 from a lift date; else the day
 *   before's. So it reads nothing later than the start of its day. The dates
 *   are worked out here, not by the engine's planner;
 * - a unit outside the rule's units has no restricted demand;
 * - each part's cut column is its level's cut, only for a part some level
 *   cuts, under a shared basis; under 'own' each unit has its level column
 *   and the catchment's is the deepest;
 * - each unit's restricted demand is its crop requirement × (1 − the crops'
 *   cut) ÷ e plus each demand object's demand × (1 − its category's cut),
 *   never below MIN(its basic-needs floor, its demand); it never exceeds the
 *   demand, and the unit is never supplied more than it (a restriction never
 *   raises supply);
 * - the summary's days per level add up to the level column, per water year
 *   and over the run, and its units' means and days to their columns.
 * A run resumed from a snapshot (runModelFrom) starts from the state its
 * summary records (`start`: the levels held the day before, whether the
 * trigger's site failed, each dam's storage); a fresh run from level 0 and
 * damInitialPct.
 */
export function checkDroughtRestriction(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const resolved = resolveDroughtRestriction(input.settings.droughtRestriction, []);
	// A rule none of whose units is in the model isn't applied, as one it can't use (planRestriction).
	const rule = resolved && input.model.nodes.some((n) => n.kind === 'farm' && (!resolved.nodeIds || resolved.nodeIds.includes(n.id))) ? resolved : null;
	const LV = get.get(`null|${RESTRICTION_SERIES.level.key}`);
	const sum = out.summary.droughtRestriction;
	if (!rule) {
		const stray = out.series.find((x) => x.key === RESTRICTION_SERIES.level.key || x.key === RESTRICTION_SERIES.restricted.key || x.key.startsWith(RESTRICTION_SERIES.cutPrefix));
		if (stray) return `a ${stray.key} column without a drought restriction rule`;
		return sum ? 'a drought restriction summary without the rule' : null;
	}
	if (!LV) return 'no restriction_level column for the drought restriction rule';
	if (!sum) return 'no drought restriction summary for the rule';
	const day0 = toEpochDay(out.startDate);
	const nodes = input.model.nodes;
	const resumed = sum.start;
	// The dates and the first day worked out here, not by the engine's planner, so a slip in the run's date
	// mapping can't pass its own check: a review or lift on a day's month and day; a fresh run's first day
	// decided when the latest such date before it (within a year) is a review.
	const reviews = new Set(rule.reviewDates);
	const lifts = new Set(rule.liftDates ?? []);
	const eventOf = (day: number): 0 | 1 | 2 => {
		const md = fromEpochDay(day).slice(5);
		return reviews.has(md) ? 1 : lifts.has(md) ? 2 : 0;
	};
	let startDecides = false;
	if (!resumed?.levelsBefore)
		for (let back = 1; back <= 366; back++) {
			const e = eventOf(day0 - back);
			if (e) {
				startDecides = e === 1;
				break;
			}
		}
	const thresholds = rule.levels.map((l) => l.belowPct);
	const isDam = (n: NetworkNode) => n.kind === 'farm' && n.damCapacityM3 > 0;
	const basis = rule.basis ?? 'total';
	const listed = basis === 'dams' ? new Set(rule.damNodeIds ?? []) : null;
	const scope = rule.nodeIds ? new Set(rule.nodeIds) : null;
	const units = nodes.filter((n) => n.kind === 'farm' && (!scope || scope.has(n.id)));
	// Each dam's storage at the start of each day and its capacity that day, as the run resolves them.
	const damOf = (n: NetworkNode) => {
		const Q = get.get(`${n.id}|dam_storage`);
		const SET = get.get(`${n.id}|dam_storage_set`);
		const ks = capacityScaleOf(n, day0, out.days, []);
		const before0 = resumed ? resumed.damStorageBeforeM3[n.id] : n.damInitialPct * n.damCapacityM3 * (ks ? ks[0]! : 1);
		return { n, Q, SET, ks, before0 };
	};
	const shared = basis === 'own' ? [] : nodes.filter((n) => isDam(n) && (!listed || listed.has(n.id))).sort((a, b) => cmpStr(a.id, b.id)).map(damOf);
	const missing = shared.find((x) => !x.Q || x.before0 === undefined);
	if (missing) return `${missing.n.id}: dam_storage column or starting storage missing`;
	const levelOf = (dams: ReturnType<typeof damOf>[], t: number): number => {
		let q = 0;
		let c = 0;
		for (const { n, Q, SET, ks, before0 } of dams) {
			const cap = n.damCapacityM3 * (ks ? ks[t]! : 1);
			if (!(cap > 0)) continue;
			q += (t === 0 ? before0! : Q![t - 1]!) + (SET ? SET[t]! : 0);
			c += cap;
		}
		return c > 0 ? checkedLevel(q / c, thresholds) : 0;
	};
	// The EWR trigger's site: null = the outlet (the node nothing drains into), else a gauge that is an EWR site.
	// At the outlet the trigger reads the catchment's EWR column (the outflow against the whole EWR), not the
	// outflow node's own share-weighted one.
	const trig = rule.ewrTrigger;
	const outletId = nodes.find((n) => n.downstreamNodeId === null)?.id ?? null;
	const siteId = trig ? (trig.siteNodeId === null ? outletId : nodes.some((n) => n.id === trig.siteNodeId && n.kind === 'gauge' && n.ewrSite !== false) ? trig.siteNodeId : null) : null;
	const siteShort = siteId ? get.get(siteId === outletId ? 'null|ewr_shortfall' : `${siteId}|ewr_shortfall`) : undefined;
	if (siteId && !siteShort) return `${siteId}: ewr_shortfall column missing for the drought restriction rule's EWR trigger`;
	const failedBefore = (t: number) => (!siteShort ? false : t === 0 ? resumed?.ewrFailedBefore === true : siteShort[t - 1]! < 0);
	// Each unit's levels, day by day.
	const own = new Map(units.map((u) => [u.id, isDam(u) ? damOf(u) : null]));
	if (basis === 'own') for (const d of own.values()) if (d && (!d.Q || d.before0 === undefined)) return `${d.n.id}: dam_storage column or starting storage missing`;
	const held = new Map(units.map((u) => [u.id, resumed?.levelsBefore?.[u.id] ?? 0]));
	const unitLevels = new Map(units.map((u) => [u.id, new Array<number>(out.days).fill(0)]));
	let ewrReviews = 0;
	let reviewCount = 0;
	for (let t = 0; t < out.days; t++) {
		const e = eventOf(day0 + t);
		if (e === 1 || (t === 0 && e === 0 && startDecides)) {
			reviewCount++;
			const failed = failedBefore(t);
			if (failed) ewrReviews++;
			const ewr = failed && trig ? trig.level : 0;
			const sharedLevel = basis === 'own' ? 0 : levelOf(shared, t);
			for (const u of units) {
				const d = own.get(u.id);
				held.set(u.id, basis === 'own' ? Math.max(d ? levelOf([d], t) : 0, ewr) : Math.max(sharedLevel, ewr));
			}
		} else if (e === 2) for (const u of units) held.set(u.id, 0);
		for (const u of units) unitLevels.get(u.id)![t] = held.get(u.id)!;
	}
	// The level columns.
	for (let t = 0; t < out.days; t++) {
		let want = 0;
		for (const u of units) want = Math.max(want, unitLevels.get(u.id)![t]!);
		if (LV[t] !== want) return `day ${t}: drought restriction level ${LV[t]} ≠ ${want} (${eventOf(day0 + t) === 1 ? 'a review: the level for the storage at the start of the day' : eventOf(day0 + t) === 2 ? 'a lift date' : 'held from the last review or lift'})`;
	}
	for (const u of units) {
		const col = get.get(`${u.id}|${RESTRICTION_SERIES.level.key}`);
		if (basis !== 'own') {
			if (col) return `${u.id}: a unit restriction_level column under a shared basis`;
			continue;
		}
		if (!col) return `${u.id}: no restriction_level column under the 'own' basis`;
		const lv = unitLevels.get(u.id)!;
		for (let t = 0; t < out.days; t++) if (col[t] !== lv[t]) return `${u.id} day ${t}: drought restriction level ${col[t]} ≠ ${lv[t]} (its own dam)`;
	}
	// Each part's cut column: a shared basis only.
	for (const part of DEMAND_PARTS) {
		const col = get.get(`null|${restrictionCutKey(part)}`);
		const cuts = basis !== 'own' && rule.levels.some((_, i) => checkedCut(rule, i + 1, part) > 0);
		if (!!col !== cuts) return `${restrictionCutKey(part)}: ${col ? 'a column for a part no level cuts, or under the own basis' : 'no column for a part a level cuts'}`;
		if (col) for (let t = 0; t < out.days; t++) if (col[t] !== checkedCut(rule, LV[t]!, part)) return `day ${t}: ${restrictionCutKey(part)} ${col[t]} ≠ level ${LV[t]}'s cut ${checkedCut(rule, LV[t]!, part)}`;
	}
	// Each unit's demand after the cut.
	const inScope = new Set(units.map((u) => u.id));
	for (const n of nodes) {
		const DR = get.get(`${n.id}|${RESTRICTION_SERIES.restricted.key}`);
		if (!inScope.has(n.id)) {
			if (DR) return `${n.id}: restricted_demand on a ${n.kind === 'farm' ? 'unit the rule doesn’t cut' : n.kind}`;
			continue;
		}
		if (!DR) return `${n.id}: no restricted_demand column while the drought restriction rule cuts it`;
		const F = get.get(`${n.id}|crop_requirement`);
		const D = get.get(`${n.id}|demand`);
		const G = get.get(`${n.id}|supplied`);
		if (!F || !D || !G) return `${n.id}: crop_requirement, demand and supplied are needed to check the drought restriction`;
		const e = runEfficiency(input, n);
		const objs = objectColumns(input, n, get, out);
		if (typeof objs === 'string') return objs;
		const lvs = unitLevels.get(n.id)!;
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const lv = lvs[t]!;
			let want = (F[t]! * (1 - checkedCut(rule, lv, 'crops'))) / e;
			let scale = Math.max(F[t]! / e, D[t]!);
			if (objs)
				for (let k = 0; k < objs.demand.length; k++) {
					const d = objs.demand[k]![t]!;
					const fl = objs.floor[k]!;
					const r = checkedObjectDemand(d, checkedCut(rule, lv, objs.category[k]!), fl);
					if (fl !== null && r < dayFloor(fl, d) - tol(d)) return `${where}: demand object ${k}'s restricted demand ${r} is below MIN(its basic-needs floor ${fl}, its demand ${d})`;
					want += r;
					scale = Math.max(scale, d);
				}
			const dr = DR[t]!;
			if (Math.abs(dr - want) > tol(scale)) return `${where}: restricted demand ${dr} ≠ ${want}, the level ${lv} cuts on its crops and demand objects (the basic-needs floor held)`;
			if (dr > D[t]! + tol(D[t]!)) return `${where}: restricted demand ${dr} exceeds the demand ${D[t]}`;
			if (G[t]! > dr + tol(Math.max(dr, G[t]!))) return `${where}: supplied ${G[t]}, more than its restricted demand ${dr}: a restriction never raises supply`;
		}
	}
	// The summary adds up to the columns.
	const nl = rule.levels.length + 1;
	const total = new Array<number>(nl).fill(0);
	const years = new Map<number, number[]>();
	for (let t = 0; t < out.days; t++) {
		const lv = LV[t]!;
		total[lv]!++;
		const wy = waterYearOf(day0 + t);
		const y = years.get(wy) ?? new Array<number>(nl + 1).fill(0);
		y[0]!++;
		y[lv + 1]!++;
		years.set(wy, y);
	}
	if (sum.daysByLevel.length !== nl || sum.daysByLevel.some((v, i) => v !== total[i])) return `the drought restriction summary's days by level ${sum.daysByLevel.join('/')} ≠ the level column's ${total.join('/')}`;
	if (sum.years.length !== years.size) return `the drought restriction summary has ${sum.years.length} water years, the run ${years.size}`;
	for (const y of sum.years) {
		const c = years.get(y.waterYear);
		if (!c || c[0] !== y.days || y.daysByLevel.some((v, i) => v !== c[i + 1])) return `water year ${y.waterYear}: the drought restriction summary's days don't match the level column`;
	}
	if (sum.reviews !== reviewCount) return `the drought restriction summary's reviews ${sum.reviews} ≠ ${reviewCount}`;
	if (trig && siteId && sum.ewrReviews !== ewrReviews) return `the drought restriction summary's EWR-triggered reviews ${sum.ewrReviews} ≠ ${ewrReviews}`;
	if (sum.units.length !== units.length) return `the drought restriction summary lists ${sum.units.length} units, the rule cuts ${units.length}`;
	for (const u of sum.units) {
		const mean = (k: string) => {
			const v = get.get(`${u.nodeId}|${k}`) ?? [];
			let s = 0;
			for (const x of v) s += x;
			return v.length ? s / v.length : 0;
		};
		const dr = mean(RESTRICTION_SERIES.restricted.key);
		const g = mean('supplied');
		if (Math.abs(u.avgRestrictedDemandM3Day - dr) > tol(dr) || Math.abs(u.avgDemandM3Day - mean('demand')) > tol(u.avgDemandM3Day) || Math.abs(u.avgSuppliedM3Day - g) > tol(g))
			return `${u.nodeId}: the drought restriction summary's mean demands or supply don't match its columns`;
		const D = get.get(`${u.nodeId}|demand`) ?? [];
		const R = get.get(`${u.nodeId}|${RESTRICTION_SERIES.restricted.key}`) ?? [];
		const lvs = unitLevels.get(u.nodeId);
		if (!lvs) return `${u.nodeId}: in the drought restriction summary but not cut by the rule`;
		let cut = 0;
		let days = 0;
		const byLevel = new Array<number>(nl).fill(0);
		for (let t = 0; t < out.days; t++) {
			byLevel[lvs[t]!]!++;
			if (lvs[t] === 0) continue;
			cut += D[t]! - R[t]!;
			days++;
		}
		const want = days ? cut / days : null;
		if (want === null ? u.avgCutOnRestrictedDaysM3Day !== null : u.avgCutOnRestrictedDaysM3Day === null || Math.abs(u.avgCutOnRestrictedDaysM3Day - want) > tol(want))
			return `${u.nodeId}: the drought restriction summary's cut on restricted days ${u.avgCutOnRestrictedDaysM3Day} ≠ ${want}`;
		if (u.daysByLevel.length !== nl || u.daysByLevel.some((v, i) => v !== byLevel[i])) return `${u.nodeId}: the drought restriction summary's days by level don't match its levels`;
	}
	return null;
}

/** Every per-run invariant. */
export function checkInvariants(input: ModelInput, out: ModelOutput): string | null {
	return (
		checkBalance(input, out) ??
		checkWorkings(input, out) ??
		checkSoilWater(input, out) ??
		checkRunoffBalance(input, out) ??
		checkTransferLimits(input, out) ??
		checkReportTotals(input, out) ??
		checkEwrAttribution(input, out) ??
		checkGroundwater(input, out) ??
		checkLandCover(input, out) ??
		checkAllocations(input, out) ??
		checkOperatingRules(input, out) ??
		checkDroughtRestriction(input, out) ??
		checkSupplyAssurance(input, out)
	);
}

/**
 * Registered volumes (engine ≥ 1.18.0, issue #72, ../allocations/mode.ts,
 * docs/model.md §2.12a), on every farm and water user:
 * - an allocation cap ('cap'): a room column only for a source the unit has
 *   a volume of; within a water year the room falls by exactly the day's use
 *   (surface: supplied − groundwater to the crop; groundwater: pumped to the
 *   crop + into the dam), the day's use never exceeds it, it never goes below
 *   0, and on 1 October it starts again at the year's registered volume
 *   (recomputed here from the input's allocations), which it never exceeds;
 *   a source whose licence states conditions has an allocation_left column
 *   (engine ≥ 1.40.0), and only it: the year's volume on 1 October, falling
 *   by the day's use, never below 0, and the room is MIN(it, the day's
 *   limit); the summary's limitBound days per water year and limit follow
 *   from those columns, the use and the unit's deficit (limitBoundKind);
 * - a full allocation ('fullAllocation'): the demand factor is one number per
 *   water year, and a scaled unit's demand over the run's days of a year adds
 *   up to the volume registered for it over them (none when it had no demand),
 *   plus what a restriction's basic-needs floor holds above it (engine ≥ 1.44.0);
 *   the year a forecast tail starts in (summary.historyDays, engine ≥
 *   1.28.0) over its historical days, its tail days keeping that factor;
 * - no mode column in a run of another mode;
 * - RunSummary.allocations is there exactly when the input has allocations,
 *   with the mode the run used, and its per-source whole-year figures are
 *   compareAllocations of the run's own series.
 */
/**
 * What the basic-needs floor holds of a full allocation's rescaling on a
 * restricted day (engine ≥ 1.44.0, allocations/mode.ts planAllocations), per
 * run day: Σ over the unit's objects with a floor of MAX(KF × r, MIN(floor,
 * r)) − KF × r, where r is the object's restricted demand, recomputed from the
 * model as checkObjectsDay does. Null when none is held.
 */
function allocationFloorHeld(input: ModelInput, n: NetworkNode, get: SeriesMap, out: ModelOutput, KF: ArrayLike<number>): Float64Array | null {
	const objs = objectColumns(input, n, get, out);
	if (!objs || typeof objs === 'string' || !objs.floor.some((f) => f !== null)) return null;
	const day0 = toEpochDay(out.startDate);
	const SC = dailyDemandFactor(input.settings, n, day0, out.days, undefined).perDay;
	const abstractFrom = abstractionStartDay(n, day0, out.days, []);
	const held = new Float64Array(out.days);
	for (let t = abstractFrom; t < out.days; t++) {
		if (!(SC[t]! < 1)) continue;
		const wy = (monthOfEpochDay(day0 + t) + 2) % 12;
		objs.floor.forEach((fl, k) => {
			if (fl === null) return;
			const sf = objs.schedule[k] ? objs.schedule[k]![t]! : 1;
			const r = Math.max(objs.monthly[k]![wy]! * SC[t]! * sf, dayFloor(fl, objs.monthly[k]![wy]! * sf));
			held[t]! += Math.max(KF[t]! * r, dayFloor(fl, r)) - KF[t]! * r;
		});
	}
	return held;
}

export function checkAllocations(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const nodes = input.model.nodes;
	const mode = resolveAllocationMode(input.settings?.allocationMode, []);
	const plan = matchAllocations(input.model.allocations, mode, nodes, []);
	const day0 = toEpochDay(out.startDate);
	const tolerance = typeof input.settings?.allocationTolerance === 'number' && input.settings.allocationTolerance >= 0 && input.settings.allocationTolerance < 1 ? input.settings.allocationTolerance : DEFAULT_ALLOCATION_TOLERANCE;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const RS = g(ALLOCATION_SERIES.surfaceRoom.key);
		const RG = g(ALLOCATION_SERIES.groundwaterRoom.key);
		const KF = g(ALLOCATION_SERIES.demandFactor.key);
		const allocs = plan.byNode.get(i) ?? [];
		if (mode !== 'cap' && (RS || RG || g(ALLOCATION_SERIES.surfaceLeft.key) || g(ALLOCATION_SERIES.groundwaterLeft.key))) return `${n.id}: allocation room columns in a run whose allocation mode is ${mode}`;
		if (mode !== 'fullAllocation' && KF) return `${n.id}: an allocation demand factor in a run whose allocation mode is ${mode}`;
		if (mode === 'cap') {
			for (const [source, room] of [['surface', RS], ['groundwater', RG]] as const) {
				const budget = yearBudgets(allocs, source, day0, out.days);
				if (!!budget !== !!room) return `${n.id}: ${room ? 'an' : 'no'} allocation_room_${source} column for a unit with ${budget ? 'a' : 'no'} ${source} volume`;
				if (!budget || !room) continue;
				const G = g('supplied');
				const GW = g('groundwater_used');
				const GD = g('groundwater_to_dam');
				if (!G) return `${n.id}: supplied series missing`;
				const useOn = (t: number) => (source === 'surface' ? G[t]! - (GW?.[t] ?? 0) : (GW?.[t] ?? 0) + (GD?.[t] ?? 0));
				// The licence conditions (engine ≥ 1.37.0): the room is at most the day's limit, which the
				// input gives (0 outside the months of use, else the maximum rates × 86 400).
				const limit = dailyLimits(allocs, source, day0, out.days);
				// What is left of the year's volume (engine ≥ 1.40.0), stored only beside a limit.
				const LEFT = g(source === 'surface' ? ALLOCATION_SERIES.surfaceLeft.key : ALLOCATION_SERIES.groundwaterLeft.key);
				if (LEFT && !limit) return `${n.id}: an allocation_left_${source} column for a ${source} volume with no licence conditions`;
				const src = out.summary.allocations?.nodes.find((x) => x.nodeId === n.id)?.sources.find((x) => x.waterSource === source);
				// A run from before 1.40.0 has neither the column nor the summary's limitBound.
				if (limit && !LEFT && src?.limitBound) return `${n.id}: no allocation_left_${source} column for a ${source} volume with licence conditions`;
				if (LEFT && src && !src.limitBound) return `RunSummary.allocations for ${n.id} (${source}): no limitBound in a run with an allocation_left_${source} column`;
				const D = g('demand');
				const W = g('deficit');
				const bound = new Map<number, AllocationLimitBound>();
				const outside = outsideMonths(allocs, source, day0, out.days);
				// What is left of the year's volume. A day whose room is the licence limit hides it, so it is
				// known from the first day of a water year, or a day the limit doesn't bind (a resumed run
				// starts with the year's use before the snapshot, which the output doesn't carry).
				let left: number | null = null;
				// This water year's use on the run's days: what is left is at most the budget less it, whatever
				// came before the run (a resumed run's use before the snapshot is ≥ 0), so it bounds every day.
				let usedInRun = 0;
				for (let t = 0; t < out.days; t++) {
					const where = `${n.id} day ${t}`;
					const use = useOn(t);
					const b = budget[t]!;
					const lim = limit ? limit[t]! : Infinity;
					const eps = tol(Math.max(b, Math.abs(use)));
					if (room[t]! < 0 || room[t]! > Math.min(b, lim) + eps) return `${where}: ${source} allocation room ${room[t]} outside [0, the year's registered ${b}${lim < b ? ` and the licence's ${lim} today` : ''}]`;
					if (use > room[t]! + eps) return `${where}: took ${use} of ${source} water with only ${room[t]} allowed today by its registered volume${limit ? ' and licence conditions' : ''}`;
					const newYear = t > 0 && monthOfEpochDay(day0 + t) === 10 && monthOfEpochDay(day0 + t - 1) !== 10;
					if (newYear) {
						left = b;
						usedInRun = 0;
					} else if (t > 0) {
						usedInRun += useOn(t - 1);
						if (left !== null) left = Math.max(0, left - useOn(t - 1));
					}
					if (room[t]! > Math.max(0, b - usedInRun) + tol(Math.max(b, usedInRun)))
						return `${where}: ${source} allocation room ${room[t]} is more than the year's registered ${b} less the ${usedInRun} it has taken this water year`;
					if (left !== null) {
						const want = Math.min(left, lim);
						if (Math.abs(room[t]! - want) > tol(Math.max(b, left)))
							return newYear
								? `${where}: the ${source} allocation room starts the water year at ${room[t]}, not ${lim < b ? `the licence's ${lim} today` : `its registered ${b}`}`
								: `${where}: ${source} allocation room ${room[t]} ≠ MIN(what is left of the year's volume ${left}, the licence's ${lim} today)`;
					} else if (room[t]! < lim - tol(Math.max(b, room[t]!))) left = room[t]!;
					if (LEFT) {
						const l = LEFT[t]!;
						if (l < 0 || l > b + eps) return `${where}: what is left of the ${source} volume, ${l}, is outside [0, the year's registered ${b}]`;
						if (Math.abs(room[t]! - Math.min(l, lim)) > tol(Math.max(b, l))) return `${where}: ${source} allocation room ${room[t]} ≠ MIN(what is left ${l}, the licence's ${lim} today)`;
						const want = newYear ? b : t > 0 ? Math.max(0, LEFT[t - 1]! - useOn(t - 1)) : null;
						if (want !== null && Math.abs(l - want) > tol(Math.max(b, want))) return `${where}: what is left of the ${source} volume is ${l}, not ${want}`;
					}
					// Whether the limit bound today, and which (engine ≥ 1.40.0): without a limit the room is what is left.
					if (src?.limitBound) {
						if (!D || !W) return `${n.id}: no demand or deficit series to check the days the licence limit bound against`;
						const kind = limitBoundKind(LEFT ? LEFT[t]! : room[t]!, lim, outside?.[t] === 1, use, D[t]!, W[t]!, b);
						if (kind) {
							const wy = waterYearOf(day0 + t);
							const y = bound.get(wy) ?? { waterYear: wy, days: 0, volumeDays: 0, rateDays: 0, monthsDays: 0 };
							y.days++;
							y[kind]++;
							bound.set(wy, y);
						}
					}
				}
				if (src?.limitBound) {
					const want = [...bound.values()];
					const got = src.limitBound;
					const same = got.length === want.length && got.every((y, k) => { const w = want[k]!; return y.waterYear === w.waterYear && y.days === w.days && y.volumeDays === w.volumeDays && y.rateDays === w.rateDays && y.monthsDays === w.monthsDays; });
					if (!same) return `RunSummary.allocations for ${n.id} (${source}): the days the licence limit bound ${JSON.stringify(got)} don't follow from the run's own columns ${JSON.stringify(want)}`;
				}
			}
		}
		if (mode === 'fullAllocation' && KF) {
			const D = g('demand');
			const abstractFrom = abstractionStartDay(n, day0, out.days, []);
			if (!D) return `${n.id}: demand series missing`;
			// Before a forecast tail (engine ≥ 1.28.0): the year it starts in is fitted on its historical days.
			const history = out.summary.historyDays ?? out.days;
			// A restriction what-if's basic-needs floor (engine ≥ 1.44.0) holds some demand above the registered volume.
			const held = allocationFloorHeld(input, n, get, out, KF);
			/** Days a..b have one factor; with it their demand adds up to the volume registered over `reg` (none without demand). */
			const span = (a: number, b: number, wy: number, reg: number): string | null => {
				let d = 0;
				for (let k = a; k <= b; k++) {
					if (KF[k] !== KF[a]) return `${n.id} day ${k}: the full-allocation demand factor changes inside water year ${wy}`;
					d += D[k]!;
				}
				let h = 0;
				if (held) for (let k = a; k <= b; k++) h += held[k]!;
				const want = (KF[a]! > 0 ? reg : 0) + h;
				return Math.abs(d - want) > tol(Math.max(d, reg)) ? `${n.id}: demand over water year ${wy} is ${d}, not the ${want} registered for its days in the run${h > 0 ? ` (with ${h} held by the basic-needs floor)` : ''}` : null;
			};
			for (let t = 0; t < out.days; ) {
				const wy = waterYearOf(day0 + t);
				const end = toEpochDay(`${wy + 1}-10-01`) - 1;
				const last = Math.min(out.days - 1, end - day0);
				// The volume registered over days x … y the unit abstracts on (engine ≥ 1.30.0: from its abstraction date).
				const regOver = (x: number, y: number) => {
					const s = Math.max(x, abstractFrom);
					return s > y ? 0 : registeredOver(allocs, wy, day0 + s, day0 + y);
				};
				// Cut by the tail: the historical days add up on their own, and the tail days keep their factor.
				let bad = t < history && last >= history ? span(t, history - 1, wy, regOver(t, history - 1)) : span(t, last, wy, regOver(t, last));
				if (!bad && t < history && last >= history)
					for (let k = history; k <= last && !bad; k++) if (KF[k] !== KF[t]) bad = `${n.id} day ${k}: the full-allocation demand factor changes inside water year ${wy}`;
				if (bad) return bad;
				t = last + 1;
			}
		} else if (mode === 'fullAllocation' && allocs.length && (n.kind === 'farm' || n.kind === 'user')) {
			return `${n.id}: a unit with a registered volume has no full-allocation demand factor`;
		}
	}
	const s = out.summary.allocations;
	if (!input.model.allocations?.length) return s ? 'RunSummary.allocations without allocations in the input' : null;
	if (!s) return 'RunSummary.allocations missing for an input with allocations';
	if (s.mode !== mode) return `RunSummary.allocations says mode ${s.mode}, the run used ${mode}`;
	const units = nodes.filter((n) => n.kind === 'farm' || n.kind === 'user');
	const cmp = compareAllocations({
		startDate: out.startDate,
		tolerance,
		allocations: plan.list,
		nodes: units.flatMap((n) => {
			const supplied = get.get(`${n.id}|supplied`);
			if (!supplied) return [];
			return [
				{
					nodeId: n.id,
					name: n.name,
					kind: n.kind as 'farm' | 'user',
					supplied,
					groundwater: get.get(`${n.id}|groundwater_used`) ?? null,
					groundwaterToDam: get.get(`${n.id}|groundwater_to_dam`) ?? null,
					riverAbstraction: get.get(`${n.id}|river_abstraction`) ?? null
				}
			];
		})
	});
	for (const row of s.nodes) {
		const c = cmp.nodes.find((x) => x.nodeId === row.nodeId);
		if (!c) return `RunSummary.allocations lists ${row.nodeId}, which the run has no series for`;
		for (const src of row.sources) {
			const side = src.waterSource === 'surface' ? c.surface : c.groundwater;
			const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b))));
			if (src.wholeYears !== side.wholeYears || src.yearsOver !== side.yearsOver || !close(src.meanModelledM3PerYear, side.meanModelledM3PerYear) || !close(src.meanRegisteredM3PerYear, side.meanRegisteredM3PerYear))
				return `RunSummary.allocations for ${row.nodeId} (${src.waterSource}) doesn't match the comparison of the run's own series`;
		}
	}
	return null;
}

/**
 * The assurance of supply (RunSummary.supplyAssurance, engine ≥ 0.32.0,
 * ../network/reliability.ts) against each demand node's own daily columns,
 * read here from the output's series, not from the path that built it
 * (engine ≥ 1.34.0, issue #192, docs/engine-audit.md V1):
 * - its reliability lists every farm and water user once, with its kind;
 * - each node's Σ demand, Σ supplied and demand days over the reporting
 *   window, overall and per water-year month, and the met days and ratios
 *   they give, are its own `demand` and `supplied` over that window;
 * - each node's stress grid and the system's (every node together) are
 *   Σ supplied ÷ Σ demand of those columns per water year × month cell.
 * - the water account's EWR rows follow from each site's own requirement
 *   and shortfall series (checkAccountEwr).
 * A V8 miscompile once gave a node another node's sums while its id stayed
 * right; this check is what catches that class of fault in a saved run.
 * Sums add in the same order as the code under test, so they agree to the
 * bit on a sound run; the tolerance is float noise, 1e-9 of Σ|x|.
 */
export function checkSupplyAssurance(input: ModelInput, out: ModelOutput): string | null {
	const sa = out.summary.supplyAssurance;
	if (!sa) return null;
	const get = seriesMap(out);
	const d0 = toEpochDay(out.startDate);
	const from = toEpochDay(sa.reportStart) - d0;
	const to = toEpochDay(sa.reportEnd) - d0;
	if (from < 0 || to >= out.days || sa.days !== to - from + 1) return `assurance window ${sa.reportStart} … ${sa.reportEnd} (${sa.days} days) is not inside the run`;
	const close = (a: number, b: number, scale: number) => Math.abs(a - b) <= 1e-9 * scale + 1e-12;
	const closeRatio = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) + 1e-15);
	const col = new Uint8Array(out.days);
	const row = new Int32Array(out.days);
	const wy0 = waterYearOf(d0);
	for (let t = 0; t < out.days; t++) {
		col[t] = waterYearIndex(monthOfEpochDay(d0 + t));
		row[t] = waterYearOf(d0 + t) - wy0;
	}
	const rows = out.days > 0 ? waterYearOf(d0 + out.days - 1) - wy0 + 1 : 0;
	const demandIds = input.model.nodes.filter((n) => n.kind === 'farm' || n.kind === 'user');
	if (sa.reliability.length !== demandIds.length) return `assurance lists ${sa.reliability.length} farms and water users, the model has ${demandIds.length}`;
	const series = new Map<string, { D: number[]; G: number[] }>();
	for (const n of demandIds) {
		const D = get.get(`${n.id}|demand`);
		const G = get.get(`${n.id}|supplied`);
		if (!D || !G) return `${n.id} has no demand or supplied series for the assurance to be checked against`;
		series.set(n.id, { D, G });
	}
	const seen = new Set<string>();
	for (const r of sa.reliability) {
		const w = `assurance ${r.nodeId}`;
		const node = demandIds.find((n) => n.id === r.nodeId);
		if (!node || seen.has(r.nodeId)) return `${w}: not a farm or water user of the model, or listed twice`;
		seen.add(r.nodeId);
		if (r.kind !== node.kind) return `${w}: kind ${r.kind}, the node is a ${node.kind}`;
		const { D, G } = series.get(r.nodeId)!;
		const k = assuranceTally(D, G, col, row, from, to, Math.max(rows, 0));
		const { dm, gm, abs, days, met, mD, mG, mAbs, mDays, mMet } = k;
		if (!close(r.demandM3, dm, abs) || !close(r.suppliedM3, gm, abs))
			return `${w}: Σ demand / supplied ${r.demandM3} / ${r.suppliedM3} over ${sa.reportStart} … ${sa.reportEnd}, but its own daily series add up to ${dm} / ${gm}`;
		if (r.demandDays !== days || r.metDays !== met) return `${w}: ${r.metDays} of ${r.demandDays} demand days met, its own daily series give ${met} of ${days}`;
		if (!closeRatio(r.volumetricReliability, dm > 0 ? gm / dm : null) || !closeRatio(r.timeReliability, days > 0 ? met / days : null)) return `${w}: reliability ratios don't follow from its sums`;
		// Failure runs: consecutive demand days not fully met, ended by a met day or a day without demand.
		const defScale = k.totalRunDef + 1;
		if (
			r.failureRuns !== k.runs ||
			r.longestFailureDays !== k.longest ||
			!closeRatio(r.meanFailureDays, k.runs > 0 ? k.totalRunDays / k.runs : null) ||
			!closeRatio(r.meanFailureDeficitM3, k.runs > 0 ? k.totalRunDef / k.runs : null) ||
			!close(r.maxFailureDeficitM3, k.maxDef, defScale)
		)
			return `${w}: failure runs ${r.failureRuns} (longest ${r.longestFailureDays} days, largest deficit ${r.maxFailureDeficitM3}), its own daily series give ${k.runs} (longest ${k.longest}, largest ${k.maxDef})`;
		// The annual measure: complete water years with demand, and those whose Σ supplied ÷ Σ demand reached the threshold.
		let wyCount = 0;
		let wyMet = 0;
		let wyPart = 0;
		for (let y = 0; y < rows; y++) {
			if (!(k.yDays[y]! > 0) || !(k.yD[y]! > 0)) continue;
			const wy = wy0 + y;
			if (k.yDays[y]! < (Date.UTC(wy + 1, 9, 1) - Date.UTC(wy, 9, 1)) / 86_400_000) {
				wyPart++;
				continue;
			}
			wyCount++;
			if (k.yG[y]! / k.yD[y]! >= sa.annualThreshold) wyMet++;
		}
		if (r.waterYears !== wyCount || (r.partWaterYears ?? 0) !== wyPart || r.waterYearsMet !== wyMet || !closeRatio(r.annualReliability, wyCount > 0 ? wyMet / wyCount : null))
			return `${w}: ${r.waterYearsMet} of ${r.waterYears} water years met (${r.partWaterYears ?? 0} part years), its own daily series give ${wyMet} of ${wyCount} (${wyPart})`;
		if (r.months.length !== 12) return `${w}: ${r.months.length} months`;
		for (let c = 0; c < 12; c++) {
			const m = r.months[c]!;
			if (!close(m.demandM3, mD[c]!, mAbs[c]!) || !close(m.suppliedM3, mG[c]!, mAbs[c]!) || m.demandDays !== mDays[c] || m.metDays !== mMet[c])
				return `${w}: water-year month ${c} doesn't add up to its own daily series (Σ demand ${m.demandM3} vs ${mD[c]}, ${m.demandDays} vs ${mDays[c]} demand days)`;
			if (!closeRatio(m.timeReliability, mDays[c]! > 0 ? mMet[c]! / mDays[c]! : null) || !closeRatio(m.volumetricReliability, mD[c]! > 0 ? mG[c]! / mD[c]! : null))
				return `${w}: water-year month ${c}'s reliability ratios don't follow from its own daily series`;
		}
	}

	// Stress grids over the whole run: per node, and the system as every node together.
	const st = sa.stress;
	if (st.waterYears.length !== rows || (rows > 0 && st.waterYears[0] !== wy0)) return `assurance stress grid: water years ${st.waterYears[0]} … ${st.waterYears.at(-1)} do not span the run`;
	const cells = () => Array.from({ length: rows }, () => new Array<number>(12).fill(0));
	const sysD = cells();
	const sysG = cells();
	const sysAbs = cells();
	const gridBad = (label: string, ratio: (number | null)[][], D: number[][], G: number[][], A: number[][]): string | null => {
		if (ratio.length !== rows) return `assurance stress grid ${label}: ${ratio.length} rows, the run has ${rows} water years`;
		for (let i = 0; i < rows; i++) {
			for (let c = 0; c < 12; c++) {
				const got = ratio[i]![c] ?? null;
				const want = D[i]![c]! > 0 ? G[i]![c]! / D[i]![c]! : null;
				// Σ supplied ÷ Σ demand: judged on the sums' own float noise.
				const ok = got === null || want === null ? got === want : Math.abs(got * D[i]![c]! - G[i]![c]!) <= 1e-9 * A[i]![c]! + 1e-12;
				if (!ok) return `assurance stress grid ${label} ${st.waterYears[i]}/${c}: ratio ${got}, its own daily series give ${want}`;
			}
		}
		return null;
	};
	// Every node's cell sums, then the system's as the sum of those per-node totals in node-id order.
	// reliability.ts (addToCells) instead keeps one running sum per cell across the nodes, day by day,
	// so the system's sums can differ from these in the last bits; the ratio is judged against Σ|x| of
	// the cell at 1e-9, far above that rounding and far below a node's worth of water.
	const perNode = new Map<string, { D: number[][]; G: number[][]; A: number[][] }>();
	for (const n of demandIds) {
		const { D, G } = series.get(n.id)!;
		const cd = cells();
		const cg = cells();
		const ca = cells();
		assuranceCells(cd, cg, ca, D, G, row, col, out.days);
		perNode.set(n.id, { D: cd, G: cg, A: ca });
	}
	for (const id of [...perNode.keys()].sort(cmpStr)) {
		const p = perNode.get(id)!;
		for (let i = 0; i < rows; i++) {
			for (let c = 0; c < 12; c++) {
				sysD[i]![c] = sysD[i]![c]! + p.D[i]![c]!;
				sysG[i]![c] = sysG[i]![c]! + p.G[i]![c]!;
				sysAbs[i]![c] = sysAbs[i]![c]! + p.A[i]![c]!;
			}
		}
	}
	if (st.nodes.length !== demandIds.length) return `assurance stress grid: ${st.nodes.length} node grids, the model has ${demandIds.length} farms and water users`;
	for (const g of st.nodes) {
		const p = g.nodeId === null ? undefined : perNode.get(g.nodeId);
		if (!p) return `assurance stress grid for ${g.nodeId}, which is not a farm or water user of the model`;
		const bad = gridBad(g.nodeId!, g.ratio, p.D, p.G, p.A);
		if (bad) return bad;
	}
	const grid = gridBad('system', st.system.ratio, sysD, sysG, sysAbs);
	if (grid) return grid;
	return checkAccountEwr(sa.waterAccount, get, out.days);
}

/**
 * The water account's EWR rows (per water year and the run, per site) against
 * the site's own series: the requirement is the pragmatic EWR (`ewr` at the
 * outlet, `ewr_cumulative` at a gauge) or, for a rule-table site
 * (ewrSource 'ruleTable'), its `ewr_rule` on the days it has one and the
 * pragmatic EWR on the others; the shortfall is `ewr_shortfall`, or
 * `ewr_charge_shortfall` for a rule-table site. Required = Σ requirement,
 * met = Σ (requirement + MIN(shortfall, 0)), days not met = days with a
 * shortfall below 0 (engine ≥ 1.34.0, issue #192).
 */
function checkAccountEwr(wa: NonNullable<ModelOutput['summary']['supplyAssurance']>['waterAccount'], get: SeriesMap, days: number): string | null {
	const sites = wa.total.ewr;
	const rows = [...wa.years, wa.total];
	let start = 0;
	const spans = wa.years.map((y) => {
		const span = { from: start, to: start + y.days - 1 };
		start += y.days;
		return span;
	});
	if (start !== days || wa.total.days !== days) return `assurance water account: its years cover ${start} days and its total ${wa.total.days}, the run has ${days}`;
	spans.push({ from: 0, to: days - 1 });
	for (let k = 0; k < sites.length; k++) {
		const site = sites[k]!;
		const key = site.nodeId ?? 'null';
		const w = `assurance water account EWR at ${site.nodeId ?? 'the outlet'}`;
		const pragmatic = site.nodeId === null ? get.get('null|ewr') : get.get(`${key}|ewr_cumulative`);
		const rule = site.ewrSource === 'ruleTable' ? get.get(`${key}|ewr_rule`) : undefined;
		const short = get.get(site.ewrSource === 'ruleTable' ? `${key}|ewr_charge_shortfall` : `${key}|ewr_shortfall`);
		if (!pragmatic || !short || (site.ewrSource === 'ruleTable' && !rule)) return `${w}: the run has no series to check it against`;
		for (let i = 0; i < rows.length; i++) {
			const e = rows[i]!.ewr[k];
			if (!e || e.nodeId !== site.nodeId) return `${w}: ${rows[i]!.waterYear ?? 'the run'} lists its sites in another order`;
			const { from, to } = spans[i]!;
			const { req, met, abs, notMet } = accountEwrTally(rule, pragmatic, short, from, to);
			const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * abs + 1e-9;
			if (!close(e.requiredM3, req) || !close(e.metM3, met) || e.daysNotMet !== notMet)
				return `${w} in ${rows[i]!.waterYear ?? 'the run'}: required / met / days not met ${e.requiredM3} / ${e.metM3} / ${e.daysNotMet}, its own daily series give ${req} / ${met} / ${notMet}`;
		}
	}
	return null;
}

/**
 * The check's day loops, each its own function taking the series as
 * parameters: the form network/reliability.ts uses to keep clear of the V8
 * miscompile it guards against (issue #192, docs/engine-audit.md V1), so the
 * check can't fall to the same fault as the code it checks.
 */
function assuranceTally(D: number[], G: number[], col: Uint8Array, row: Int32Array, from: number, to: number, rows: number) {
	let dm = 0;
	let gm = 0;
	let abs = 0;
	let days = 0;
	let met = 0;
	const mD = new Array<number>(12).fill(0);
	const mG = new Array<number>(12).fill(0);
	const mAbs = new Array<number>(12).fill(0);
	const mDays = new Array<number>(12).fill(0);
	const mMet = new Array<number>(12).fill(0);
	const yD = new Array<number>(rows).fill(0);
	const yG = new Array<number>(rows).fill(0);
	const yDays = new Array<number>(rows).fill(0);
	let runs = 0;
	let runLen = 0;
	let runDef = 0;
	let totalRunDays = 0;
	let totalRunDef = 0;
	let longest = 0;
	let maxDef = 0;
	for (let t = from; t <= to; t++) {
		const d = D[t]!;
		const g = G[t]!;
		const c = col[t]!;
		const y = row[t]!;
		dm += d;
		gm += g;
		abs += Math.abs(d) + Math.abs(g);
		mD[c] = mD[c]! + d;
		mG[c] = mG[c]! + g;
		mAbs[c] = mAbs[c]! + Math.abs(d) + Math.abs(g);
		yD[y] = yD[y]! + d;
		yG[y] = yG[y]! + g;
		yDays[y] = yDays[y]! + 1;
		// Fully met: the deficit within 1e-9 of the demand, as reliability.ts counts it (MET_NOISE).
		const failed = d > 0 && !(d - g <= 1e-9 * d);
		if (d > 0) {
			days++;
			mDays[c] = mDays[c]! + 1;
			if (!failed) {
				met++;
				mMet[c] = mMet[c]! + 1;
			}
		}
		if (failed) {
			runLen++;
			runDef += d - g;
		} else if (runLen > 0) {
			runs++;
			totalRunDays += runLen;
			totalRunDef += runDef;
			longest = Math.max(longest, runLen);
			maxDef = Math.max(maxDef, runDef);
			runLen = 0;
			runDef = 0;
		}
	}
	if (runLen > 0) {
		runs++;
		totalRunDays += runLen;
		totalRunDef += runDef;
		longest = Math.max(longest, runLen);
		maxDef = Math.max(maxDef, runDef);
	}
	return { dm, gm, abs, days, met, mD, mG, mAbs, mDays, mMet, yD, yG, yDays, runs, totalRunDays, totalRunDef, longest, maxDef };
}

function assuranceCells(cd: number[][], cg: number[][], ca: number[][], D: number[], G: number[], row: Int32Array, col: Uint8Array, days: number): void {
	for (let t = 0; t < days; t++) {
		const i = row[t]!;
		const c = col[t]!;
		cd[i]![c] = cd[i]![c]! + D[t]!;
		cg[i]![c] = cg[i]![c]! + G[t]!;
		ca[i]![c] = ca[i]![c]! + Math.abs(D[t]!) + Math.abs(G[t]!);
	}
}

function accountEwrTally(rule: number[] | undefined, pragmatic: number[], short: number[], from: number, to: number) {
	let req = 0;
	let met = 0;
	let abs = 0;
	let notMet = 0;
	for (let t = from; t <= to; t++) {
		const rr = rule?.[t];
		const r = rr !== undefined && Number.isFinite(rr) ? rr : pragmatic[t]!;
		const sh = short[t]!;
		req += r;
		met += r + Math.min(sh, 0);
		abs += Math.abs(r) + Math.abs(sh);
		if (sh < 0) notMet++;
	}
	return { req, met, abs, notMet };
}
