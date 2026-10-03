// Model entry point: runModel(input) → daily series + summary for a project.
//
// Pipeline (b023 sheet in brackets):
//   1. natural flow from rain                     [Flow data]            → ./runoff (GR4J)
//   2. per-farm share of flow and EWR             [Fragmented flow/EWR]  → ./network/shares.ts
//   3. daily net irrigation demand                [Irrigation Demand]    → ./demand.ts
//   4. transfers + farm dams, routed downstream   [Transfers], Elements  → ./network/simulate.ts
//   5. EWR shortfalls, calibration statistics     [EWR shortfalls]       → ./network/stats.ts
//   6. curtailment targets per farm               [Shortfalls]           → ./network/curtailment.ts
// See ./network/README.md for the column-by-column mapping.
import {
	agreementOptions,
	agreementWarning,
	areaMismatches,
	areaMismatchWarning,
	observedAgreement,
	seriesChecks
} from './quality';
import { ACCUMULATION_COLUMN, type AccumulationRun } from './accumulation';
import { hasRainInput, RAIN_SOURCE_COLUMN, rainSourceCodes } from './rainSourcePeriods';
import { aboveRainThreshold } from './rainThreshold';
import { chirpsFactorOn, chirpsQuantileMapper, type ChirpsCorrection, withChirpsGapMapLead, ZERO_RAIN_COLUMN } from './rain';
import { FLOW_FILL_COLUMNS, GAP_FILL_KINDS, hasReadingBefore, type GapFillKind } from './flowGapFill';
import { doubleMassCheck } from './doublemass';
import { plausibilityChecks, type GaugePlausibilityInput } from './plausibility';
import { flaggedDayMask, FLOW_QUALITY_COLUMN, hasFlaggedDay, recordFlowFlags } from './calibrate/dayFlags';
import { daysPerMonth, fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from './calendar';
import { cropFactorAreaM2, demandFactorOf, demandFactorStart, unitPartFactor, farmDailyDemand, farmIrrigationEfficiency, grossFarmDemandM3PerDay, ownCropEfficiency, type Crop } from './demand';
import { apanDailyMm } from './evaporation/apanDaily';
import { computeCurtailment, otherUserCurtailment, type ReportWindow } from './network/curtailment';
import { DEFAULT_ANNUAL_THRESHOLD, supplyAssurance } from './network/reliability';
import { attributeEwrShortfall, bindingSite, siteUnits } from './network/attribution';
import { noFlowDays, servedWhileEwrFails } from './reserve/riverMeasures';
import { bindingSeries, EWR_BINDING_SERIES } from './network/bindingSeries';
import { canMove, TRANSFER_RULE_SERIES, transferRuleKey } from './network/transferSeries';
import { transferActiveMonths, transferDailyLimit, validMonthlyRates } from './network/transferRates';
import { isRiverOfftake, OFFTAKE_SERIES, offtakeOrder, offtakeReturns, planOfftakes } from './network/offtake';
import { boreholeOf, boreholesByNode, ga538Warnings, groundwaterAnnualUse } from './network/boreholes';
import { resolveDamCurve, resolveRelease, seepageReturnOf, type DamCurve, type PlanRelease } from './network/dam';
import { operatingOf, supplyOf, userPumpOf } from './network/supply';
import { RIVER_TAKE_SERIES, riverPoolEvaporationKey, riverPoolKey, riverPumpLimitedKey, riverSourcesOf, riverTakeKey } from './network/riverSource';
import { planRestriction, resolveDroughtRestriction, RESTRICTION_SERIES, restrictionCutKey } from './network/restriction';
import { BASIC_NEEDS_SERIES, basicNeedsPopulation, dayFloor, DEMAND_OBJECT_SERIES, demandObjectsByNode, objectDemandKey, objectRank, objectSuppliedKey, planObjects, unitBasicNeeds, waterYearMonths, type PlanObjects } from './network/demandObjects';
import { lowFlowThreshold, resolveLandCover } from './network/landcover';
import { flowShares, overAllocationError } from './network/shares';
import { shortfall, simulateNetwork, type FarmWorkings, type NetworkPlan, type NodeResult, type PlanNode, type PlanTransfer } from './network/simulate';
import { verifyRun } from './verify/verify';
import { compareAllocations, DEFAULT_ALLOCATION_TOLERANCE } from './allocations/compare';
import { ALLOCATION_SERIES, limitBoundKind, matchAllocations, outsideMonths, planAllocations, resolveAllocationMode, scaleDemandToAllocation, type AllocationPlan } from './allocations/mode';
import { ewrCompliance } from './network/ewr';
import { ewrAgreement } from './network/ewrAgreement';
import { calibrationFitStatus, exclusionRanges } from './calibrate/provenance';
import { calibrationSiteError } from './calibrate/site';
import { calibrationStats } from './network/stats';
import { buildTopology, canonicalOrder, ewrSiteNodes } from './network/topology';
import { cmpStr } from './order';
import { runRain, wr2012Report } from './reference/wr2012';
import { ewrRuleTableNotes } from './reserve/rules';
import { assessSite, assuranceWarnings, baseflowHistoryAt, monthCarryAt, type EwrAssuranceSite, type MonthCarry } from './reserve/assurance';
import { naturalFlowFor, resolveCatchmentAreaKm2, type NaturalFlowInput, type RunContext } from './runoff';
import {
	AREAL_RAIN_COLUMN,
	arealRainFactors,
	CALIBRATION_FLOW_KINDS,
	calibrationRecordsAt,
	calibrationSeriesKey,
	type EwrAgreementSite,
	DAM_AREA_EXPONENT,
	DAM_AREA_EXPONENT_MAX,
	DEMAND_OBJECT_SOURCES,
	DEMAND_PARTS,
	ESTIMATED_DAM_AREA_LABEL,
	estimatedDamAreaM2,
	LAND_COVER_CLASSES,
	OBSERVED_SERIES_LABEL,
	parseGaugeSeriesKey,
	upgradeLegacyModel,
	type CalibrationFlowKind,
	type DailySeries,
	type DemandObjectSummary,
	type DroughtRestrictionRule,
	type DroughtRestrictionSummary,
	type FarmSummary,
	type ForecastRainDays,
	type LandCoverClass,
	type LandCoverSummary,
	type ModelInput,
	type ModelOutput,
	type NetworkNode,
	type ProjectSettings,
	type RunSeries,
	type SeriesKind,
	type RunAllocationNode,
	type RunAllocations,
	type RunAllocationSource,
	type RiverTakeSummary,
	type UserSummary
} from './project';
import type { AllocationLimitBound } from './project';
import { ENGINE_VERSION } from './version';
import { damFigures } from './network/damLevel';
import { alignFlow, alignSeries, monthly, prepareRun, type PreparedRun } from './prepare';
import { abstractionStartDay, capacityScaleOf, DAM_CAPACITY_SERIES, damCapacityOn } from './network/development';
import { forecastTail } from './forecastTail';
import { DAM_CURVE_CAPACITY_TOLERANCE, damCurveProblem } from './network/damCurve';
import { makeSnapshot, ModelStateMismatchError, openSnapshot, type ModelState, type ModelStateSnapshot } from './warmstart/snapshot';

/**
 * Capture / resume inside one run (engine ≥ 1.1.0, ./warmstart): capture
 * the state at the start of epoch day `captureDay` into `sink.state`, or start
 * from `resume`. `continued`: the resumed run starts part-way through the
 * capture run's record (its day isn't the capture run's first).
 */
interface WarmRun {
	/** The epoch day to capture the state at the start of: the run's first … the day after its last. */
	captureDay?: number;
	resume?: ModelState;
	continued?: boolean;
	sink?: { state?: ModelState };
}

const SEC_PER_DAY = 86_400;

/**
 * A plain number[] copy of a daily series. A run writes ~150 series of a
 * whole record (≈ 830 000 values on an example catchment); Array.from on a
 * typed array walks its iterator and cost ~14 ms of a ~70 ms run, where an
 * indexed copy costs ~1 ms (docs/followups.md, the example-catchment budget).
 */
function toPlainArray(values: ArrayLike<number>): number[] {
	const n = values.length;
	const a = new Array<number>(n);
	for (let i = 0; i < n; i++) a[i] = values[i]!;
	return a;
}

export type { NaturalFlowInput, RunContext } from './runoff';
export { resolveCatchmentAreaKm2 } from './runoff';

/** Run the full model: natural flow from the selected runoff model (./runoff), then the network. */
export function runModel(input: ModelInput): ModelOutput {
	return runModelWith(input, (ctx) => naturalFlowFor(ctx.settings.runoffModel)(input, ctx));
}

/**
 * runModel without the hydrologist plausibility checks and the assurance of
 * supply: `summary.plausibility` and `summary.supplyAssurance` are absent and
 * the checks' warnings aren't added; every other series and summary figure is
 * identical. For the uncertainty ensemble, whose hundreds of member
 * runs read none of it (ensemble.ts memberMetrics / memberScores). Nothing
 * here references ./plausibility or ./network/reliability, so a bundle that
 * only runs ensembles (the browser's calibration worker) leaves that code out.
 */
export function runModelWithoutChecks(input: ModelInput): ModelOutput {
	return runNetwork(input, (ctx) => naturalFlowFor(ctx.settings.runoffModel)(input, ctx), null, null);
}

/**
 * runModelWithoutChecks, and the model's complete state at the start of
 * `at` (ISO; the run's first day … the day after its last) as a snapshot
 * (engine ≥ 1.1.0, ./warmstart, docs/model.md §2.16). The output is
 * runModelWithoutChecks(input)'s to the bit: capturing changes nothing.
 * A run whose natural flow isn't the engine's own runoff model can't be
 * captured (runModelWith).
 */
export function runModelCapturing(input: ModelInput, at: string): { output: ModelOutput; snapshot: ModelStateSnapshot } {
	if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(at) || fromEpochDay(toEpochDay(at)) !== at) throw new RangeError(`capture date "${String(at)}" is not an ISO date (YYYY-MM-DD)`);
	const sink: WarmRun['sink'] = {};
	const output = runNetwork(input, (ctx) => naturalFlowFor(ctx.settings.runoffModel)(input, ctx), null, null, { captureDay: toEpochDay(at), sink });
	const state = sink.state!;
	// Columns a run carries only when a day of it needs them: a resumed run keeps them, as zeros when none of its days do.
	output.series.forEach((x, i) => {
		if (!HISTORY_COLUMNS.has(x.key) && !KEPT_COLUMNS.has(x.key)) return;
		const prev = output.series[i - 1];
		state.columns.push({ nodeId: x.nodeId, key: x.key, label: x.label, unit: x.unit, after: prev ? { nodeId: prev.nodeId, key: prev.key } : null });
	});
	return { output, snapshot: makeSnapshot(input, at, output.startDate, state) };
}

/** The model's state at the start of `at` as a snapshot: runModelCapturing without the output. */
export function captureModelState(input: ModelInput, at: string): ModelStateSnapshot {
	return runModelCapturing(input, at).snapshot;
}

/**
 * Run the model from a snapshot (engine ≥ 1.1.0, ./warmstart, docs/model.md
 * §2.16): from the snapshot's day to the input's simulationEnd (else its
 * last day of rain), starting from the snapshot's state and with its pinned
 * record-wide statistics, as runModelWithoutChecks does (no plausibility
 * checks, no assurance of supply). Every daily series equals, to the bit,
 * the same days of an uninterrupted run of the capture input; the summary
 * covers the resumed days only. `input` carries the new days' driving
 * series, with or without the history before the snapshot's day (when it
 * has any, it must be the capture input's), the same model and the same
 * settings but the window: settings.simulationStart is the snapshot's day
 * whatever the input says; a demand factor from the snapshot's day on
 * (settings.demandFactorFrom) and a storage reset on or after it are free
 * to differ. Throws ModelStateMismatchError on a snapshot from another
 * engine version, format or input.
 */
export function runModelFrom(snapshot: ModelStateSnapshot, input: ModelInput): ModelOutput {
	const state = openSnapshot(snapshot, input);
	const day = toEpochDay(snapshot.date);
	const reset = input.settings.damStorageReset;
	const settings: ModelInput['settings'] = {
		...input.settings,
		simulationStart: snapshot.date,
		// A reset before the snapshot's day is in its history already (the fingerprint checked it is the capture's).
		...(reset && typeof reset === 'object' && typeof reset.date === 'string' && reset.date < snapshot.date ? { damStorageReset: null } : {})
	};
	const end = settings.simulationEnd;
	if (typeof end === 'string' && end < snapshot.date) throw new ModelStateMismatchError('window', `the run ends (${end}) before the snapshot's day ${snapshot.date}`);
	const resumed: ModelInput = { ...input, settings };
	const output = runNetwork(resumed, (ctx) => naturalFlowFor(ctx.settings.runoffModel)(resumed, ctx), null, null, { resume: state, continued: day > toEpochDay(snapshot.runStart) });
	if (output.startDate !== snapshot.date) throw new Error(`the resumed run starts on ${output.startDate}, not the snapshot's day ${snapshot.date}`);
	for (const c of state.columns) {
		const has = (nodeId: string | null, key: string) => output.series.findIndex((x) => x.nodeId === nodeId && x.key === key);
		if (has(c.nodeId, c.key) >= 0) continue;
		// A kept column (the quality flags) the resumed run didn't compute has no record behind it (an input
		// without the flow record, such as an outlook member's): zeros would claim every day in the gauged range.
		if (KEPT_COLUMNS.has(c.key)) continue;
		const at = c.after ? has(c.after.nodeId, c.after.key) : -1;
		output.series.splice(at + 1, 0, { nodeId: c.nodeId, key: c.key, label: c.label, unit: c.unit, values: new Array<number>(output.days).fill(0) });
	}
	return output;
}

/** Columns a run adds only when one of its days needs them, which a resumed run keeps from its capture run (all 0 on its days then). */
const HISTORY_COLUMNS = new Set([ZERO_RAIN_COLUMN.key, ACCUMULATION_COLUMN.key, 'dam_storage_set', 'senior_requirement', 'passed_for_senior']);
/** Columns a resumed run keeps from its capture run by computing them for its own days (never zeros: a code 0 is a class). */
const KEPT_COLUMNS = new Set<string>([FLOW_QUALITY_COLUMN.key]);

/**
 * runModel, then the engine's checks on its own output (./verify): what a
 * saved run uses. The checks are a separate step so runModel stays within its
 * time budget and the tests that re-run the model don't pay for them.
 */
export function runModelChecked(input: ModelInput): ModelOutput {
	return withVerification(input, runModel(input));
}

/**
 * Attach summary.verification and summary.waterBalance (engine ≥ 0.12.0) to a
 * run's output. A failed check is reported, never thrown: the run is kept so
 * the failure can be looked into, and each failed check becomes a warning.
 */
export function withVerification(input: ModelInput, output: ModelOutput): ModelOutput {
	const cal = { catchmentAreaKm2: input.settings.calibration?.catchmentAreaKm2 ?? null };
	const { verification, waterBalance } = verifyRun(input, output, resolveCatchmentAreaKm2(cal, input));
	const warnings = [...output.summary.warnings];
	for (const c of verification.checks) if (!c.passed) warnings.push(`self-check failed (${c.label}): ${c.detail}`);
	return { ...output, summary: { ...output.summary, verification, waterBalance, warnings } };
}

/**
 * Run the network with natural flow supplied by `naturalFlow` instead of the
 * rain model. runModel uses this with the selected runoff model; the workbook regression test
 * uses it to feed the workbook's own natural flow and so test the network on
 * its own.
 */
export function runModelWith(
	input: ModelInput,
	naturalFlow: (ctx: RunContext) => NaturalFlowInput
): ModelOutput {
	return runNetwork(input, naturalFlow, runPlausibility, supplyAssurance);
}

/**
 * The model run itself. `plausibility` is the checks step (runPlausibility)
 * and `assuranceOf` the assurance of supply (WP-3.4, supplyAssurance), passed
 * in rather than called directly so that runModelWithoutChecks, which passes
 * null for both, doesn't reference them and a bundler can drop them.
 */
function runNetwork(
	input: ModelInput,
	naturalFlow: (ctx: RunContext) => NaturalFlowInput,
	plausibility: typeof runPlausibility | null,
	assuranceOf: typeof supplyAssurance | null,
	warm: WarmRun = {}
): ModelOutput {
	const capturing = warm.captureDay !== undefined;
	const resume = warm.resume;
	const prepared = prepareRun(input, {
		...(resume ? { pinned: resume.pinned.fits, resumedFill: { kinds: resume.flowFillHistory ?? [] } } : {}),
		...(capturing ? { captureFits: true } : {})
	});
	const { warnings, settings, series, start, end, days, startDate, aligned, month, chirpsCorrection, zeroRain, accumulation, doubleMass, rainSource, apanDaily, flowFill } = prepared;
	const captureAt = capturing ? warm.captureDay! - start : undefined;
	// The days before a forecast tail (engine ≥ 1.28.0, engine-audit.md K1): the record-wide
	// statistics (GR4J's cycled warm-up, the land-cover Q75, the Reserve's assessed months and
	// their natural duration curves) read only these, so a tail never moves a historical value.
	const historyDays = forecastTail(prepared).historyDays;
	if (captureAt !== undefined && (captureAt < 0 || captureAt > days))
		throw new RangeError(`capture date ${fromEpochDay(warm.captureDay!)} is outside the run (${startDate} … ${fromEpochDay(end)}, or the day after it)`);

	// --- natural flow ---------------------------------------------------------
	const runoffWarm = capturing || resume ? { ...(capturing ? { captureAt: captureAt! } : {}), ...(resume ? { resume: resume.runoff.state } : {}) } : undefined;
	if (resume && resume.runoff.model !== settings.runoffModel) throw new ModelStateMismatchError('input', `the snapshot holds a ${resume.runoff.model} runoff model's state; the run uses ${settings.runoffModel}`);
	const nf = naturalFlow({ settings, startDate, days, aligned, historyDays, ...(runoffWarm ? { warm: runoffWarm } : {}) });
	if (nf.naturalFlowM3Day.length !== days) {
		throw new Error(`natural flow has ${nf.naturalFlowM3Day.length} days, expected ${days}`);
	}
	if (capturing && !nf.state) throw new Error('this natural flow has no state to capture (only the engine\u2019s own runoff models can be captured)');
	const natural = Float64Array.from(nf.naturalFlowM3Day, (v) => (Number.isFinite(v) ? v : 0));
	warnings.push(...(nf.warnings ?? []));
	const areal = arealRainFactors(settings.arealRain);
	const runoffCoefficient = catchmentRunoffCoefficient(input, settings, natural, aligned, warnings, nf.balance, areal, month);
	// The day's rainfall after gap-filling: catchment, else corrected CHIRPS, else forecast.
	const finalRain = runRain(aligned, hasRainInput(series, settings.rainSource), days);
	// The rain on the catchment as GR4J ran on it (engine ≥ 1.13.0, §2.4g): rain_final × the areal
	// factor. What the catchment's own water balance reads (the WR2012 rain scaling, the water
	// account, the plausibility checks); the same array as finalRain without a correction.
	const catchmentRain = areal && finalRain ? finalRain.map((v, t) => (v === null ? null : v * areal[waterYearIndex(month[t]!)]!)) : finalRain;
	// WR2012 flows are naturalised: compare them with natural flow, never the outflow.
	const wr2012 = wr2012Report(
		{
			settings: settings.wr2012,
			startDate,
			natural,
			areaKm2: resolveCatchmentAreaKm2(settings.calibration, input),
			rainMm: catchmentRain
		},
		warnings
	);

	// --- network ----------------------------------------------------------------
	const built = buildNetworkPlan(input, settings, days, month, aligned, natural, warnings, start, {
		...(capturing ? { captureAt: captureAt! } : {}),
		...(resume ? { soilStoreM3: resume.nodes.map((n) => n.soilStoreM3), allocationFactor: resume.nodes.map((n) => n.allocationFactor) } : {})
	}, historyDays);
	const { plan, topo } = built;
	const nodes = input.model.nodes;
	const ewr = plan.ewr;
	// A resumed run starts from the snapshot's state and its pinned statistics (engine ≥ 1.1.0).
	if (resume) {
		plan.nodes.forEach((p, i) => {
			const r = resume.nodes[i]!;
			p.initialStorageM3 = r.storageM3;
			p.initialDepletionStoreM3 = r.depletionStoreM3;
			if (r.depletionDeficitM3) p.initialDepletionDeficitM3 = r.depletionDeficitM3;
			p.initialOnRiver = r.onRiver;
			if (r.poolStorageM3 && p.river) p.initialPoolM3 = r.poolStorageM3;
			if (r.boreholeUsedM3) p.initialBoreholeUsedM3 = r.boreholeUsedM3;
			if (r.allocationUsedM3 && p.allocationCap) p.initialAllocationUsedM3 = r.allocationUsedM3;
		});
		if (resume.pinned.lowFlowThresholdM3Day !== null) plan.lowFlowThresholdM3Day = resume.pinned.lowFlowThresholdM3Day;
		if (warm.continued) plan.continued = { monthBefore: monthOfEpochDay(start - 1) };
		// The drought restriction level held the day before (engine ≥ 1.54.0): only part-way through the capture run;
		// a snapshot of its first day holds none, so the resumed run decides that day as the capture run did.
		if (plan.restriction && warm.continued) {
			plan.restriction.initialLevels = Uint8Array.from(nodes, (_, i) => resume.restrictionLevels?.[i] ?? 0);
			plan.restriction.initialEwrFailed = resume.restrictionEwrFailed === true;
		}
	}
	// Land cover's low-flow threshold over the historical days only.
	if (plan.lowFlowThresholdM3Day === undefined && plan.nodes.some((n) => n.landCover)) plan.lowFlowThresholdM3Day = lowFlowThreshold(natural.subarray(0, historyDays));
	const sim = simulateNetwork(plan, { workings: true, ...(capturing ? { captureAt: captureAt! } : {}) });

	// --- outputs -----------------------------------------------------------------
	const out: RunSeries[] = [];
	const push = (nodeId: string | null, key: string, label: string, unit: string, values: ArrayLike<number>) =>
		out.push({ nodeId, key, label, unit, values: toPlainArray(values) });

	const simOutflow = topo.outflow >= 0 ? sim.nodes[topo.outflow]!.outflow : new Float64Array(days);
	const observedKind = pickObservedKind(settings.calibrationFlowKind, series, warnings);
	const observedM3s = observedKind ? aligned(observedKind) : [];
	const ewrShort = new Float64Array(days);
	let ewrDaysNotMet = 0;
	for (let t = 0; t < days; t++) {
		const d = shortfall(simOutflow[t]!, ewr[t]!, Math.max(simOutflow[t]!, ewr[t]!));
		if (d < 0) {
			ewrDaysNotMet++;
			ewrShort[t] = d;
		}
	}

	push(null, 'natural_flow', 'Natural flow', 'm³/day', natural);
	// Land cover (WP-1.35): the catchment's total reduction, its own series so it is never hidden in calibration.
	const hasCover = plan.nodes.some((n) => n.landCover);
	const coverTotal = new Float64Array(hasCover ? days : 0);
	if (hasCover) {
		for (const i of nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))) {
			const r = sim.nodes[i]!;
			for (let t = 0; t < days; t++) coverTotal[t]! += r.landCoverReduction[t]!;
		}
		push(null, 'landcover_reduction', 'Natural flow removed by land cover (invasive plants, forestry)', 'm³/day', coverTotal);
	}
	push(null, 'simulated_outflow', 'Simulated outflow', 'm³/day', simOutflow);
	if (observedKind) {
		push(
			null,
			'observed_flow',
			OBSERVED_SERIES_LABEL[observedKind],
			'm³/day',
			// m³/s × 86400 (the workbook rounds [Flow data] P); missing days are NaN so charts show gaps.
			observedM3s.map((v) => (v === null ? NaN : v * SEC_PER_DAY))
		);
		// The other record too, when the project has both (engine ≥ 0.39.0,
		// issue #45): shown beside the calibration record, never scored.
		const otherKind = CALIBRATION_FLOW_KINDS.find((k) => k !== observedKind && series[k]);
		if (otherKind) {
			push(
				null,
				'observed_flow_other',
				OBSERVED_SERIES_LABEL[otherKind],
				'm³/day',
				aligned(otherKind).map((v) => (v === null ? NaN : v * SEC_PER_DAY))
			);
		}
		// Gap filling (engine ≥ 1.23.0, ./flowGapFill.ts): each filled record's filled days and method, beside it.
		for (const [col, kind] of [['observed_flow', observedKind], ['observed_flow_other', otherKind]] as const) {
			const f = kind ? flowFill?.[kind] : undefined;
			if (!f?.any) continue;
			const c = FLOW_FILL_COLUMNS[col];
			push(null, c.values.key, c.values.label, 'm³/day', f.values.map((v, t) => (f.code[t] && v !== null ? v * SEC_PER_DAY : NaN)));
			push(null, c.code.key, c.code.label, '', f.code);
		}
	}
	// The calibration site (engine ≥ 1.41.0, settings.calibrationSiteNodeId): a gauge inside the network whose
	// record the run's calibration statistics score. Its record is that node's `observed_flow` series (and the
	// other record, when it has both), beside the node's own `outflow`. An unusable site warns and the run scores the outlet.
	const calSite = runCalibrationSite(input, settings.calibrationSiteNodeId ?? null, topo.outflow, warnings);
	let calKind = observedKind;
	let calObserved = observedM3s;
	let calSim = simOutflow;
	if (calSite) {
		const kinds = calibrationRecordsAt(series, calSite.nodeId);
		const wanted = settings.calibrationFlowKind;
		calKind = wanted && kinds.includes(wanted) ? wanted : kinds[0]!;
		const at = (k: CalibrationFlowKind) => alignFlow(series[calibrationSeriesKey(k, calSite.nodeId)], start, days);
		calObserved = at(calKind);
		calSim = sim.nodes[calSite.node]!.outflow;
		const toDay = (v: (number | null)[]) => v.map((x) => (x === null ? NaN : x * SEC_PER_DAY));
		push(calSite.nodeId, 'observed_flow', OBSERVED_SERIES_LABEL[calKind], 'm³/day', toDay(calObserved));
		const other = kinds.find((k) => k !== calKind);
		if (other) push(calSite.nodeId, 'observed_flow_other', OBSERVED_SERIES_LABEL[other], 'm³/day', toDay(at(other)));
	}
	// The scored record's per-day quality flags (engine ≥ 1.48.0, CR-18, ./calibrate/dayFlags.ts): the classes the fit
	// reads, beside the scored `observed_flow` (the outlet's or the calibration site's), only when a day is flagged.
	// A run resumed from a snapshot whose capture run stored them stores them too, so the two have the same columns.
	// A resumed run whose input leaves out the record's history (the capture's record had readings before the
	// snapshot's day, this input has none before its start) can't judge the suspect class, which reads the whole
	// record: it leaves the class out and says so, rather than flag other days than the uninterrupted run.
	let outletFlowFlags: Uint8Array | null = null;
	// The scored record's classes, wherever it is: the validation signatures' recession segments leave its flagged days out.
	let scoredFlowFlags: Uint8Array | null = null;
	let flowRecordHistory = false;
	if (calKind) {
		const siteId = calSite?.nodeId ?? null;
		const record = series[calibrationSeriesKey(calKind, siteId)];
		if (captureAt !== undefined) flowRecordHistory = hasReadingBefore(record, start + captureAt);
		const noHistory = !!resume?.flowRecordHistory && !hasReadingBefore(record, start);
		if (noHistory) {
			warnings.push(
				`Resumed from ${startDate} without the ${OBSERVED_SERIES_LABEL[calKind].toLowerCase()} record's history: its quality flags leave out the suspect class (outliers and flat stretches are judged over the whole record). Include the history in the input, or run from the start, for the full flags.`
			);
		}
		const flags = recordFlowFlags({
			kind: calKind,
			series: record,
			start,
			days,
			settings,
			siteNodeId: siteId,
			flowFill,
			...(noHistory ? { suspect: false } : {})
		});
		const kept = resume?.columns.some((c) => c.key === FLOW_QUALITY_COLUMN.key && c.nodeId === siteId) ?? false;
		if (kept || hasFlaggedDay(flags)) push(siteId, FLOW_QUALITY_COLUMN.key, FLOW_QUALITY_COLUMN.label, FLOW_QUALITY_COLUMN.unit, flags);
		// At the outlet these are the outlet record's flags, which the plausibility checks read too.
		if (siteId === null) outletFlowFlags = flags;
		scoredFlowFlags = flags;
	}
	push(null, 'ewr', 'Pragmatic EWR', 'm³/day', ewr);
	// The drought restriction (engine ≥ 1.54.0, docs/model.md §2.7i): the level in force each day and, per part a
	// level cuts, that day's cut, on the catchment; each unit's demand after it is a unit column below.
	const restrictionRule = plan.restriction ? resolveDroughtRestriction(settings.droughtRestriction, []) : null;
	if (plan.restriction && sim.restrictionLevel) {
		push(null, RESTRICTION_SERIES.level.key, plan.restriction.shared ? RESTRICTION_SERIES.level.label : RESTRICTION_SERIES.deepestLabel, RESTRICTION_SERIES.level.unit, sim.restrictionLevel);
		// The day's cut per part: one level for every unit (a shared basis) only; under 'own' each unit's level says it.
		if (plan.restriction.shared) DEMAND_PARTS.forEach((part, p) => {
			if (!plan.restriction!.cut.some((c) => c[p]! > 0)) return;
			push(null, restrictionCutKey(part), RESTRICTION_SERIES.cutLabel(part), RESTRICTION_SERIES.cutUnit, Float64Array.from(sim.restrictionLevel!, (l) => plan.restriction!.cut[l]![p]!));
		});
	}
	push(null, 'ewr_shortfall', 'EWR not met (negative = shortfall)', 'm³/day', ewrShort);

	// Who is charged for a shortfall (engine ≥ 0.17.0, audit Q17): the EWR is
	// assessed at the outlet and every gauge that is an EWR site (engine ≥
	// 1.5.0: a gauge whose ewrSite flag is false only measures), and each
	// site's shortfall is charged to the farms upstream of it pro rata to their
	// net impact (./network/attribution.ts). Sites: the outlet first, then
	// gauges by node id (./network/topology.ts ewrSiteNodes).
	const siteNodes = ewrSiteNodes(nodes, topo.outflow);
	// A canonical order (network/topology.ts canonicalOrder), not the
	// calculation order, which follows sortOrder: the attribution sums impacts
	// in it, so the charges don't depend on the display order in their last bit.
	const ranked = canonicalOrder(nodes, topo);
	const kinds = plan.nodes.map((n) => n.kind);
	// The Reserve's assurance rules (engine ≥ 0.21.0, hydrologist Q6): monthly
	// compliance at each EWR site with a rule table (./reserve/assurance.ts).
	// Assessed before the attribution, which may follow it (settings.ewrChargeSource).
	const ewrAssurance = assessEwrRules(
		settings,
		nodes,
		topo.outflow,
		siteNodes.map((node) => ({ node, farms: siteUnits(kinds, plan.upstream, ranked, node) })),
		sim,
		simOutflow,
		startDate,
		days,
		historyDays,
		warnings,
		{
			...(resume ? { pinned: resume.pinned.reserveNatural, ...(warm.continued ? { carried: resume.reserveMonths } : {}) } : {}),
			...(capturing ? { captureAt: captureAt! } : {})
		}
	);
	// What each EWR site's charge follows (engine ≥ 1.3.0, issue #64): the pragmatic EWR, or
	// with settings.ewrChargeSource 'ruleTable' the site's rule-table requirement where it has one.
	const chargeSites = ewrChargeSites(settings, siteNodes, topo.outflow, ewrAssurance, sim, simOutflow, ewr, ewrShort, days, nodes, warnings);
	// Units served in full while an EWR site below them fails (engine ≥ 1.33.0, issue #71, ./reserve/riverMeasures.ts):
	// per site, against the daily requirement its charge follows.
	const servedWhileFails = servedWhileEwrFails({
		days,
		sites: chargeSites.map((c) => ({
			nodeId: c.node === topo.outflow ? null : nodes[c.node]!.id,
			name: nodes[c.node]!.name,
			ruleTable: c.ruleTable,
			shortfall: c.shortfall,
			units: siteUnits(kinds, plan.upstream, ranked, c.node)
		})),
		nodes,
		demand: sim.nodes.map((r) => r.demand),
		supplied: sim.nodes.map((r) => r.supplied)
	});
	const attribution = attributeEwrShortfall({
		days,
		kind: plan.nodes.map((n) => n.kind),
		upstream: plan.upstream,
		order: ranked,
		inflow: sim.nodes.map((r) => r.inflowUpstream),
		runoff: sim.nodes.map((r) => r.runoff),
		outflow: sim.nodes.map((r) => r.outflow),
		supplied: sim.nodes.map((r) => r.supplied),
		storage: sim.nodes.map((r) => r.storage),
		consumptivePerSupplied: plan.nodes.map(consumptivePerSupplied),
		// A unit with demand objects (engine ≥ 1.7.0): its objects return their own shares, so c = G − T day by day.
		...(plan.nodes.some((n) => n.objects) ? { consumptive: plan.nodes.map((n, i) => (n.objects ? consumptiveDaily(sim.nodes[i]!.supplied, sim.workings![i]!.returnFlow) : undefined)) } : {}),
		...(resume && warm.continued ? { storageBefore: resume.nodes.map((r) => r.setFromM3 ?? r.storageM3) } : {}),
		// A river off-take (engine ≥ 1.14.0) counts like a transfer, with what it took at both ends: its conveyance
		// losses are charged to its destination, for which the water was taken.
		transfers: [...plan.transfers.map((tr, k) => ({ from: tr.from, to: tr.to, volume: sim.transfers[k]! })), ...(plan.offtakes ?? []).map((o, k) => ({ from: o.from, to: o.to, volume: sim.offtakes![k]! }))],
		// The share of its losses that seeps back (engine ≥ 1.42.0) is credited where the losses were charged.
		...(plan.offtakes?.some((o) => o.lossReturn > 0) ? { returns: offtakeReturns(plan.offtakes, sim.offtakes!) } : {}),
		sites: chargeSites.map((c) => ({ node: c.node, shortfall: c.shortfall }))
	});
	const posInOrder = new Int32Array(nodes.length);
	ranked.forEach((node, k) => (posInOrder[node] = k));
	for (const [si, site] of attribution.sites.entries()) {
		const id = si === 0 && topo.outflow >= 0 ? null : nodes[site.node]!.id;
		push(id, 'ewr_charged', 'EWR shortfall charged to the farms upstream (negative)', 'm³/day', site.charged);
		push(id, 'ewr_natural', 'EWR shortfall not caused by use: natural (negative)', 'm³/day', site.natural);
		if (chargeSites[si]!.ruleTable) push(id, 'ewr_charge_shortfall', EWR_CHARGE_SHORTFALL_LABEL, 'm³/day', chargeSites[si]!.shortfall);
	}
	// Each transfer rule's daily volume (engine ≥ 1.6.0), on its source farm, for
	// every rule that can move water (./network/transferSeries.ts canMove): the
	// attribution counts a rule only at the sites with both its ends upstream,
	// which the farms' net `transfer` series can't tell apart.
	plan.transfers.forEach((tr, k) => {
		if (tr.seriesKey) push(nodes[tr.from]!.id, tr.seriesKey, TRANSFER_RULE_SERIES.label(nodes[tr.to]!.name), TRANSFER_RULE_SERIES.unit, sim.transfers[k]!);
	});
	// A river off-take's (engine ≥ 1.14.0): what it took from the river, before losses, under the same key.
	(plan.offtakes ?? []).forEach((o, k) => {
		if (o.seriesKey) push(nodes[o.from]!.id, o.seriesKey, OFFTAKE_SERIES.rule(nodes[o.to]!.name), TRANSFER_RULE_SERIES.unit, sim.offtakes![k]!);
	});
	for (const a of ewrAssurance) push(a.report.nodeId, 'ewr_rule', 'EWR from the Reserve rule table (the month’s requirement, per day)', 'm³/day', a.requiredM3Day);
	for (const s of nf.series ?? []) push(null, s.key, s.label, s.unit, s.values);
	// No value from any source = NaN.
	if (finalRain) push(null, 'rain_final', 'Final catchment rainfall (gaps filled by corrected CHIRPS then forecast)', 'mm', finalRain.map((v) => v ?? NaN));
	if (areal && catchmentRain) push(null, AREAL_RAIN_COLUMN.key, AREAL_RAIN_COLUMN.label, AREAL_RAIN_COLUMN.unit, catchmentRain.map((v) => v ?? NaN));
	for (const s of chirpsColumns(series.rain_chirps_mm, chirpsCorrection, start, days, month)) push(null, s.key, s.label, s.unit, s.values);
	if (zeroRain && zeroRain.infill.days > 0) push(null, ZERO_RAIN_COLUMN.key, ZERO_RAIN_COLUMN.label, ZERO_RAIN_COLUMN.unit, zeroRain.mask);
	// Where each day's rain came from: with rain-source periods their column, else (engine ≥ 1.27.0) the same pick as rain_final.
	if (rainSource) push(null, RAIN_SOURCE_COLUMN.key, RAIN_SOURCE_COLUMN.label, RAIN_SOURCE_COLUMN.unit, rainSource.column);
	else if (finalRain) {
		const codes = rainSourceCodes(aligned('rain_catchment_mm'), aligned('rain_chirps_mm'), aligned('rain_forecast_mm'));
		push(null, RAIN_SOURCE_COLUMN.key, RAIN_SOURCE_COLUMN.label, RAIN_SOURCE_COLUMN.unit, codes);
	}
	if (accumulation && accumulation.info.spreadDays > 0) push(null, ACCUMULATION_COLUMN.key, ACCUMULATION_COLUMN.label, ACCUMULATION_COLUMN.unit, accumulation.mask);

	const farmSeries: [Exclude<keyof NodeResult, 'boreholePumped' | 'riverAbstraction' | 'pumpLimited' | 'restrictedDemand' | 'storageSet' | 'objectSupplied' | 'riverTakes' | 'offtakeIn' | 'offtakeOut' | 'offtakeReturn' | 'allocationRoom' | 'allocationLeft'>, string, string][] = [
		['cropRequirement', 'crop_requirement', 'Crop water requirement (net irrigation need)'],
		['demand', 'demand', 'Irrigation demand (abstraction: crop requirement ÷ efficiency)'],
		['supplied', 'supplied', 'Irrigation supplied'],
		['deficit', 'deficit', 'Irrigation deficit'],
		['inflowUpstream', 'inflow_upstream', 'Inflow from upstream'],
		['runoff', 'runoff', 'Farm runoff'],
		['transfer', 'transfer', 'Transfer (in + / out −)'],
		['storage', 'dam_storage', 'Dam storage'],
		['spill', 'spill', 'Dam spill'],
		['outflow', 'outflow', 'Outflow'],
		['ewr', 'ewr', 'EWR share'],
		['ewrCumulative', 'ewr_cumulative', 'EWR required (this + upstream)'],
		['ewrShortfall', 'ewr_shortfall', 'EWR shortfall (negative = not met)'],
		['ewrShortfallIncremental', 'ewr_shortfall_incremental', 'Reach shortfall (workbook AB; diagnostic, does not set the EWR charge)']
	];
	const WORKING_SERIES: [Exclude<keyof FarmWorkings, 'offtakeUsed' | 'offtakeToDam'>, string, string, string][] = [
		['grossDemand', 'gross_demand', 'Gross irrigation demand (before effective rain)', 'm³/day'],
		['rainOffset', 'effective_rain', 'Effective rain used against demand (from the day\'s rain or the soil store)', 'm³/day'],
		['soilWater', 'soil_water', 'Soil-water store at the end of the day', 'mm'],
		['upstreamToDam', 'upstream_to_dam', 'Upstream inflow into the dam', 'm³/day'],
		['upstreamBelowDam', 'upstream_below_dam', 'Upstream inflow below the dam', 'm³/day'],
		['runoffToDam', 'runoff_to_dam', 'Farm runoff into the dam', 'm³/day'],
		['runoffBelowDam', 'runoff_below_dam', 'Farm runoff below the dam', 'm³/day'],
		['divertedToDam', 'diverted_to_dam', 'Diverted back to the dam', 'm³/day'],
		['interimStorage', 'interim_storage', 'Interim storage (before spill)', 'm³'],
		['belowDamNotDiverted', 'below_dam_not_diverted', 'Below-dam flow not diverted', 'm³/day'],
		['damArea', 'dam_area', 'Dam surface area (start of day)', 'm²'],
		['rainOnDam', 'rain_on_dam', 'Rain on the dam surface', 'm³/day'],
		['damEvaporation', 'dam_evaporation', 'Evaporation from the dam', 'm³/day'],
		['damSeepage', 'dam_seepage', 'Seepage from the dam (joins the outflow)', 'm³/day'],
		['returnFlow', 'return_flow', 'Irrigation return flow', 'm³/day'],
		['balanceResidual', 'balance_residual', 'Balance check (should be 0)', 'm³/day']
	];
	const gaugeSeries = new Set<keyof NodeResult>(['inflowUpstream', 'outflow', 'ewrCumulative', 'ewrShortfall']);
	// An other water user (WP-1.33): what it wanted, took, returned and left in the river.
	const userSeries = new Set<keyof NodeResult>(['demand', 'supplied', 'deficit', 'inflowUpstream', 'outflow', 'ewrCumulative', 'ewrShortfall']);
	// The senior users' requirement passing each node, only when a senior user's demand is passed down to it.
	const hasSenior = plan.nodes.some((n) => n.seniorClaimed);
	// Each unit's enabled demand objects' names, in the plan's order (engine ≥ 1.7.0).
	const objectNames = new Map<string, string[]>();
	// Each unit's basic-needs floor per day (engine ≥ 1.44.0, docs/model.md §2.7f); null without one.
	const basicNeeds = plan.nodes.map((n) => (n.objects ? unitBasicNeeds(n.objects) : null));
	for (const [nodeId, list] of demandObjectsByNode(upgradeLegacyModel(input.model), [])) objectNames.set(nodeId, list.map((o) => o.name));
	nodes.forEach((node, i) => {
		const r = sim.nodes[i]!;
		const withObjects = !!plan.nodes[i]!.objects;
		for (const [field, key, label] of farmSeries) {
			if (node.kind === 'gauge' && !gaugeSeries.has(field)) continue;
			if (node.kind === 'user' && !userSeries.has(field)) continue;
			push(node.id, key, node.kind === 'user' ? (USER_LABELS[key] ?? label) : withObjects ? (OBJECT_LABELS[key] ?? label) : label, key === 'dam_storage' ? 'm³' : 'm³/day', r[field]);
		}
		// A dam whose capacity changes over the run (engine ≥ 1.30.0, ./network/development.ts): the day's capacity.
		const ks = plan.nodes[i]!.capacityScale;
		if (ks) push(node.id, DAM_CAPACITY_SERIES.key, DAM_CAPACITY_SERIES.label, DAM_CAPACITY_SERIES.unit, Float64Array.from(ks, (k) => k * node.damCapacityM3));
		if (hasSenior) push(node.id, 'senior_requirement', 'Senior users’ demand still to pass below this node', 'm³/day', r.seniorRequirement);
		if (plan.nodes[i]!.landCover) push(node.id, 'landcover_reduction', 'Runoff removed by land cover (invasive plants, forestry)', 'm³/day', r.landCoverReduction);
		if (plan.nodes[i]!.borehole) {
			// Boreholes (WP-1.34): what they gave and what the river loses for it.
			push(node.id, 'groundwater_used', 'Groundwater pumped (part of supplied)', 'm³/day', r.groundwater);
			// Dam-target boreholes (WP-3.9): pumped into the farm dam, not straight to the crop.
			if (plan.nodes[i]!.borehole!.units.some((u) => u.toDam)) push(node.id, 'groundwater_to_dam', 'Groundwater pumped into the dam', 'm³/day', r.groundwaterToDam);
			push(node.id, 'baseflow_depletion', 'Stream depletion taken from the river below (from pumping)', 'm³/day', r.depletion);
			// Engine ≥ 1.10.0: depletion the river can't give is owed, not dropped (depletion_unmet before).
			push(node.id, 'depletion_deficit', 'Stream depletion owed to the river (it had no flow left), taken off the first flow back', 'm³', r.depletionDeficit);
			push(node.id, 'depletion_store', 'Stream depletion still to come (lag store)', 'm³', r.depletionStore);
		}
		// Registered volumes (engine ≥ 1.18.0): the cap's room at the start of each day, per capped source,
		// and the full-allocation demand factor, so the self-checks redo each day from the stored columns.
		if (r.allocationRoom?.surface) push(node.id, ALLOCATION_SERIES.surfaceRoom.key, ALLOCATION_SERIES.surfaceRoom.label, 'm³', r.allocationRoom.surface);
		if (r.allocationRoom?.groundwater) push(node.id, ALLOCATION_SERIES.groundwaterRoom.key, ALLOCATION_SERIES.groundwaterRoom.label, 'm³', r.allocationRoom.groundwater);
		// What is left of the year's volume, for a source whose licence states conditions (engine ≥ 1.40.0).
		if (r.allocationLeft?.surface) push(node.id, ALLOCATION_SERIES.surfaceLeft.key, ALLOCATION_SERIES.surfaceLeft.label, 'm³', r.allocationLeft.surface);
		if (r.allocationLeft?.groundwater) push(node.id, ALLOCATION_SERIES.groundwaterLeft.key, ALLOCATION_SERIES.groundwaterLeft.label, 'm³', r.allocationLeft.groundwater);
		const scaledBy = built.allocation.scaled.get(i);
		if (scaledBy) push(node.id, ALLOCATION_SERIES.demandFactor.key, ALLOCATION_SERIES.demandFactor.label, 'factor', scaledBy.factor);
		// The unit's demand after the drought restriction (engine ≥ 1.54.0): on every unit the rule cuts.
		if (r.restrictedDemand) push(node.id, RESTRICTION_SERIES.restricted.key, RESTRICTION_SERIES.restricted.label, RESTRICTION_SERIES.restricted.unit, r.restrictedDemand);
		// Under the 'own' basis (engine ≥ 1.54.0) each unit's own level, beside its restricted demand.
		const ul = sim.restrictionUnitLevel?.[i];
		if (ul) push(node.id, RESTRICTION_SERIES.level.key, RESTRICTION_SERIES.unitLabel, RESTRICTION_SERIES.level.unit, ul);
		// An other water user's pump (engine ≥ 1.58.0): the demand it left unmet. Its river take is supplied − groundwater_used,
		// so it has no river_abstraction series: that key means a farm's river pump, 0 where there is none (run comparison fills it).
		if (r.pumpLimited) push(node.id, 'pump_limited', 'Demand the pump capacity left unmet (the river had it)', 'm³/day', r.pumpLimited);
		// The river pump (WP-3.8): only on a farm whose supply rule can pump from the river.
		else if (r.riverAbstraction) push(node.id, 'river_abstraction', 'Pumped from the river below the dam (part of supplied)', 'm³/day', r.riverAbstraction);
		// River off-takes (engine ≥ 1.14.0): taken from the flow leaving a source unit, delivered to a destination.
		if (r.offtakeOut) push(node.id, OFFTAKE_SERIES.out.key, OFFTAKE_SERIES.out.label, 'm³/day', r.offtakeOut);
		if (r.offtakeIn) push(node.id, OFFTAKE_SERIES.in.key, OFFTAKE_SERIES.in.label, 'm³/day', r.offtakeIn);
		// Canal seepage back to the river (engine ≥ 1.42.0): only on a farm an off-take returns seepage below.
		if (r.offtakeReturn) push(node.id, OFFTAKE_SERIES.returned.key, OFFTAKE_SERIES.returned.label, 'm³/day', r.offtakeReturn);
		// Demand objects (engine ≥ 1.7.0): each one's demand and supply, on its unit.
		const po = plan.nodes[i]!.objects;
		if (po) {
			const names = objectNames.get(node.id)!;
			po.ids.forEach((id, k) => {
				push(node.id, objectDemandKey(id), DEMAND_OBJECT_SERIES.demandLabel(names[k]!), DEMAND_OBJECT_SERIES.unit, po.demand[k]!);
				push(node.id, objectSuppliedKey(id), DEMAND_OBJECT_SERIES.suppliedLabel(names[k]!), DEMAND_OBJECT_SERIES.unit, r.objectSupplied![k]!);
			});
			// The basic-needs floor (engine ≥ 1.44.0): only on a unit with a domestic or municipal object with people.
			const floor = basicNeeds[i];
			if (floor) push(node.id, BASIC_NEEDS_SERIES.key, BASIC_NEEDS_SERIES.label, BASIC_NEEDS_SERIES.unit, floor);
		}
		// River abstractions (engine ≥ 1.65.0, docs/model.md §2.7j): each one's take and, with a pool, its storage and evaporation.
		const riv = plan.nodes[i]!.river;
		if (riv && r.riverTakes) {
			riv.takes.forEach((x, a) => {
				push(node.id, riverTakeKey(x.key), RIVER_TAKE_SERIES.take.label(x.name), RIVER_TAKE_SERIES.take.unit, r.riverTakes!.got[a]!);
				if (x.pool) {
					push(node.id, riverPoolKey(x.key), RIVER_TAKE_SERIES.pool.label(x.name), RIVER_TAKE_SERIES.pool.unit, r.riverTakes!.pool[a]!);
					push(node.id, riverPoolEvaporationKey(x.key), RIVER_TAKE_SERIES.poolEvaporation.label(x.name), RIVER_TAKE_SERIES.poolEvaporation.unit, r.riverTakes!.poolEvaporation[a]!);
				}
				// Its pump's limit (engine ≥ 1.66.0): only with a pump capacity.
				const pl = r.riverTakes!.pumpLimited[a];
				if (pl) push(node.id, riverPumpLimitedKey(x.key), RIVER_TAKE_SERIES.pumpLimited.label(x.name), RIVER_TAKE_SERIES.pumpLimited.unit, pl);
			});
		}
		// The storage reset (engine ≥ 0.46.0): only on a dam it sets.
		if (r.storageSet) push(node.id, 'dam_storage_set', 'Dam storage set at the start of the day (+ added / − taken; the review triggers)', 'm³', r.storageSet);
		if (node.kind === 'user') {
			push(node.id, 'return_flow', 'Returned below the user (treated wastewater)', 'm³/day', r.userReturn);
			push(node.id, 'ewr_charge', 'EWR charge: share of the shortfall at the EWR sites below (negative)', 'm³/day', attribution.charge[i]!);
			return;
		}
		const w = sim.workings?.[i];
		if (!w) return;
		// The intermediate columns (engine ≥ 0.12.0), so any day can be redone by hand (verify/columns.ts).
		for (const [field, key, label, unit] of WORKING_SERIES) push(node.id, key, withObjects ? (OBJECT_LABELS[key] ?? label) : label, unit, w[field]);
		// Dam releases and seepage lost from the catchment (WP-3.5): only on a dam that has them.
		if (plan.nodes[i]!.release) push(node.id, 'dam_release', 'Released below the dam (before irrigation; joins the outflow)', 'm³/day', w.damRelease);
		if (plan.nodes[i]!.seepageReturn !== undefined) push(node.id, 'dam_seepage_lost', 'Dam seepage lost from the catchment (the rest joins the outflow)', 'm³/day', w.damSeepageLost);
		if (hasSenior) push(node.id, 'passed_for_senior', 'Kept out of the dam so the senior users’ demand passes', 'm³/day', w.passedForSenior);
		if (w.offtakeUsed) {
			push(node.id, OFFTAKE_SERIES.used.key, OFFTAKE_SERIES.used.label, 'm³/day', w.offtakeUsed);
			push(node.id, OFFTAKE_SERIES.toDam.key, OFFTAKE_SERIES.toDam.label, 'm³/day', w.offtakeToDam!);
		}
		push(node.id, 'ewr_charge', 'EWR charge: share of the shortfall at the EWR sites below (negative)', 'm³/day', attribution.charge[i]!);
		push(node.id, 'ewr_charge_irrigation', 'EWR charge met by irrigating less (negative)', 'm³/day', attribution.chargeIrrigation[i]!);
		// Which site set the charge each day (engine ≥ 1.5.0), so a stored run's
		// projection reads it instead of recomputing the attribution
		// (views/farmProjection.ts). Only where it can't be told from the charge
		// alone: a farm upstream of two or more sites (./network/bindingSeries.ts).
		const binding = bindingSeries(attribution, i, days);
		if (binding) push(node.id, EWR_BINDING_SERIES.key, EWR_BINDING_SERIES.label, EWR_BINDING_SERIES.unit, binding);
	});

	// --- summary -----------------------------------------------------------------
	const mean = (a: ArrayLike<number>) => {
		let s = 0;
		for (let t = 0; t < a.length; t++) s += a[t]!;
		return a.length ? s / a.length : 0;
	};
	/** A node with boreholes: its mean pumping and stream depletion (WP-1.34). */
	const groundwaterMeans = (p: NetworkPlan['nodes'][number], r: NodeResult) =>
		p.borehole
			? {
					avgGroundwaterM3Day: mean(r.groundwater),
					avgBaseflowDepletionM3Day: mean(r.depletion),
					...(p.borehole.units.some((u) => u.toDam) ? { avgGroundwaterToDamM3Day: mean(r.groundwaterToDam) } : {})
				}
			: {};
	const farms: FarmSummary[] = [];
	nodes.forEach((node, i) => {
		if (node.kind !== 'farm') return;
		const r = sim.nodes[i]!;
		const avgDemand = mean(r.demand);
		const avgSupplied = mean(r.supplied);
		const avgCrop = mean(r.cropRequirement);
		const charge = attribution.charge[i]!;
		let notMet = 0;
		for (let t = 0; t < days; t++) if (charge[t]! < 0) notMet++;
		farms.push({
			nodeId: node.id,
			name: node.name,
			avgDemandM3Day: avgDemand,
			avgSuppliedM3Day: avgSupplied,
			avgDeficitM3Day: avgDemand - avgSupplied,
			fractionSupplied: avgDemand > 0 ? avgSupplied / avgDemand : 1,
			avgCropRequirementM3Day: avgCrop,
			flowShare: plan.nodes[i]!.share,
			// Positive volume: the farm's average EWR charge (audit Q17; [Shortfalls] col R, sign flipped).
			avgEwrShortfallM3Day: 0 - mean(charge),
			daysEwrNotMet: notMet,
			...groundwaterMeans(plan.nodes[i]!, r),
			...(r.riverAbstraction ? { avgRiverAbstractionM3Day: mean(r.riverAbstraction) } : {}),
			...(plan.nodes[i]!.objects ? { demandObjects: objectSummaries(plan.nodes[i]!.objects!, r.objectSupplied!, input.model.demandObjects ?? [], mean) } : {}),
			// Its river abstractions (engine ≥ 1.65.0, docs/model.md §2.7j).
			...(plan.nodes[i]!.river && r.riverTakes
				? {
						riverTakes: plan.nodes[i]!.river!.takes.map((x, a) => ({
							key: x.key,
							name: x.name,
							avgTakeM3Day: mean(r.riverTakes!.got[a]!),
							pumpM3Day: Number.isFinite(x.pumpM3Day) ? x.pumpM3Day : null,
							...(r.riverTakes!.pumpLimited[a] ? takePumpMeans(r.riverTakes!.got[a]!, r.riverTakes!.pumpLimited[a]!, mean) : {}),
							...(x.pool ? { poolM3: x.pool.capM3, avgPoolStorageM3: mean(r.riverTakes!.pool[a]!) } : {})
						}))
					}
				: {}),
			// Its dam's storage figures (engine ≥ 1.2.0, issue #55): for the Summary's Dams today without the daily series.
			...(damFigures(r.storage, node.damCapacityM3, node.damMinPct, startDate, plan.nodes[i]!.capacityScale ? (t) => node.damCapacityM3 * plan.nodes[i]!.capacityScale![t]! : undefined) ?? {})
		});
	});

	boreholeWarnings(nodes, plan, sim, observedKindPresent(series), warnings);
	// Groundwater per node and water year (WP-3.9), for the caps, the GA context and the licensing comparisons.
	const gwAnnual = groundwaterAnnualUse(nodes, plan, sim, start);
	// Registered volumes against the run's use (engine ≥ 1.18.0).
	const allocations = runAllocations(input.model.allocations, built.allocation, settings, nodes, plan, sim, startDate);

	// Other water users (WP-1.33): whole-run means, like FarmSummary.
	const users: UserSummary[] = [];
	nodes.forEach((node, i) => {
		if (node.kind !== 'user') return;
		const r = sim.nodes[i]!;
		const avgDemand = mean(r.demand);
		const avgSupplied = mean(r.supplied);
		const charge = attribution.charge[i]!;
		let notMet = 0;
		for (let t = 0; t < days; t++) if (charge[t]! < 0) notMet++;
		users.push({
			nodeId: node.id,
			name: node.name,
			priority: plan.nodes[i]!.senior ? 'senior' : 'junior',
			avgDemandM3Day: avgDemand,
			avgSuppliedM3Day: avgSupplied,
			avgDeficitM3Day: avgDemand - avgSupplied,
			fractionSupplied: avgDemand > 0 ? avgSupplied / avgDemand : 1,
			avgReturnedM3Day: mean(r.userReturn),
			avgEwrChargeM3Day: 0 - mean(charge),
			daysEwrNotMet: notMet,
			...groundwaterMeans(plan.nodes[i]!, r),
			...(r.pumpLimited ? pumpMeans(r.riverAbstraction!, r.pumpLimited, mean) : {})
		});
	});

	const window = resolveReportWindow(settings, start, days, warnings);
	const forecastRain = forecastRainDays(input, aligned, start, days, window, warnings);
	missingRainWarning(input, settings.rainSource, aligned, start, days, window, warnings);
	const posOf = (node: number) => posInOrder[node]!;
	const curtailment = computeCurtailment(
		nodes.flatMap((node, i) => {
			if (node.kind !== 'farm') return [];
			const r = sim.nodes[i]!;
			const bind = bindingSite(attribution, i, window.from, window.to, posOf);
			return [
				{
					nodeId: node.id,
					name: node.name,
					demand: r.demand,
					supplied: r.supplied,
					ewrCharge: attribution.charge[i]!,
					ewrChargeIrrigation: attribution.chargeIrrigation[i]!,
					consumptivePerSupplied: 1 - plan.nodes[i]!.lossReturnFraction * (1 - plan.nodes[i]!.irrigationEfficiency),
					// A unit with demand objects (engine ≥ 1.7.0): k over the window from what it returned.
					...(plan.nodes[i]!.objects ? { returned: sim.workings![i]!.returnFlow } : {}),
					// Its basic-needs floor (engine ≥ 1.44.0): the volume left never goes below it.
					...(basicNeeds[i] ? { basicNeeds: basicNeeds[i]! } : {}),
					ewrBindingSiteId: bind < 0 ? null : nodes[attribution.sites[bind]!.node]!.id
				}
			];
		}),
		window,
		attribution.sites.map((site, si) => ({
			nodeId: nodes[site.node]!.id,
			name: nodes[site.node]!.name,
			isOutlet: si === 0 && topo.outflow >= 0,
			farmCount: site.farms.length,
			shortfall: chargeSites[si]!.shortfall,
			charged: site.charged,
			natural: site.natural,
			...(chargeSites[si]!.ruleTable ? { ewrSource: 'ruleTable' as const } : {})
		}))
	);

	if (users.length) {
		curtailment.otherUsers = otherUserCurtailment(
			nodes.flatMap((node, i) =>
				node.kind === 'user'
					? [{ nodeId: node.id, name: node.name, senior: !!plan.nodes[i]!.senior, demand: sim.nodes[i]!.demand, supplied: sim.nodes[i]!.supplied, returned: sim.nodes[i]!.userReturn, ewrCharge: attribution.charge[i]!, consumptivePerSupplied: consumptivePerSupplied(plan.nodes[i]!) }]
					: []
			),
			window
		);
	}

	// Gauge and logger records measure the impacted river (farms, dams,
	// abstraction), so they are compared with the simulated outflow: the
	// outlet's, or the calibration site's (engine ≥ 1.41.0).
	const calibration = calKind
		? {
				...calibrationStats(calSim, calObserved, {
					startDate,
					windowStart: settings.calibrationStart,
					windowEnd: settings.calibrationEnd,
					exclusions: exclusionRanges(settings.calibrationExclusions)
				}),
				flowKind: calKind,
				simulatedKey: 'simulated_outflow' as const,
				...(calSite ? { siteNodeId: calSite.nodeId, siteName: nodes[calSite.node]!.name } : {}),
				fitStatus: calibrationFitStatus(settings, calKind, calSite?.nodeId ?? null)
			}
		: null;
	if (!calKind) warnings.push('no observed flow series: calibration statistics not computed');
	else if (calibration && calibration.days === 0) {
		warnings.push(
			calibration.excludedDays
				? 'every observed day inside the calibration window falls in a calibration exclusion'
				: settings.calibrationStart || settings.calibrationEnd
					? 'observed flow has no values inside the calibration window'
					: 'observed flow has no values inside the simulation period'
		);
	}

	// The outlet EWR test on the observed record (issue #4): a gauge or logger
	// measures the same impacted outflow, so on each observed day compare the
	// model's "below the EWR" with the river's. Every observed day in the run
	// counts, not just the calibration window: the parameters were fitted to
	// flows, and days outside the window are the out-of-sample evidence.
	// The calibration exclusions apply: a period whose record isn't trusted
	// isn't evidence here either.
	const ewrObserved =
		observedKind
			? ewrAgreement(simOutflow, observedM3s, ewr, { startDate, exclusions: exclusionRanges(settings.calibrationExclusions) })
			: null;
	// The same test at each gauge EWR site with a record of its own (engine ≥ 1.41.0, docs/model.md §2.10k):
	// its record against its simulated outflow and its own pragmatic requirement.
	const ewrAgreementSites: EwrAgreementSite[] = [];
	for (const node of [...siteNodes].sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))) {
		if (node === topo.outflow) continue;
		const id = nodes[node]!.id;
		const kinds = calibrationRecordsAt(series, id);
		if (!kinds.length) continue;
		const kind = settings.calibrationFlowKind && kinds.includes(settings.calibrationFlowKind) ? settings.calibrationFlowKind : kinds[0]!;
		const obs = alignFlow(series[calibrationSeriesKey(kind, id)], start, days);
		const r = sim.nodes[node]!;
		ewrAgreementSites.push({
			nodeId: id,
			name: nodes[node]!.name,
			flowKind: kind,
			agreement: ewrAgreement(r.outflow, obs, r.ewrCumulative, { startDate, exclusions: exclusionRanges(settings.calibrationExclusions) })
		});
	}

	// Input data quality: do the two observed flow records agree? Are there
	// impossible or suspicious values? Do the farm areas add up?
	const agreement = observedAgreement(series, agreementOptions(settings.dataQuality));
	const agreementNote = agreementWarning(agreement);
	if (agreementNote) warnings.push(agreementNote);
	const checks = seriesChecks(series, settings.dataQuality);
	// The double-mass check (engine ≥ 0.18.0) follows the catchment rain's own checks.
	const dmCheck = doubleMassCheck(doubleMass, chirpsCorrection?.fitPeriod?.period);
	if (dmCheck) {
		let at = 0;
		checks.forEach((c, i) => {
			if (c.seriesKind === 'rain_catchment_mm') at = i + 1;
		});
		checks.splice(at, 0, dmCheck);
	}
	for (const c of checks) warnings.push(c.text);
	const areas = areaMismatches(nodes, settings.flowShareMethod);
	const areaNote = areaMismatchWarning(areas);
	if (areaNote) warnings.push(areaNote);

	const outflowNode = topo.outflow >= 0 ? nodes[topo.outflow]! : null;
	const compliance = ewrCompliance(
		startDate,
		days,
		{ nodeId: null, name: outflowNode?.name ?? 'Outlet', shortfallM3Day: ewrShort },
		nodes.flatMap((node, i) =>
			node.kind === 'farm'
				? [{ nodeId: node.id, name: node.name, shortfallM3Day: attribution.charge[i]! }]
				: []
		)
	);

	// Hydrologist plausibility checks (engine ≥ 0.25.0, ./plausibility): report and warn only.
	const checked = plausibility?.({
		input,
		settings,
		start,
		days,
		natural,
		simOutflow,
		observedKind,
		aligned,
		accumulation,
		finalRain: catchmentRain,
		plan,
		sim,
		coverTotal,
		ewrShort,
		reserve: ewrAssurance.map((a) => a.report),
		outflow: topo.outflow,
		upstream: topo.upstream,
		flowFill,
		outletFlowFlags,
		// The scored record (engine ≥ 1.55.0): the validation signatures follow the calibration site.
		scored:
			calKind && scoredFlowFlags
				? { kind: calKind, observedM3s: calObserved, simulatedM3Day: calSim, flags: scoredFlowFlags, site: calSite ? { nodeId: calSite.nodeId, name: nodes[calSite.node]!.name } : null }
				: null
	});
	if (checked) warnings.push(...checked.warnings);

	// Assurance of supply, stress classes and the water account (engine ≥ 0.32.0, WP-3.4): new outputs only.
	const byId = nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	const assurance = assuranceOf?.({
		startDate,
		days,
		window,
		annualThreshold: settings.assuranceAnnualThreshold ?? DEFAULT_ANNUAL_THRESHOLD,
		demandNodes: [...nodes.flatMap((n, i) => (n.kind === 'farm' ? [i] : [])), ...nodes.flatMap((n, i) => (n.kind === 'user' ? [i] : []))].map((i) => ({
			nodeId: nodes[i]!.id,
			name: nodes[i]!.name,
			kind: nodes[i]!.kind as 'farm' | 'user',
			demand: sim.nodes[i]!.demand,
			supplied: sim.nodes[i]!.supplied
		})),
		accountNodes: byId.map((i) => {
			const r = sim.nodes[i]!;
			const w = sim.workings?.[i];
			const kind = plan.nodes[i]!.kind;
			return {
				kind,
				runoff: r.runoff,
				landCover: r.landCoverReduction,
				transfer: r.transfer,
				supplied: r.supplied,
				returned: kind === 'user' ? r.userReturn : (w?.returnFlow ?? new Float64Array(days)),
				rainOnDam: w?.rainOnDam,
				evaporation: w?.damEvaporation,
				seepage: w?.damSeepage,
				seepageLost: w?.damSeepageLost,
				release: w?.damRelease,
				groundwater: r.groundwater,
				groundwaterToDam: r.groundwaterToDam,
				depletion: r.depletion,
				storage: r.storage,
				...poolAccount(plan.nodes[i]!, r, days),
				...(r.storageSet ? { storageSet: r.storageSet } : {}),
				...(r.offtakeOut ? { offtakeOut: r.offtakeOut } : {}),
				...(r.offtakeIn ? { offtakeIn: r.offtakeIn } : {}),
				...(r.offtakeReturn ? { offtakeReturn: r.offtakeReturn } : {}),
				initialStorageM3: kind === 'farm' ? plan.nodes[i]!.initialStorageM3 : 0
			};
		}),
		natural,
		outflow: simOutflow,
		rainMm: catchmentRain,
		areaKm2: resolveCatchmentAreaKm2(settings.calibration, input),
		sites: attribution.sites.map((site, si) => {
			const outlet = si === 0 && topo.outflow >= 0;
			const c = chargeSites[si]!;
			return {
				nodeId: outlet ? null : nodes[site.node]!.id,
				name: nodes[site.node]!.name,
				required: c.required,
				shortfall: c.shortfall,
				...(c.ruleTable ? { ewrSource: 'ruleTable' as const } : {})
			};
		})
	});

	// The filled records whose fill read readings (the record's or its donor's) before the snapshot's day: a resumed
	// input without that history leaves their fill out (prepare.ts flowFillsFor), never fills them differently.
	const fillHistory: GapFillKind[] =
		capturing && flowFill
			? GAP_FILL_KINDS.filter((k) => {
					if (!flowFill[k]) return false;
					const donor = settings.flowGapFill[k]?.donor;
					const day = start + captureAt!;
					return hasReadingBefore(series[k], day) || (!!donor && hasReadingBefore(series[donor], day));
				})
			: [];
	if (capturing && warm.sink) {
		const net = sim.captured!;
		warm.sink.state = {
			runoff: { model: settings.runoffModel, state: nf.state! },
			nodes: nodes.map((n, i) => ({
				id: n.id,
				storageM3: net.storageM3[i]!,
				soilStoreM3: built.soilStoreAtM3?.[i] ?? 0,
				depletionStoreM3: net.depletionStoreM3[i]!,
				...(net.depletionDeficitM3[i]! > 0 ? { depletionDeficitM3: net.depletionDeficitM3[i]! } : {}),
				onRiver: net.onRiver[i] === 1,
				...(plan.nodes[i]!.river?.takes.some((x) => x.pool) ? { poolStorageM3: net.poolStorageM3[i]! } : {}),
				boreholeUsedM3: net.boreholeUsedM3[i] ?? null,
				...(net.allocationUsedM3[i] ? { allocationUsedM3: net.allocationUsedM3[i]! } : {}),
				...(allocationFactorAt(built.allocation, i, captureAt!, days, start) ?? {})
			})),
			pinned: {
				lowFlowThresholdM3Day: hasCover ? plan.lowFlowThresholdM3Day! : null,
				reserveNatural: ewrAssurance.filter((a) => a.report.naturalSource === 'run').map((a) => ({ site: a.site, curves: a.report.byMonth.map((m) => (m.naturalCurve ? [...m.naturalCurve] : null)) })),
				// A snapshot mid-month carries that month's CHIRPS before the day for the gap map (engine ≥ 1.53.0).
				fits: { ...prepared.fits!, chirpsCorrection: withChirpsGapMapLead(prepared.fits!.chirpsCorrection, series.rain_chirps_mm, warm.captureDay!) }
			},
			reserveMonths: ewrAssurance.map((a) => ({ site: a.site, carry: a.carry ?? null, ...(a.history ? { history: a.history } : {}) })),
			columns: [],
			...(plan.restriction ? { restrictionLevels: net.restrictionLevels, ...(net.restrictionEwrFailed ? { restrictionEwrFailed: true } : {}) } : {}),
			...(flowRecordHistory ? { flowRecordHistory: true as const } : {}),
			...(fillHistory.length ? { flowFillHistory: fillHistory } : {})
		};
	}

	return {
		engineVersion: ENGINE_VERSION,
		startDate,
		endDate: fromEpochDay(end),
		days,
		series: out,
		summary: {
			...(historyDays < days ? { historyDays } : {}),
			farms,
			...(users.length ? { users } : {}),
			...(hasCover ? { landCover: landCoverSummary(input, natural, coverTotal, plan, sim, days, historyDays) } : {}),
			...(gwAnnual.length ? { groundwaterAnnualUse: gwAnnual } : {}),
			...(restrictionRule && sim.restrictionLevel ? { droughtRestriction: restrictionSummary(restrictionRule, plan, sim, nodes, start, days, !!resume) } : {}),
			...(allocations ? { allocations } : {}),
			catchment: {
				meanNaturalFlowM3Day: mean(natural),
				meanSimulatedOutflowM3Day: mean(simOutflow),
				runoffCoefficient,
				ewrDaysNotMet,
				ewrFractionDaysNotMet: days ? ewrDaysNotMet / days : 0,
				ewrAgreement: ewrObserved,
				...(ewrAgreementSites.length ? { ewrAgreementSites } : {}),
				...(topo.outflow >= 0 ? { noFlow: noFlowDays(simOutflow, days) } : {})
			},
			...(nf.balance ? { runoff: nf.balance } : {}),
			calibration,
			curtailment,
			ewrCompliance: compliance,
			...(ewrAssurance.length ? { ewrAssurance: ewrAssurance.map((a) => a.report) } : {}),
			...(servedWhileFails.length ? { servedWhileEwrFails: servedWhileFails } : {}),
			...(wr2012 ? { wr2012 } : {}),
			dataQuality: { observedAgreement: agreement, seriesChecks: checks, areaMismatches: areas, doubleMass },
			...(checked ? { plausibility: checked.checks } : {}),
			chirpsCorrection: summaryCorrection(chirpsCorrection),
			...(forecastRain !== undefined ? { forecastRain } : {}),
			zeroRainInfill: zeroRain?.infill ?? null,
			...(flowFill ? { flowGapFill: Object.values(flowFill).map((f) => f.summary) } : {}),
			rainSource: rainSource?.info ?? null,
			rainAccumulation: accumulation?.info ?? null,
			...(apanDaily ? { apanDaily } : {}),
			...(assurance ? { supplyAssurance: assurance } : {}),
			warnings
		}
	};
}


/**
 * The plausibility checks' inputs from a finished run (./plausibility): the
 * observed records at the outlet, the calibration exclusions as a day mask,
 * the dams' daily storage gain + evaporation − rain on them and the station
 * rain days. Sums over nodes run in node-id order, so the result doesn't
 * depend on how the network is listed.
 */
function runPlausibility(r: {
	input: ModelInput;
	settings: ProjectSettings;
	start: number;
	days: number;
	natural: Float64Array;
	simOutflow: Float64Array;
	observedKind: CalibrationFlowKind | null;
	aligned: (kind: SeriesKind) => (number | null)[];
	accumulation: AccumulationRun | null;
	finalRain: (number | null)[] | null;
	plan: NetworkPlan;
	sim: ReturnType<typeof simulateNetwork>;
	coverTotal: Float64Array;
	ewrShort: Float64Array;
	reserve: EwrAssuranceSite[];
	/** The outlet node (topology), −1 without one. */
	outflow: number;
	/** The nodes draining directly into each node (topology). */
	upstream: readonly ArrayLike<number>[];
	/** The gap-filled observed records (PreparedRun.flowFill, engine ≥ 1.23.0): their days are flagged infilled. */
	flowFill?: PreparedRun['flowFill'];
	/** The outlet record's flags when the run already computed them (the quality column at the outlet), else null. */
	outletFlowFlags?: Uint8Array | null;
	/**
	 * The record the run's calibration statistics score (engine ≥ 1.55.0): the calibration site's or the
	 * outlet's, the simulated outflow there (m³/day) and its per-day classes (recordFlowFlags, the
	 * `observed_flow_quality` column's); null without an observed record.
	 */
	scored?: {
		kind: CalibrationFlowKind;
		observedM3s: (number | null)[];
		simulatedM3Day: ArrayLike<number>;
		flags: Uint8Array;
		site: { nodeId: string; name: string } | null;
	} | null;
}) {
	const { input, settings, start, days, plan, sim } = r;
	const series = input.series ?? {};
	const observed: Partial<Record<CalibrationFlowKind, (number | null)[]>> = {};
	for (const kind of CALIBRATION_FLOW_KINDS) if (series[kind]) observed[kind] = r.aligned(kind);
	const excluded = new Uint8Array(days);
	for (const x of exclusionRanges(settings.calibrationExclusions)) {
		for (let t = Math.max(0, toEpochDay(x.start) - start); t <= Math.min(days - 1, toEpochDay(x.end) - start); t++) excluded[t] = 1;
	}
	const nodes = input.model.nodes;
	const byId = nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	/** Σ over the farms in `among` (every node when null) of their dams' storage gain + evaporation − rain on them, per day. */
	const damsOf = (among: Uint8Array | null) => {
		const dams = new Float64Array(days);
		for (const i of byId) {
			const w = sim.workings?.[i];
			if (!w || plan.nodes[i]!.kind !== 'farm' || (among && !among[i])) continue;
			const q = sim.nodes[i]!.storage;
			const set = sim.nodes[i]!.storageSet;
			let prev = plan.nodes[i]!.initialStorageM3;
			for (let t = 0; t < days; t++) {
				// The storage reset's step (engine ≥ 0.46.0) is no water the dams took from the river.
				if (set) prev += set[t]!;
				dams[t] = dams[t]! + (q[t]! - prev) + w.damEvaporation[t]! - w.rainOnDam[t]! + w.damSeepageLost[t]!;
				prev = q[t]!;
			}
		}
		return dams;
	};
	const dams = damsOf(null);
	const gauges = gaugeSites(r, byId, damsOf);
	// The calibration record's quality flags (CR-18): the recession segments leave flagged days out.
	const kind = r.observedKind;
	const flowFlagged = kind
		? flaggedDayMask(r.outletFlowFlags ?? recordFlowFlags({ kind, series: series[kind], start, days, settings, siteNodeId: null, flowFill: r.flowFill }))
		: null;
	// The scored record's flagged days (engine ≥ 1.55.0), for the validation signatures' recession segments: the
	// classes the run stores as `observed_flow_quality` (at a calibration site without a gauged range or gap fill).
	const sc = r.scored;
	const scoredFlagged = sc ? flaggedDayMask(sc.flags) : null;
	const catchment = r.aligned('rain_catchment_mm');
	const station = new Uint8Array(days);
	for (let t = 0; t < days; t++) station[t] = catchment[t] != null && !r.accumulation?.mask[t] ? 1 : 0;
	return plausibilityChecks({
		start,
		days,
		runoffModel: settings.runoffModel,
		naturalM3Day: r.natural,
		simulatedM3Day: r.simOutflow,
		observed,
		calibrationKind: r.observedKind,
		excluded,
		...(flowFlagged ? { flowFlagged } : {}),
		damsM3Day: dams,
		landCoverM3Day: r.coverTotal,
		rainMm: r.finalRain,
		station,
		hasStation: !!series.rain_catchment_mm,
		ewrShortfall: r.ewrShort,
		reserve: r.reserve,
		areaKm2: resolveCatchmentAreaKm2(settings.calibration, input),
		...(gauges.sites.length ? { gauges: gauges.sites } : {}),
		...(gauges.warnings.length ? { gaugeRecordWarnings: gauges.warnings } : {}),
		scored: sc
			? {
					flowKind: sc.kind,
					site: sc.site,
					observedM3s: sc.observedM3s,
					simulatedM3Day: sc.simulatedM3Day,
					segmentMask: scoredFlagged ? Uint8Array.from(excluded, (v, t) => (v || scoredFlagged[t] ? 1 : 0)) : excluded
				}
			: null
	});
}

/**
 * The run's calibration site (engine ≥ 1.41.0, settings.calibrationSiteNodeId,
 * docs/model.md §2.10k): null for the outlet, else the gauge's node index and
 * id. A site the run can't use (gone from the model, not a gauge, the outlet
 * node, or no record attached) warns, naming why, and the run's statistics
 * are the outlet's; calibration refuses the same site outright.
 */
function runCalibrationSite(input: ModelInput, siteNodeId: string | null, outflow: number, warnings: string[]): { node: number; nodeId: string } | null {
	if (siteNodeId === null) return null;
	const nodes = input.model.nodes;
	const err = calibrationSiteError(nodes, outflow, siteNodeId);
	const fallback = 'the run’s calibration statistics use the outlet’s record, and Fit automatically refuses the site';
	if (err) {
		warnings.push(`Calibration site: ${err}. Until it is changed, ${fallback}.`);
		return null;
	}
	const node = nodes.findIndex((n) => n.id === siteNodeId);
	if (!calibrationRecordsAt(input.series, siteNodeId).length) {
		warnings.push(
			`Calibration site: the gauge "${nodes[node]!.name}" has no observed flow record attached: attach one on the Data page, or pick another site in Settings → Calibration record. Until then, ${fallback}.`
		);
		return null;
	}
	return { node, nodeId: siteNodeId };
}

/**
 * The gauge nodes inside the network with an observed record of their own
 * (a GaugeSeriesKey series, engine ≥ 1.4.0), with the flows the checks need
 * at each: natural flow (the catchment's × the flow shares of the gauge and
 * every node above it), the simulated flow there (the gauge's outflow), and
 * the dams and land cover above it. In node-id order. A record whose node is
 * gone, isn't a gauge or is the outlet is left out with a warning.
 */
function gaugeSites(
	r: Parameters<typeof runPlausibility>[0],
	byId: readonly number[],
	damsOf: (among: Uint8Array | null) => Float64Array
): { sites: GaugePlausibilityInput[]; warnings: string[] } {
	const { input, start, days, plan, sim } = r;
	const nodes = input.model.nodes;
	const series = input.series ?? {};
	const records = new Map<string, Partial<Record<CalibrationFlowKind, DailySeries>>>();
	for (const [key, s] of Object.entries(series)) {
		const g = s ? parseGaugeSeriesKey(key) : null;
		if (!g) continue;
		(records.get(g.nodeId) ?? records.set(g.nodeId, {}).get(g.nodeId)!)[g.kind] = s!;
	}
	const warnings: string[] = [];
	const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
	for (const [id, recs] of [...records].sort(([a], [b]) => cmpStr(a, b))) {
		const i = indexOf.get(id);
		const what = Object.keys(recs).map((k) => OBSERVED_SERIES_LABEL[k as CalibrationFlowKind].toLowerCase()).join(' and ');
		if (i === undefined) warnings.push(`An ${what} record is attached to a node that is no longer in the model: the plausibility checks leave it out. Attach it to a gauge, or to the outlet, on the Data page.`);
		else if (nodes[i]!.kind !== 'gauge') warnings.push(`An ${what} record is attached to "${nodes[i]!.name}", which is not a gauge: the plausibility checks leave it out. Attach it to a gauge, or to the outlet, on the Data page.`);
		else if (i === r.outflow) warnings.push(`An ${what} record is attached to the outlet node "${nodes[i]!.name}": the plausibility checks leave it out. The outlet's records are the ones with no site; move it there on the Data page.`);
	}
	const sites: GaugePlausibilityInput[] = [];
	const hasCover = r.coverTotal.length > 0;
	for (const g of byId) {
		const recs = records.get(nodes[g]!.id);
		if (!recs || nodes[g]!.kind !== 'gauge' || g === r.outflow) continue;
		// The gauge and every node above it.
		const above = new Uint8Array(nodes.length);
		const stack = [g];
		while (stack.length) {
			const j = stack.pop()!;
			if (above[j]) continue;
			above[j] = 1;
			const ups = r.upstream[j]!;
			for (let k = 0; k < ups.length; k++) stack.push(ups[k]!);
		}
		let naturalShare = 0;
		for (const j of byId) if (above[j]) naturalShare += plan.nodes[j]!.share;
		const cover = new Float64Array(hasCover ? days : 0);
		if (hasCover) for (const j of byId) if (above[j]) for (let t = 0; t < days; t++) cover[t]! += sim.nodes[j]!.landCoverReduction[t]!;
		const observed: Partial<Record<CalibrationFlowKind, (number | null)[]>> = {};
		for (const kind of CALIBRATION_FLOW_KINDS) if (recs[kind]) observed[kind] = alignFlow(recs[kind], start, days);
		sites.push({
			nodeId: nodes[g]!.id,
			name: nodes[g]!.name,
			naturalShare,
			observed,
			naturalM3Day: Float64Array.from(r.natural, (v) => v * naturalShare),
			simulatedM3Day: sim.nodes[g]!.outflow,
			damsM3Day: damsOf(above),
			landCoverM3Day: cover
		});
	}
	return { sites, warnings };
}

/**
 * Everything the network simulation needs besides natural flow: topology,
 * flow shares, EWR, irrigation demand and transfers, as a NetworkPlan with
 * `natural` as its natural flow. Calibration builds it once and swaps the
 * natural flow for each candidate (./calibrate).
 */
export function buildNetworkPlan(
	input: ModelInput,
	settings: ProjectSettings,
	days: number,
	month: Uint8Array,
	aligned: (k: SeriesKind) => (number | null)[],
	natural: Float64Array,
	warnings: string[],
	/** The run's first epoch day; needed only when settings.demandFactorFrom is set. */
	start?: number,
	/**
	 * Capture / resume (engine ≥ 1.1.0, ./warmstart): report each node's
	 * soil-water store (m³) at the start of run day `captureAt` as
	 * soilStoreAtM3, or start each farm's store from `soilStoreM3` (node order).
	 */
	warm: { captureAt?: number; soilStoreM3?: readonly number[]; allocationFactor?: readonly (number | undefined)[] } = {},
	/** The run's historical days, before a forecast tail (./forecastTail.ts); a full allocation's factors read only these. */
	historyDays: number = days
): { plan: NetworkPlan; topo: ReturnType<typeof buildTopology>; allocation: AllocationPlan; soilStoreAtM3?: Float64Array } {
	if (settings.demandFactorFrom != null && start === undefined) throw new Error('buildNetworkPlan: settings.demandFactorFrom needs the run start');
	if (settings.damStorageReset != null && start === undefined) throw new Error('buildNetworkPlan: settings.damStorageReset needs the run start');
	// Demand factors apply from this run day on (engine ≥ 0.44.0, the seasonal outlook); 0 = every day.
	const factorFrom = start === undefined ? 0 : demandFactorStart(settings.demandFactorFrom, start, days);
	// A model saved by an older engine (returnFlowPct, …) runs as migration 006 would store it.
	const model = upgradeLegacyModel(input.model);
	const nodes = model.nodes;
	const topo = buildTopology(nodes);
	warnings.push(...topo.warnings);
	const shares = flowShares(nodes, settings.flowShareMethod, settings.hiLoSplit);
	const overAllocated = overAllocationError(shares.sum);
	if (overAllocated) throw new Error(overAllocated);
	warnings.push(...shares.warnings);

	const ewrWy = settings.ewrPragmaticM3PerDay;
	const ewr = new Float64Array(days);
	for (let t = 0; t < days; t++) ewr[t] = ewrWy[waterYearIndex(month[t]!)]!;

	const demand = buildDemand({ ...input, model }, settings, days, month, aligned, warnings, factorFrom, warm);
	// Development over the run (engine ≥ 1.30.0, ./network/development.ts): a unit takes nothing before
	// its abstraction date, and a dam's capacity follows its sediment rate and in-service date.
	const dated = nodes.some((n) => n.abstractionFrom != null || n.damInServiceFrom != null || (n.damSedimentPctPerYear ?? 0) > 0);
	if (dated && start === undefined) throw new Error('buildNetworkPlan: a dated dam or abstraction needs the run start');
	const abstractFrom = nodes.map((n) => (start === undefined ? 0 : abstractionStartDay(n, start, days, warnings)));
	demand.forEach((d, i) => d.net.fill(0, 0, abstractFrom[i]!));

	const indexById = new Map(nodes.map((n, i) => [n.id, i]));
	const transfers: PlanTransfer[] = [];
	// In id order: rules of one priority add into the same destination and draw on the same source.
	for (const tr of [...model.transfers].sort((a, b) => cmpStr(a.id, b.id))) {
		// River off-takes (engine ≥ 1.14.0) are planned below.
		if (!tr.enabled || isRiverOfftake(tr)) continue;
		const from = indexById.get(tr.fromNodeId);
		const to = indexById.get(tr.toNodeId);
		if (from === undefined || to === undefined) {
			warnings.push(`transfer ${tr.id} references a node that does not exist; skipped`);
			continue;
		}
		if (nodes[from]!.kind !== 'farm' || nodes[to]!.kind !== 'farm') {
			warnings.push(`transfer ${nodes[from]!.name} → ${nodes[to]!.name}: transfers must be between units; skipped`);
			continue;
		}
		if (tr.monthlyRateM3s != null && !validMonthlyRates(tr.monthlyRateM3s))
			warnings.push(`transfer ${nodes[from]!.name} → ${nodes[to]!.name}: its monthly rates aren't twelve numbers ≥ 0 (m³/s, Oct–Sep); its max rate in its months is used`);
		// b023 "Transfer capacity max" = max rate m³/s × 86400 (the workbook rounds it), or the month's own
		// rate (engine ≥ 1.14.0, ./network/transferRates.ts); an explicit daily cap can only lower it.
		transfers.push({
			...(canMove(tr) ? { seriesKey: transferRuleKey(tr.id) } : {}),
			from,
			to,
			activeMonth: transferActiveMonths(tr),
			// The source keeps the rule's minimum or its dam's minimum operating level, whichever is higher (audit Q5).
			reserveM3: nodes[from]!.damCapacityM3 * Math.max(tr.minStoragePct, nodes[from]!.damMinPct),
			maxDailyM3: transferDailyLimit(tr),
			// Lower moves first; a rule without one (an older model) runs in list order, as before (Q18).
			priority: Number.isFinite(tr.priority) ? tr.priority : 0
		});
	}

	// Dam evaporation and rain on the dams (audit N2): open-water evaporation
	// depth = lake factor × A-pan for the month ÷ days in the month; rain on the
	// surface is the day's rain before any threshold (missing = 0).
	const monthDays = daysPerMonth(settings.februaryDays);
	const lakeEvapMmDay = new Float64Array(days);
	// Monthly lake factors (WP-3.5), when set, replace the one factor month by month.
	const lakeK = settings.lakeEvapFactorMonthly;
	// A day the daily A-pan series covers (engine ≥ 0.38.0, issue #45) takes that day's A-pan instead of the month's mean.
	const apanDay = apanDailyMm(aligned('evap_apan_mm'));
	// Whether any day of the run has an A-pan above 0 (the daily series' day, else the month's mean).
	let anyApan = false;
	for (let t = 0; t < days; t++) {
		const m = waterYearIndex(month[t]!);
		const a = apanDay ? apanDay[t]! : NaN;
		lakeEvapMmDay[t] = a === a ? (lakeK ? lakeK[m]! : settings.lakeEvapFactor) * a : ((lakeK ? lakeK[m]! : settings.lakeEvapFactor) * settings.apanMm[m]!) / monthDays[m]!;
		if ((a === a ? a : settings.apanMm[m]!) > 0) anyApan = true;
	}
	// No A-pan on any day (a new project's default row; an ET0 grid fills GR4J's PE only, docs/maps.md): open water
	// loses nothing, which the crop warning below doesn't cover (engine ≥ 1.67.0, persona-hydrologist round 4).
	if (!anyApan && days > 0) {
		const pooled = (model.demandObjects ?? []).some((o) => o.enabled !== false && o.waterSource === 'river' && typeof o.riverPoolM3 === 'number' && o.riverPoolM3 > 0);
		const open = nodes.filter((n) => n.kind === 'farm' && (n.damCapacityM3 > 0 || (n.cropWaterSource === 'river' && typeof n.cropRiverPoolM3 === 'number' && n.cropRiverPoolM3 > 0)));
		if (open.length || pooled)
			warnings.push('A-pan evaporation is 0 on every day, so the dams and river pools lose nothing to evaporation. Set the monthly A-pan (Settings) or load a daily A-pan series; an ET₀ row from the map feeds the runoff model only');
	}
	const rain = runRain(aligned, hasRainInput(input.series, settings.rainSource), days);
	const damRainMm = rain ? Float64Array.from(rain, (v) => (v !== null && v > 0 ? v : 0)) : undefined;
	// A dam with a survey curve (WP-3.5) takes its area from it; one the run can't use says why and runs on the power law.
	for (const n of nodes) {
		if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) continue;
		const bad = damCurveProblem(n.damCurve);
		if (bad) warnings.push(`unit "${n.name}": dam survey curve not used (${bad}); using the power-law area`);
		const top = resolveDamCurve(n)?.volume.at(-1);
		if (top !== undefined && Math.abs(top - n.damCapacityM3) > DAM_CURVE_CAPACITY_TOLERANCE * n.damCapacityM3)
			warnings.push(
				`unit "${n.name}": the dam survey curve tops out at ${Math.round(top)} m³ but the capacity is ${Math.round(n.damCapacityM3)} m³ (more than 1 % apart); ` +
					`above the top row the area stays at its last value. Check the capacity against the survey`
			);
	}
	const estimated = nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0 && (n.damAreaFullM2 === null || n.damAreaFullM2 === undefined) && !resolveDamCurve(n));
	if (estimated.length) {
		warnings.push(
			`${estimated.length} dam${estimated.length === 1 ? ' has' : 's have'} no full-supply area, so dam evaporation uses an estimate: ` +
				`${ESTIMATED_DAM_AREA_LABEL} m², a regional relation that can be far out for any one dam. Enter the area for (${estimated.map((n) => n.name).join('; ')})`
		);
	}

	// Registered volumes (engine ≥ 1.18.0, ./allocations/mode.ts): matched here, a water user's demand
	// scaled to its volume before its claim is passed down, and the rest of the mode put into the plan below.
	const allocationMode = resolveAllocationMode(settings.allocationMode, []);
	const allocation = matchAllocations(model.allocations, allocationMode, nodes, warnings);
	if (historyDays < days) allocation.historyDays = historyDays;
	// A full allocation is scaled to the volume over the days the unit abstracts on.
	if (abstractFrom.some((s) => s > 0)) allocation.abstractFrom = new Map(abstractFrom.flatMap((s, i) => (s > 0 ? [[i, s] as [number, number]] : [])));
	// A resumed full allocation keeps the capture run's factor for the water year in progress (engine ≥ 1.18.0).
	if (warm.allocationFactor?.some((f) => f !== undefined)) allocation.pinned = new Map(warm.allocationFactor.flatMap((f, i) => (f === undefined ? [] : [[i, f] as [number, number]])));
	if (allocationMode !== 'none' && allocation.byNode.size && start === undefined) throw new Error('buildNetworkPlan: settings.allocationMode needs the run start');
	const users = otherUsers(nodes, topo, shares.share, days, month, warnings, factorFrom, (i, d) => {
		d.fill(0, 0, abstractFrom[i]!);
		scaleDemandToAllocation(allocation, i, d, start!, days, nodes[i]!.name, warnings);
	});
	const reset = start === undefined ? null : storageResetOf(settings.damStorageReset, nodes, start, days, warnings);
	// The drought restriction rule (engine ≥ 1.54.0, ./network/restriction.ts): its review and lift days need the run start.
	const restrictionRule = resolveDroughtRestriction(settings.droughtRestriction, warnings);
	if (restrictionRule && start === undefined) throw new Error('buildNetworkPlan: settings.droughtRestriction needs the run start');
	const restriction = restrictionRule
		? planRestriction(restrictionRule, nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, damCapacityM3: n.kind === 'farm' ? n.damCapacityM3 : 0, ewrSite: n.ewrSite })), start!, days, warnings, topo.outflow)
		: null;
	const cover = resolveLandCover(model, warnings);
	const bores = boreholesByNode(model, warnings);
	// Demand objects (engine ≥ 1.7.0, docs/model.md §2.7f), on units only.
	const objectsBy = demandObjectsByNode(model, warnings);
	const wyOfDay = objectsBy.size ? waterYearMonths(month, days) : null;
	const objectsOf = (n: NetworkNode): PlanObjects | undefined => {
		const list = objectsBy.get(n.id);
		// The node's demand factor scales them as it scales the crop requirement (buildDemand warns about a bad one),
		// × their category's own (engine ≥ 1.45.0, demand.scale with a part), through planObjects' basic-needs floor.
		const po = list && wyOfDay ? planObjects(list, days, wyOfDay, (o) => unitPartFactor(n, o.category, []), factorFrom, warnings, start) : undefined;
		// None before the unit's abstraction date.
		const s = abstractFrom[indexById.get(n.id)!]!;
		if (po && s > 0) {
			for (const d of po.demand) d.fill(0, 0, s);
			po.total.fill(0, 0, s);
		}
		return po;
	};

	// River off-takes (engine ≥ 1.14.0, ./network/offtake.ts): each destination after its source.
	const offtakes = planOfftakes(model.transfers, nodes, warnings, (tr) => (canMove(tr) ? transferRuleKey(tr.id) : undefined));

	const plan: NetworkPlan = {
		days,
		...(historyDays < days ? { historyDays } : {}),
		order: offtakeOrder(topo.order, topo.upstream, offtakes),
		...(offtakes.length ? { offtakes } : {}),
		lakeEvapMmDay,
		...(damRainMm ? { damRainMm } : {}),
		// Sum each node's upstream in node-id order, not display order, so the
		// float result can't depend on how the nodes are listed (review F8).
		upstream: topo.upstream.map((ups) => Int32Array.from(ups).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))),
		transfers,
		month,
		naturalFlow: natural,
		ewr,
		...(reset ? { storageResetDay: reset.day } : {}),
		...(restriction ? { restriction } : {}),
		nodes: nodes.map((n, i) => {
			// The workbook rounds capacity and initial storage to whole m³ (a 0.4 m³ dam became 0); the engine doesn't.
			const cap = n.kind === 'user' ? 0 : n.damCapacityM3;
			const u = users.byNode.get(i);
			const scale = start === undefined ? undefined : capacityScaleOf(n, start, days, warnings);
			return {
				kind: n.kind,
				share: shares.share[i]!,
				pctUpstreamToDam: n.pctUpstreamToDam,
				pctRunoffToDam: n.pctRunoffToDam,
				divertCapacityM3Day: n.divertCapacityM3Day,
				damCapacityM3: cap,
				initialStorageM3: n.damInitialPct * cap * (scale && days ? scale[0]! : 1),
				...(scale ? { capacityScale: scale } : {}),
				deadStorageM3: n.kind === 'farm' ? n.damMinPct * cap : 0,
				...irrigation(n, warnings, demand[i]!.efficiency),
				...damLosses(n, warnings),
				...damStorage(n, warnings),
				demand: u?.demand ?? demand[i]!.net,
				grossDemand: demand[i]!.gross,
				rainOffset: demand[i]!.rainOffset,
				soilWater: demand[i]!.soilWater,
				...(u ? { userReturn: u.returnPct, senior: u.senior, seniorClaimed: u.claimed, ...(u.pump !== undefined ? { userPumpM3Day: u.pump } : {}) } : {}),
				...boreholeOf(n, bores.get(n.id) ?? [], warnings),
				...supplyOf(n, warnings, start === undefined ? undefined : { start, end: start + days - 1 }),
				...operatingOf(n, warnings),
				...(objectsBy.has(n.id) ? { objects: objectsOf(n)! } : {}),
				...riverSourcesOf(n, objectsBy.get(n.id), warnings),
				...(cover[i] ? { landCover: { mar: cover[i]!.mar, lowFlow: cover[i]!.lowFlow } } : {}),
				...(users.claims[i] ? { seniorClaim: users.claims[i] } : {}),
				...(reset?.byNode.has(i) ? { storageResetM3: reset.byNode.get(i)! } : {})
			};
		})
	};
	planAllocations(allocation, nodes, plan.nodes, start ?? 0, days, warnings);
	if (warm.captureAt === undefined) return { plan, topo, allocation };
	return { plan, topo, allocation, soilStoreAtM3: Float64Array.from(demand, (d) => d.storeAtM3 ?? 0) };
}

/**
 * RunSummary.droughtRestriction (engine ≥ 1.54.0, docs/model.md §2.7i): the
 * days at each level per water year and over the run, the days the level was
 * decided, and per unit (node-id order) its mean demand before and after the
 * cut and its mean supply.
 */
function restrictionSummary(rule: DroughtRestrictionRule, plan: NetworkPlan, sim: ReturnType<typeof simulateNetwork>, nodes: readonly NetworkNode[], start: number, days: number, resumed: boolean): DroughtRestrictionSummary {
	const lv = sim.restrictionLevel!;
	const n = rule.levels.length + 1;
	const byYear = new Map<number, { waterYear: number; days: number; daysByLevel: number[] }>();
	const total = new Array<number>(n).fill(0);
	for (let t = 0; t < days; t++) {
		const wy = waterYearOf(start + t);
		let y = byYear.get(wy);
		if (!y) byYear.set(wy, (y = { waterYear: wy, days: 0, daysByLevel: new Array<number>(n).fill(0) }));
		y.days++;
		y.daysByLevel[lv[t]!]!++;
		total[lv[t]!]!++;
	}
	const rp = plan.restriction!;
	let reviews = 0;
	for (let t = 0; t < days; t++) if (rp.event[t] === 1 || (t === 0 && rp.event[0] === 0 && rp.initialLevels === undefined && rp.startDecides)) reviews++;
	const ewrReviews = sim.restrictionEwrFailed ? sim.restrictionEwrFailed.reduce((a, v) => a + v, 0) : undefined;
	const mean = (a: ArrayLike<number>) => {
		let s = 0;
		for (let t = 0; t < a.length; t++) s += a[t]!;
		return a.length ? s / a.length : 0;
	};
	const units = nodes
		.map((node, i) => ({ node, r: sim.nodes[i]!, ul: sim.restrictionUnitLevel?.[i] ?? lv }))
		.filter((x) => x.r.restrictedDemand)
		.sort((a, b) => cmpStr(a.node.id, b.node.id))
		.map(({ node, r, ul }) => {
			// The cut on the days a level was in force only: the run means dilute it with every unrestricted day.
			let cut = 0;
			let k = 0;
			const byLevel = new Array<number>(n).fill(0);
			for (let t = 0; t < days; t++) {
				byLevel[ul[t]!]!++;
				if (ul[t] === 0) continue;
				cut += r.demand[t]! - r.restrictedDemand![t]!;
				k++;
			}
			return {
				nodeId: node.id,
				name: node.name,
				avgDemandM3Day: mean(r.demand),
				avgRestrictedDemandM3Day: mean(r.restrictedDemand!),
				avgSuppliedM3Day: mean(r.supplied),
				avgCutOnRestrictedDaysM3Day: k ? cut / k : null,
				daysByLevel: byLevel
			};
		});
	// A resumed run (engine ≥ 1.54.0): the state its first day starts from, for the self-check.
	const startState = resumed
		? {
				start: {
					levelsBefore: rp.initialLevels ? Object.fromEntries(nodes.flatMap((node, i) => (rp.inScope[i] ? [[node.id, rp.initialLevels![i]!]] : []))) : null,
					ewrFailedBefore: rp.initialEwrFailed === true,
					damStorageBeforeM3: Object.fromEntries(nodes.flatMap((node, i) => (node.kind === 'farm' && plan.nodes[i]!.damCapacityM3 > 0 ? [[node.id, plan.nodes[i]!.initialStorageM3]] : [])))
				}
			}
		: {};
	return {
		rule,
		years: [...byYear.values()].sort((a, b) => a.waterYear - b.waterYear),
		daysByLevel: total,
		reviews,
		...(ewrReviews !== undefined ? { ewrReviews } : {}),
		units,
		...startState
	};
}

/**
 * settings.damStorageReset (engine ≥ 0.46.0, issue #53 R6, docs/model.md
 * §2.15a) resolved against the run: its day and, per farm dam listed, the
 * storage it starts that day with (clamped to 0 … capacity). A date outside
 * the run, a node that isn't a farm with a dam and a value that isn't a
 * number are left out with a warning; null when nothing is left.
 */
function storageResetOf(
	reset: ProjectSettings['damStorageReset'],
	nodes: ModelInput['model']['nodes'],
	start: number,
	days: number,
	warnings: string[]
): { day: number; byNode: Map<number, number> } | null {
	if (!reset) return null;
	const day = toEpochDay(reset.date) - start;
	if (day < 0 || day >= days) {
		warnings.push(`damStorageReset: ${reset.date} is outside the run; ignored`);
		return null;
	}
	const byNode = new Map<number, number>();
	for (const [id, v] of Object.entries(reset.storageM3)) {
		const i = nodes.findIndex((n) => n.id === id);
		const n = nodes[i];
		if (!n || n.kind !== 'farm' || !(n.damCapacityM3 > 0)) {
			warnings.push(`damStorageReset: "${id}" is not a unit with a dam; ignored`);
			continue;
		}
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			warnings.push(`damStorageReset: unit "${n.name}" storage ${String(v)} is not a number; ignored`);
			continue;
		}
		// Against the capacity on the reset day (engine ≥ 1.30.0: it can change over the run).
		const cap = damCapacityOn(n, start + day);
		if (v < 0 || v > cap) warnings.push(`damStorageReset: unit "${n.name}" storage ${v} m³ is outside 0 … its capacity ${cap} m³ that day; clamped`);
		byNode.set(i, Math.min(Math.max(v, 0), cap));
	}
	return byNode.size ? { day, byNode } : null;
}

// ---------------------------------------------------------------------------

/**
 * The land-cover summary (WP-1.35): the low-flow threshold, the mean and
 * relative reduction, and per class its condensed area, mean reduction and
 * mm per year over that area. The reduction is linear in the class weights,
 * so each class's part is its own lowFlow × MIN(I0, q) + mar × (I0 − that),
 * with I0 = the farm's runoff + its reduction (the natural runoff).
 */
function landCoverSummary(input: ModelInput, natural: Float64Array, total: Float64Array, plan: NetworkPlan, sim: ReturnType<typeof simulateNetwork>, days: number, historyDays: number): LandCoverSummary {
	const cover = resolveLandCover(upgradeLegacyModel(input.model), []);
	// The threshold the network used: pinned from a snapshot on a resumed run, else over the historical days.
	const qLow = plan.lowFlowThresholdM3Day ?? lowFlowThreshold(natural.subarray(0, historyDays));
	const byClass = new Map<LandCoverClass, { condensedKm2: number; volume: number }>();
	cover.forEach((u, i) => {
		if (!u) return;
		const r = sim.nodes[i]!;
		const q = qLow * plan.nodes[i]!.share;
		for (const [cls, w] of Object.entries(u.byClass) as [LandCoverClass, { mar: number; lowFlow: number }][]) {
			let vol = 0;
			for (let t = 0; t < days; t++) {
				const i0 = r.runoff[t]! + r.landCoverReduction[t]!;
				const low = Math.min(i0, Math.max(q, 0));
				vol += w.lowFlow * low + w.mar * (i0 - low);
			}
			const c = byClass.get(cls) ?? { condensedKm2: 0, volume: 0 };
			c.condensedKm2 += u.condensedKm2[cls] ?? 0;
			c.volume += vol;
			byClass.set(cls, c);
		}
	});
	let sumNat = 0;
	let sumRed = 0;
	for (let t = 0; t < days; t++) {
		sumNat += natural[t]!;
		sumRed += total[t]!;
	}
	return {
		lowFlowThresholdM3Day: qLow,
		reductionM3Day: days ? sumRed / days : 0,
		fractionOfNatural: sumNat > 0 ? sumRed / sumNat : null,
		// In LAND_COVER_CLASSES order, whatever order the patches and nodes are listed in.
		byClass: LAND_COVER_CLASSES.flatMap((k) => (byClass.has(k.id) ? [[k.id, byClass.get(k.id)!] as const] : [])).map(([coverClass, c]) => ({
			coverClass,
			condensedKm2: c.condensedKm2,
			reductionM3Day: days ? c.volume / days : 0,
			// m³ over km² → mm: ÷ (km² × 1000); per year: × 365.25 ÷ days.
			mmPerYear: c.condensedKm2 > 0 && days ? ((c.volume / (c.condensedKm2 * 1000)) * 365.25) / days : null
		}))
	};
}

const observedKindPresent = (series: ModelInput['series']) => !!(series.flow_observed_m3s || series.flow_logger_m3s);

/**
 * Run warnings for boreholes (WP-1.34): stream depletion still owed to the
 * river at the end of the run (it had no flow left at the node to give it,
 * engine ≥ 1.10.0), and, when the project has an
 * observed record, the double-counting caution: flows measured while these
 * boreholes pumped already carry their depletion, so a calibration that
 * leaves them out would fit natural flow too low and then take it off again.
 */
function boreholeWarnings(nodes: readonly NetworkNode[], plan: NetworkPlan, sim: ReturnType<typeof simulateNetwork>, observed: boolean, warnings: string[]) {
	let owed = 0;
	let depleting = 0;
	const names: string[] = [];
	plan.nodes.forEach((p, i) => {
		if (!p.borehole) return;
		const u = plan.days > 0 ? sim.nodes[i]!.depletionDeficit[plan.days - 1]! : 0;
		if (u > 1e-9) {
			owed += u;
			names.push(`${nodes[i]!.name} ${u.toFixed(0)} m³`);
		}
		if (p.borehole.units.some((u) => u.depletionFrac > 0)) depleting++;
	});
	if (owed > 1e-9) {
		warnings.push(
			`stream depletion of ${owed.toFixed(0)} m³ is still owed to the river at the end of the run: it fell due while the river had no flow left there, and is taken off the first flow that returns (${names.join('; ')})`
		);
	}
	// An annual cap that stopped a borehole (WP-3.9): the demand it would have met is left to the dam and river.
	const capped = [...new Set(plan.nodes.flatMap((p, i) => (p.borehole?.units.some((u) => Number.isFinite(u.annualCapM3)) ? capHits(p.borehole, sim.nodes[i]!.boreholePumped!, plan) : []).map((u) => `${nodes[i]!.name}: ${u}`)))];
	if (capped.length) warnings.push(`borehole annual cap reached in a water year, after which the borehole pumps nothing until 1 October (${capped.join('; ')})`);
	warnings.push(...ga538Warnings(nodes, plan));
	if (depleting && observed) {
		warnings.push(
			`${depleting} node${depleting === 1 ? ' has' : 's have'} boreholes that deplete the river: if the gauge or logger record was measured while they pumped, keep them in the model when calibrating, so the fitted natural flow isn't reduced twice (docs/model.md §2.7d)`
		);
	}
}

/** The units of a node whose annual cap was reached in some water year, by name. */
function capHits(b: NonNullable<NetworkPlan['nodes'][number]['borehole']>, pumped: Float64Array[], plan: NetworkPlan): string[] {
	const hit: string[] = [];
	b.units.forEach((u, k) => {
		if (!Number.isFinite(u.annualCapM3)) return;
		let used = 0;
		for (let t = 0; t < plan.days; t++) {
			if (t > 0 && plan.month[t] === 10 && plan.month[t - 1] !== 10) used = 0;
			used += pumped[k]![t]!;
			if (u.annualCapM3 > 0 && used >= u.annualCapM3 * (1 - 1e-9)) {
				hit.push(u.name);
				return;
			}
		}
	});
	return hit;
}

/** k: the share of what a node is supplied that it consumes, 1 − β(1 − e) for a farm (audit N1), 1 − r for an other user (WP-1.33). */
/** A unit's consumptive use per day, c = G − T (engine ≥ 1.7.0, for a unit with demand objects). */
function consumptiveDaily(G: Float64Array, T: Float64Array): Float64Array {
	const c = new Float64Array(G.length);
	for (let t = 0; t < G.length; t++) c[t] = G[t]! - T[t]!;
	return c;
}

/**
 * Each of a unit's demand objects over the run (engine ≥ 1.7.0): whole-run
 * means of its demand, supply and return, and the days it got less than its
 * demand beyond float noise (1e-12 of it).
 */
function objectSummaries(po: PlanObjects, got: Float64Array[], all: readonly import('./project').DemandObject[], mean: (a: ArrayLike<number>) => number): DemandObjectSummary[] {
	const byId = new Map(all.map((o) => [o.id, o]));
	return po.ids.map((id, k) => {
		const o = byId.get(id)!;
		const d = po.demand[k]!;
		const g = got[k]!;
		let short = 0;
		for (let t = 0; t < d.length; t++) if (g[t]! < d[t]! * (1 - 1e-12)) short++;
		const s = po.schedule[k];
		let off = 0;
		if (s) for (let t = 0; t < s.length; t++) if (s[t] === 0) off++;
		const avgDemand = mean(d);
		const avgSupplied = mean(g);
		// The basic-needs floor (engine ≥ 1.44.0, docs/model.md §2.7f): days and volume below it, apart from the shortfall.
		const floor = po.floor[k];
		let basic = {};
		if (floor !== null && floor !== undefined) {
			const pop = basicNeedsPopulation(o)!;
			const lack = new Float64Array(d.length);
			let below = 0;
			for (let t = 0; t < d.length; t++) {
				const b = dayFloor(floor, d[t]!);
				if (g[t]! < b * (1 - 1e-12)) {
					below++;
					lack[t] = b - g[t]!;
				}
			}
			const loss = o.sizing === 'perUnit' && Number.isFinite(o.lossPct) && o.lossPct >= 0 && o.lossPct < 1 ? o.lossPct : 0;
			basic = {
				basicNeedsPopulation: pop,
				basicNeedsM3Day: floor,
				daysBelowBasicNeeds: below,
				avgBelowBasicNeedsM3Day: mean(lack),
				avgSuppliedLitresPerPersonDay: (avgSupplied * (1 - loss) * 1000) / pop
			};
		}
		return {
			id,
			name: o.name,
			category: o.category,
			...(o.source && (DEMAND_OBJECT_SOURCES as readonly string[]).includes(o.source) ? { source: o.source } : {}),
			priority: o.priority,
			// Its rank within its class as the run used it (engine ≥ 1.64.0), only when one is set on a 'first' or 'last' object.
			...(objectRank(o) > 0 && o.rank !== null && o.rank !== undefined ? { rank: objectRank(o) } : {}),
			destination: o.destination,
			avgDemandM3Day: avgDemand,
			avgSuppliedM3Day: avgSupplied,
			avgDeficitM3Day: avgDemand - avgSupplied,
			fractionSupplied: avgDemand > 0 ? avgSupplied / avgDemand : 1,
			avgReturnedM3Day: avgSupplied * po.returnShare[k]!,
			daysShort: short,
			...(s ? { daysOff: off } : {}),
			...basic
		};
	});
}

function consumptivePerSupplied(n: NetworkPlan['nodes'][number]): number {
	return n.kind === 'user' ? 1 - (n.userReturn ?? 0) : 1 - n.lossReturnFraction * (1 - n.irrigationEfficiency);
}

/**
 * Other water users (WP-1.33, docs/model.md §2.7c): each user node's daily
 * demand (its monthly m³/day, water-year months), return share and priority,
 * and the senior users' demand fragmented to the farms upstream of each by
 * flow share (claims[farm][t] = Σ_u D_u[t] × share_farm / Σ upstream shares of
 * u), the rule the EWR is fragmented by. A senior user with no farm share
 * upstream can't be protected that way: it takes what reaches it, with a
 * warning. Map keyed by node index; claims only for farms that carry one.
 */
interface OtherUser {
	demand: Float64Array;
	returnPct: number;
	senior: boolean;
	claimed: boolean;
	/** Its river pump capacity, m³/day (engine ≥ 1.58.0); absent = no limit. */
	pump?: number;
}

function otherUsers(
	nodes: readonly NetworkNode[],
	topo: ReturnType<typeof buildTopology>,
	share: Float64Array,
	days: number,
	month: Uint8Array,
	warnings: string[],
	factorFrom: number,
	/** allocationMode 'fullAllocation' (engine ≥ 1.18.0): scales user i's demand in place before its claim is passed down. */
	scale?: (i: number, demand: Float64Array) => void
): { byNode: Map<number, OtherUser>; claims: (Float64Array | undefined)[] } {
	const byNode = new Map<number, OtherUser>();
	const claims: (Float64Array | undefined)[] = nodes.map(() => undefined);
	// Users in node-id order: a farm below two senior users adds their claims in that order.
	const byId = nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	for (const i of byId) {
		const n = nodes[i]!;
		if (n.kind !== 'user') continue;
		const monthlyDemand = n.userDemandM3Day ?? null;
		const demand = new Float64Array(days);
		if (monthlyDemand) {
			if (monthlyDemand.length !== 12) warnings.push(`user "${n.name}": demand should have 12 monthly values, has ${monthlyDemand.length}; missing months are 0`);
			for (let t = 0; t < days; t++) {
				const v = Number(monthlyDemand[waterYearIndex(month[t]!)]);
				demand[t] = Number.isFinite(v) && v > 0 ? v : 0;
			}
		}
		// A demand factor (engine ≥ 0.41.0, the demand.scale scenario op) scales it month by month, from settings.demandFactorFrom (0.44.0).
		const factor = demandFactorOf(n, warnings);
		if (factor) for (let t = factorFrom; t < days; t++) demand[t]! *= factor[waterYearIndex(month[t]!)]!;
		scale?.(i, demand);
		const r = n.userReturnPct ?? 0;
		const returnPct = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
		if (returnPct !== r) warnings.push(`user "${n.name}": return share ${String(r)} is not in [0, 1]; using ${returnPct}`);
		const senior = (n.userPriority ?? 'senior') !== 'junior';
		const { userPumpM3Day: pump } = userPumpOf(n, warnings);
		let claimed = false;
		if (senior && demand.some((v) => v > 0)) {
			// Farms upstream of the user, and their flow shares.
			const up: number[] = [];
			const stack = [...topo.upstream[i]!];
			while (stack.length) {
				const j = stack.pop()!;
				if (nodes[j]!.kind === 'farm' && share[j]! > 0) up.push(j);
				stack.push(...topo.upstream[j]!);
			}
			// In node-id order, so the total (and every claim) is the same to the last bit however the nodes are listed.
			up.sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
			const total = up.reduce((s, j) => s + share[j]!, 0);
			if (total > 0) {
				claimed = true;
				for (const j of up) {
					const c = (claims[j] ??= new Float64Array(days));
					const f = share[j]! / total;
					// The farms pass what its pump can take (engine ≥ 1.58.0): MIN(D, capacity), not water it can't lift.
					if (pump === undefined) for (let t = 0; t < days; t++) c[t]! += demand[t]! * f;
					else for (let t = 0; t < days; t++) c[t]! += Math.min(demand[t]!, pump) * f;
				}
			} else {
				warnings.push(`senior user "${n.name}" has no unit with a flow share upstream: its demand can't be passed down to it, so it takes only what reaches it`);
			}
		}
		byNode.set(i, { demand, returnPct, senior, claimed, ...(pump !== undefined ? { pump } : {}) });
	}
	return { byNode, claims };
}

/**
 * A full allocation's factor for the water year in progress on run day `at`
 * (a snapshot's, engine ≥ 1.18.0): the day's, or on the day after the run the
 * last day's when that is the same water year; null without one.
 */
function allocationFactorAt(ap: AllocationPlan, i: number, at: number, days: number, start: number): { allocationFactor: number } | null {
	const f = ap.scaled.get(i)?.factor;
	if (!f || days === 0) return null;
	if (at < days) return { allocationFactor: f[at]! };
	return waterYearOf(start + days - 1) === waterYearOf(start + days) ? { allocationFactor: f[days - 1]! } : null;
}

/**
 * RunSummary.allocations (engine ≥ 1.18.0, issue #72): the mode, and per farm
 * or water user with an allocation the whole water years compared per water
 * source (compareAllocations on the run's own series, with
 * settings.allocationTolerance), the years a cap bound, and a full
 * allocation's scaling. null when the input carries no allocations.
 */
function runAllocations(
	raw: ModelInput['model']['allocations'],
	ap: AllocationPlan,
	settings: ProjectSettings,
	nodes: readonly NetworkNode[],
	plan: NetworkPlan,
	sim: ReturnType<typeof simulateNetwork>,
	startDate: string
): RunAllocations | null {
	if (!raw?.length) return null;
	const units = nodes.flatMap((n, i) => (n.kind === 'farm' || n.kind === 'user' ? [i] : []));
	const tolerance = settings.allocationTolerance ?? DEFAULT_ALLOCATION_TOLERANCE;
	const cmp = compareAllocations({
		startDate,
		tolerance,
		allocations: ap.list,
		nodes: units.map((i) => {
			const r = sim.nodes[i]!;
			const b = plan.nodes[i]!.borehole;
			return {
				nodeId: nodes[i]!.id,
				name: nodes[i]!.name,
				kind: nodes[i]!.kind as 'farm' | 'user',
				supplied: r.supplied,
				groundwater: b ? (r.groundwater) : null,
				groundwaterToDam: b?.units.some((u) => u.toDam) ? (r.groundwaterToDam) : null,
				riverAbstraction: (r.riverAbstraction ?? null),
				riverTakes: [sim.workings?.[i]?.offtakeUsed ?? null, ...(r.riverTakes?.got ?? [])]
			};
		})
	});
	const byId = new Map(cmp.nodes.map((c) => [c.nodeId, c]));
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const out: RunAllocationNode[] = [];
	for (const i of [...ap.byNode.keys()].sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))) {
		const c = byId.get(nodes[i]!.id)!;
		const sources: RunAllocationSource[] = [];
		for (const side of [c.surface, c.groundwater]) {
			if (!side.allocationIds.length) continue;
			const src: RunAllocationSource = {
				waterSource: side.waterSource,
				wholeYears: side.wholeYears,
				yearsOver: side.yearsOver,
				meanModelledM3PerYear: side.meanModelledM3PerYear,
				meanRegisteredM3PerYear: side.meanRegisteredM3PerYear
			};
			const budget = plan.nodes[i]!.allocationCap?.[side.waterSource];
			if (ap.mode === 'cap' && budget) {
				const cap = plan.nodes[i]!.allocationCap!;
				const limit = side.waterSource === 'surface' ? cap.surfaceLimit : cap.groundwaterLimit;
				const outside = outsideMonths(ap.byNode.get(i) ?? [], side.waterSource, toEpochDay(startDate), budget.length);
				Object.assign(src, capYears(budget, limit ?? null, outside, side.waterSource, sim.nodes[i]!, startDate, plan.nodes[i]!.initialAllocationUsedM3));
			}
			sources.push(src);
		}
		const sc = ap.scaled.get(i);
		out.push({ nodeId: nodes[i]!.id, name: nodes[i]!.name, sources, ...(sc ? { scaled: sc.years } : {}) });
	}
	const used = ap.list.filter((a) => a.nodeId != null && ap.byNode.has(index.get(a.nodeId) ?? -1)).length;
	return { mode: ap.mode, tolerance, used, notMatched: ap.list.length - used, nodes: out };
}

/**
 * A capped source's water years (RunAllocationSource): `capReached`, the
 * years its use reached its budget (within float noise), and `limitBound`
 * (engine ≥ 1.40.0), the days per year the licence limit bound, split by
 * which limit set the room (limitBoundKind). A run resumed inside a water
 * year (`before`, the snapshot's use so far that year) counts the year's use
 * before the snapshot too, as the cap did.
 */
function capYears(
	budget: Float64Array,
	limit: Float64Array | null,
	outside: Uint8Array | null,
	source: 'surface' | 'groundwater',
	r: NodeResult,
	startDate: string,
	before?: readonly [number, number]
): { capReached: { waterYear: number; budgetM3: number; usedM3: number }[]; limitBound: AllocationLimitBound[] } {
	const capReached: { waterYear: number; budgetM3: number; usedM3: number }[] = [];
	const limitBound: AllocationLimitBound[] = [];
	const start = toEpochDay(startDate);
	let wy = NaN;
	let used = 0;
	let lastT = 0;
	let bound: AllocationLimitBound | null = null;
	const close = () => {
		const b = budget[lastT]!;
		if (wy === wy && b >= 0 && used >= b * (1 - 1e-9)) capReached.push({ waterYear: wy, budgetM3: b, usedM3: used });
		if (bound?.days) limitBound.push(bound);
	};
	for (let t = 0; t < budget.length; t++) {
		const y = waterYearOf(start + t);
		if (y !== wy) {
			close();
			// A run that starts on 1 October starts the year afresh (simulateNetwork clears the use then too).
			used = t === 0 && before && startDate.slice(5) !== '10-01' ? before[source === 'surface' ? 0 : 1] : 0;
			wy = y;
			bound = { waterYear: y, days: 0, volumeDays: 0, rateDays: 0, monthsDays: 0 };
		}
		const use = source === 'surface' ? r.supplied[t]! - r.groundwater[t]! : r.groundwater[t]! + r.groundwaterToDam[t]!;
		const kind = limitBoundKind(Math.max(0, budget[t]! - used), limit ? limit[t]! : Infinity, outside?.[t] === 1, use, r.demand[t]!, r.deficit[t]!, budget[t]!);
		if (kind) {
			bound!.days++;
			bound![kind]++;
		}
		used += use;
		lastT = t;
	}
	close();
	return { capReached, limitBound };
}

/**
 * A dam's evaporation and seepage parameters (audit N2): the full-supply area
 * as entered, or estimatedDamAreaM2 when it isn't known (warning W6, in
 * buildNetworkPlan); the area exponent (0 < b ≤ 3, else 0.7 with a warning;
 * above DAM_AREA_EXPONENT_MAX it runs, with a warning, engine ≥ 1.63.0);
 * seepage per day clamped to 0–1. A node without a dam gets none.
 */
function damLosses(n: NetworkNode, warnings: string[]): { damAreaFullM2: number; damAreaExponent: number; damSeepagePerDay: number } {
	const cap = n.damCapacityM3;
	if (n.kind !== 'farm' || !(cap > 0)) return { damAreaFullM2: 0, damAreaExponent: DAM_AREA_EXPONENT, damSeepagePerDay: 0 };
	let area = n.damAreaFullM2 ?? estimatedDamAreaM2(cap);
	if (!(Number.isFinite(area) && area >= 0)) {
		warnings.push(`unit "${n.name}": dam area ${String(n.damAreaFullM2)} m² is not a size ≥ 0; using ${ESTIMATED_DAM_AREA_LABEL}`);
		area = estimatedDamAreaM2(cap);
	}
	let b = n.damAreaExponent;
	if (!(b > 0 && b <= 3)) {
		warnings.push(`unit "${n.name}": dam area exponent ${String(b)} is not in (0, 3]; using ${DAM_AREA_EXPONENT}`);
		b = DAM_AREA_EXPONENT;
	} else if (b > DAM_AREA_EXPONENT_MAX && !resolveDamCurve(n)) {
		// Engine ≥ 1.63.0 (issue #90): a save no longer takes b > 1, which no basin has; an older document's runs as entered.
		warnings.push(
			`unit "${n.name}": dam area exponent ${String(b)} is above ${DAM_AREA_EXPONENT_MAX}, which no real basin has (the surface would grow faster than the volume); ` +
				`it runs as entered, with the b > 1 limiter, but a save now needs 0 < b ≤ ${DAM_AREA_EXPONENT_MAX}. Use ${DAM_AREA_EXPONENT}, or enter the dam's survey curve`
		);
	}
	const s = n.damSeepagePerDay;
	const seep = Number.isFinite(s) ? Math.min(Math.max(s, 0), 1) : 0;
	if (seep !== s) warnings.push(`unit "${n.name}": dam seepage ${String(s)} per day is not in [0, 1]; using ${seep}`);
	return { damAreaFullM2: area, damAreaExponent: b, damSeepagePerDay: seep };
}

/**
 * A dam's survey curve, release rule and seepage destination (WP-3.5,
 * ./network/dam.ts). Only the fields that are on: a node with the defaults
 * gets none, and runs exactly as before.
 */
function damStorage(n: NetworkNode, warnings: string[]): { damCurve?: DamCurve; release?: PlanRelease; seepageReturn?: number } {
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return {};
	const curve = resolveDamCurve(n);
	const release = resolveRelease(n, warnings);
	const ret = seepageReturnOf(n);
	if (n.damSeepageReturnPct !== undefined && ret !== n.damSeepageReturnPct) warnings.push(`unit "${n.name}": seepage return ${String(n.damSeepageReturnPct)} is not in [0, 1]; using ${ret}`);
	return { ...(curve ? { damCurve: curve } : {}), ...(release ? { release } : {}), ...(ret < 1 ? { seepageReturn: ret } : {}) };
}

/**
 * A farm's irrigation efficiency and loss return (audit N1). Validation keeps
 * 0 < e ≤ 1 and 0 ≤ β ≤ 1; a value outside that (a hand-edited document)
 * runs as e = 1 and β clamped, with a warning, rather than dividing by 0.
 * `fromCrops` combines the farm's value with its crops' own efficiencies
 * (engine ≥ 0.43.0, ./demand.ts farmIrrigationEfficiency).
 */
function irrigation(n: NetworkNode, warnings: string[], fromCrops: (farmEfficiency: number) => number): { irrigationEfficiency: number; lossReturnFraction: number } {
	if (n.kind !== 'farm') return { irrigationEfficiency: 1, lossReturnFraction: 0 };
	let e = n.irrigationEfficiency;
	if (!(e > 0 && e <= 1)) {
		warnings.push(`unit "${n.name}": irrigation efficiency ${String(e)} is not in (0, 1]; using 1`);
		e = 1;
	}
	e = fromCrops(e);
	const b = n.lossReturnFraction;
	const beta = Number.isFinite(b) ? Math.min(Math.max(b, 0), 1) : 0;
	if (beta !== b) warnings.push(`unit "${n.name}": loss return fraction ${String(b)} is not in [0, 1]; using ${beta}`);
	return { irrigationEfficiency: e, lossReturnFraction: beta };
}

/**
 * Natural-flow volume / rain volume over the run (null without rain). A value
 * above 1 means the catchment gives back more water than fell on it, which no
 * catchment can do over a whole record: warn (audit H1, W1). The days without
 * any rainfall value are missingRainWarning's (W2).
 */
function catchmentRunoffCoefficient(
	input: ModelInput,
	settings: ProjectSettings,
	natural: Float64Array,
	aligned: (k: SeriesKind) => (number | null)[],
	warnings: string[],
	balance: NaturalFlowInput['balance'],
	/** The areal rainfall factors (engine ≥ 1.13.0, §2.4g), water-year months; null = none. */
	areal: readonly number[] | null,
	month: ArrayLike<number>
): number | null {
	const kinds: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
	if (!hasRainInput(input.series, settings.rainSource)) return null;
	const [c, ch, f] = kinds.map(aligned) as [(number | null)[], (number | null)[], (number | null)[]];
	let rainMm = 0;
	for (let t = 0; t < natural.length; t++) {
		const v = c[t] ?? ch[t] ?? f[t] ?? null;
		if (v !== null && v > 0) rainMm += areal ? v * areal[waterYearIndex(month[t]!)]! : v;
	}
	const area = resolveCatchmentAreaKm2(settings.calibration, input);
	if (!(rainMm > 0) || !(area > 0)) return null;
	let flow = 0;
	for (let t = 0; t < natural.length; t++) flow += natural[t]!;
	const coefficient = flow / (rainMm * area * 1000); // 1 mm on 1 km² = 1000 m³
	if (coefficient > 1 && balance) {
		// A conceptual model conserves water, so only its stores draining (or
		// imported groundwater) can make flow exceed rain; say which.
		warnings.push(
			`natural flow is ${coefficient.toFixed(2)}× the rain volume over the run: the ${balance.model.toUpperCase()} stores held ` +
				`${balance.storageStartMm.toFixed(0)} mm after the warm-up and ${balance.storageEndMm.toFixed(0)} mm at the end` +
				(balance.exchangeMm > 0 ? `, and ${balance.exchangeMm.toFixed(0)} mm came in through groundwater exchange` : '') +
				'. A run this short is dominated by the starting state'
		);
	} else if (coefficient > 1) {
		// No runoff model ran: the caller supplied the natural flow (runModelWith).
		warnings.push(
			`the rain model makes more runoff than rainfall: natural flow is ${coefficient.toFixed(2)}× the rain volume over the run. ` +
				'Check the natural flow supplied and the catchment area'
		);
	}
	return coefficient;
}

/**
 * Assess each rule table at its EWR site (./reserve/assurance.ts): the outlet
 * (simulated outflow) or a gauge (its flow). The site's natural flow is the
 * runoff (I) of the farms upstream of it: rain-driven flow before any dam or
 * abstraction. A table whose site is missing or isn't a gauge is skipped with
 * a warning. Outlet first, then gauges by node id (the EWR sites' order).
 */
function assessEwrRules(
	settings: ProjectSettings,
	nodes: NetworkNode[],
	outflow: number,
	sites: readonly { node: number; farms: Int32Array }[],
	sim: { nodes: readonly NodeResult[] },
	simOutflow: Float64Array,
	startDate: string,
	days: number,
	/** Only complete months within the first this many days are assessed (the days before a forecast tail). */
	historyDays: number,
	warnings: string[],
	/**
	 * Capture / resume (engine ≥ 1.1.0, ./warmstart), by table site ('' = the
	 * outlet): the natural curves pinned from the capture run and the month
	 * carried into a resumed run; or the day to report each site's carry at.
	 */
	warm: { pinned?: ModelState['pinned']['reserveNatural']; carried?: ModelState['reserveMonths']; captureAt?: number } = {}
): { report: EwrAssuranceSite; requiredM3Day: Float64Array; site: string; node: number; carry?: MonthCarry | null; history?: number[] }[] {
	const out: { report: EwrAssuranceSite; requiredM3Day: Float64Array; site: string; node: number; carry?: MonthCarry | null; history?: number[] }[] = [];
	const siteOf = new Map(sites.map((s) => [s.node, s]));
	const key = (id: string | null) => id ?? '';
	// A table keyed by the outlet node's own id is the outlet's table (null): the same site, listed
	// first, and a second table beside one for "the outlet" is a duplicate, so neither is used (§2.9c).
	const outletId = outflow >= 0 ? nodes[outflow]!.id : null;
	const named = settings.ewrRules.map((t) => (outletId !== null && t.siteNodeId === outletId ? { ...t, siteNodeId: null } : t));
	const perSite = new Map<string, number>();
	for (const t of named) perSite.set(key(t.siteNodeId), (perSite.get(key(t.siteNodeId)) ?? 0) + 1);
	for (const [site, n] of perSite) {
		if (n > 1) warnings.push(`${n} EWR rule tables for ${site === '' ? 'the outlet' : `site ${site}`}: none is used, because each site has one`);
	}
	const tables = named.filter((t) => perSite.get(key(t.siteNodeId)) === 1).sort((a, b) => (key(a.siteNodeId) < key(b.siteNodeId) ? -1 : key(a.siteNodeId) > key(b.siteNodeId) ? 1 : 0));
	for (const table of tables) {
		const node = table.siteNodeId === null ? outflow : nodes.findIndex((n) => n.id === table.siteNodeId);
		if (node < 0) {
			warnings.push(
				table.siteNodeId === null
					? 'EWR rule table for the outlet skipped: the network has no outlet'
					: `EWR rule table skipped: its site (${table.siteNodeId}) is not in the network`
			);
			continue;
		}
		const isOutlet = node === outflow;
		if (!isOutlet && nodes[node]!.kind !== 'gauge') {
			warnings.push(`EWR rule table for "${nodes[node]!.name}" skipped: an EWR site is the outlet or a gauge`);
			continue;
		}
		// Engine ≥ 1.5.0: a gauge taken off the EWR sites only measures.
		if (!isOutlet && !siteOf.has(node)) {
			warnings.push(`EWR rule table for "${nodes[node]!.name}" skipped: the gauge is not marked as an EWR site`);
			continue;
		}
		const natural = new Float64Array(days);
		// Summed in node-id order, not display order, so a month's natural volume (and the
		// percentile and requirement it selects) is bit-identical however the network is listed:
		// on a flat stretch of the table's natural curve a one-ulp difference moved the
		// percentile from one % point to the next (fuzz seed 18472, engine 0.24.1).
		const upstreamFarms = [...(siteOf.get(node)?.farms ?? [])].sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
		for (const f of upstreamFarms) {
			const r = sim.nodes[f]!.runoff;
			for (let t = 0; t < days; t++) natural[t] = natural[t]! + r[t]!;
		}
		const impacted = isOutlet ? simOutflow : sim.nodes[node]!.outflow;
		const name = nodes[node]!.name;
		for (const note of ewrRuleTableNotes(table)) warnings.push(`EWR rule table at ${isOutlet ? `the outlet (${name})` : name}: ${note}`);
		const site = key(table.siteNodeId);
		const carried = warm.carried?.find((p) => p.site === site);
		const a = assessSite(
			startDate,
			days,
			{ table, nodeId: isOutlet ? null : nodes[node]!.id, name, isOutlet, natural, impacted },
			warm.pinned?.find((p) => p.site === site)?.curves,
			carried?.carry ?? null,
			settings.lowFlowMeasure ?? 'total',
			carried?.history,
			historyDays
		);
		warnings.push(...assuranceWarnings(a.report));
		out.push({
			report: a.report,
			requiredM3Day: a.requiredM3Day,
			site,
			node,
			...(warm.captureAt !== undefined ? { carry: monthCarryAt(startDate, warm.captureAt, natural, impacted) } : {}),
			// Low flows on base flow (engine ≥ 1.6.0): the days a resumed run's base-flow windows reach back into.
			...(warm.captureAt !== undefined && a.report.lowFlowMeasure === 'baseflow' ? { history: baseflowHistoryAt(startDate, warm.captureAt, impacted, carried?.history) } : {})
		});
	}
	return out;
}

/** The label of an EWR site's `ewr_charge_shortfall` series (engine ≥ 1.3.0, settings.ewrChargeSource 'ruleTable'). */
export const EWR_CHARGE_SHORTFALL_LABEL = 'EWR shortfall the charge follows: the Reserve rule table’s requirement (negative)';

/**
 * What the EWR charge follows at each site (engine ≥ 1.3.0, issue #64,
 * docs/model.md §2.9c): the required flow and the shortfall, ≤ 0, per day.
 * With settings.ewrChargeSource 'ruleTable', a site with a rule-table
 * assessment takes the month's requirement from the table (`ewr_rule`) on
 * every day of a complete month, and MIN(flow − requirement, 0) as its
 * shortfall; days outside a complete month (a part month at either end of
 * the run), and sites without a table, keep the pragmatic EWR. Otherwise
 * every site keeps the pragmatic EWR, the same arrays as before.
 */
function ewrChargeSites(
	settings: ProjectSettings,
	siteNodes: readonly number[],
	outflow: number,
	assessed: readonly { node: number; requiredM3Day: Float64Array }[],
	sim: { nodes: readonly NodeResult[] },
	simOutflow: Float64Array,
	ewr: ArrayLike<number>,
	ewrShort: Float64Array,
	days: number,
	nodes: readonly NetworkNode[],
	warnings: string[]
): { node: number; required: ArrayLike<number>; shortfall: ArrayLike<number>; ruleTable: boolean }[] {
	const byRule = settings.ewrChargeSource === 'ruleTable';
	const rules = new Map(byRule ? assessed.map((a) => [a.node, a.requiredM3Day]) : []);
	if (byRule && rules.size === 0) warnings.push('the EWR charge is set to follow the Reserve rule tables, but no EWR site has one: it follows the pragmatic EWR');
	return siteNodes.map((node) => {
		const isOutlet = node === outflow;
		const required = isOutlet ? ewr : sim.nodes[node]!.ewrCumulative;
		const short = isOutlet ? ewrShort : sim.nodes[node]!.ewrShortfall;
		const rule = rules.get(node);
		if (!rule) return { node, required, shortfall: short, ruleTable: false };
		const flow = isOutlet ? simOutflow : sim.nodes[node]!.outflow;
		const req = new Float64Array(days);
		const sh = new Float64Array(days);
		let pragmaticDays = 0;
		for (let t = 0; t < days; t++) {
			const r = rule[t]!;
			if (Number.isFinite(r)) {
				req[t] = r;
				const d = shortfall(flow[t]!, r, Math.max(flow[t]!, r));
				sh[t] = d < 0 ? d : 0;
			} else {
				req[t] = required[t]!;
				sh[t] = short[t]!;
				pragmaticDays++;
			}
		}
		if (pragmaticDays) {
			const name = nodes[node]!.name;
			warnings.push(
				`EWR charge at ${isOutlet ? `the outlet (${name})` : name}: ${pragmaticDays} day${pragmaticDays === 1 ? '' : 's'} outside a complete calendar month follow${pragmaticDays === 1 ? 's' : ''} the pragmatic EWR, since the rule table's requirement is monthly`
			);
		}
		return { node, required: req, shortfall: sh, ruleTable: true };
	});
}

/**
 * The days that ran on forecast rain (rain used = forecast because catchment
 * rain and CHIRPS are blank), and a warning naming them: a forecast series
 * extends the run, and the reporting window with it, past the last recorded
 * rain, which the results otherwise don't show. undefined without a forecast
 * series.
 */
function forecastRainDays(
	input: ModelInput,
	aligned: (k: SeriesKind) => (number | null)[],
	start: number,
	days: number,
	window: { from: number; to: number; reportStart: string; reportEnd: string },
	warnings: string[]
): ForecastRainDays | null | undefined {
	if (!input.series?.rain_forecast_mm) return undefined;
	const c = aligned('rain_catchment_mm');
	const ch = aligned('rain_chirps_mm');
	const f = aligned('rain_forecast_mm');
	let count = 0;
	let first = -1;
	let last = -1;
	let inReport = 0;
	let lastRecorded = -1;
	for (let t = 0; t < days; t++) {
		const recorded = (c[t] ?? null) !== null || (ch[t] ?? null) !== null;
		if (recorded) lastRecorded = t;
		else if ((f[t] ?? null) !== null) {
			count++;
			if (first < 0) first = t;
			last = t;
			if (t >= window.from && t <= window.to) inReport++;
		}
	}
	if (!count) return null;
	const from = fromEpochDay(start + first);
	const to = fromEpochDay(start + last);
	const span = count === 1 ? `1 day (${from})` : `${count} days (${from} to ${to}${count < last - first + 1 ? ', not all consecutive' : ''})`;
	warnings.push(
		`${span} of this run use forecast rain, not recorded rain (catchment or CHIRPS)` +
			(inReport ? `; ${inReport === count ? 'all' : inReport} of them fall in the reporting window (${window.reportStart} to ${window.reportEnd}), so curtailment and the EWR sites cover forecast days` : '')
	);
	return { days: count, from, to, inReport, lastRecorded: lastRecorded >= 0 ? fromEpochDay(start + lastRecorded) : null };
}

/** How many blank-rain date ranges the W2 warning names before "and N more". */
export const MISSING_RAIN_RANGES_LISTED = 3;

/**
 * W2: the days without any rainfall value (catchment, CHIRPS or forecast),
 * which the model treats as dry (0 mm). The warning names their date ranges
 * (the first MISSING_RAIN_RANGES_LISTED, then how many more) and how many
 * fall in the reporting window, so a reader sees that "this week" ran on
 * blank days, not only that some day somewhere did (engine ≥ 1.16.0).
 * Nothing without a rain series.
 */
function missingRainWarning(
	input: ModelInput,
	periods: ProjectSettings['rainSource'],
	aligned: (k: SeriesKind) => (number | null)[],
	start: number,
	days: number,
	window: { from: number; to: number; reportStart: string; reportEnd: string },
	warnings: string[]
): void {
	const kinds: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
	if (!hasRainInput(input.series, periods)) return;
	const [c, ch, f] = kinds.map(aligned) as [(number | null)[], (number | null)[], (number | null)[]];
	const ranges: [number, number][] = [];
	let missing = 0;
	let inReport = 0;
	for (let t = 0; t < days; t++) {
		if ((c[t] ?? ch[t] ?? f[t] ?? null) !== null) continue;
		missing++;
		if (t >= window.from && t <= window.to) inReport++;
		const last = ranges.at(-1);
		if (last && last[1] === t - 1) last[1] = t;
		else ranges.push([t, t]);
	}
	if (!missing) return;
	const day = (t: number) => fromEpochDay(start + t);
	const named = ranges.slice(0, MISSING_RAIN_RANGES_LISTED).map(([a, b]) => (a === b ? day(a) : `${day(a)} to ${day(b)}`));
	const more = ranges.length - named.length;
	const whole = window.from === 0 && window.to === days - 1;
	warnings.push(
		`${missing} of ${days} days have no rainfall value (catchment, CHIRPS or forecast); the model treats them as dry (0 mm): ` +
			named.join(', ') +
			(more ? ` and ${more} more period${more === 1 ? '' : 's'}` : '') +
			(whole ? '' : `; ${inReport} of them fall in the reporting window (${window.reportStart} to ${window.reportEnd})`)
	);
}

/**
 * settings.reportStart/reportEnd as day indices into the run, clipped to it.
 * null means the run's own start/end. A window that doesn't overlap the run
 * (or ends before it starts) falls back to the whole run, with a warning.
 */
export function resolveReportWindow(
	settings: Pick<ProjectSettings, 'reportStart' | 'reportEnd'>,
	runStart: number,
	days: number,
	warnings: string[]
): ReportWindow {
	const runEnd = runStart + days - 1;
	const parse = (v: string | null | undefined, name: string): number | null => {
		if (v == null || v === '') return null;
		const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? toEpochDay(v) : NaN;
		if (!Number.isFinite(d)) {
			warnings.push(`${name} "${String(v)}" is not a date (YYYY-MM-DD); using the run's ${name === 'reportStart' ? 'start' : 'end'}`);
			return null;
		}
		return d;
	};
	let a = parse(settings.reportStart, 'reportStart') ?? runStart;
	let b = parse(settings.reportEnd, 'reportEnd') ?? runEnd;
	if (b < a || b < runStart || a > runEnd) {
		warnings.push(
			`reporting window ${fromEpochDay(a)} … ${fromEpochDay(b)} does not overlap the run (${fromEpochDay(runStart)} … ${fromEpochDay(runEnd)}); the curtailment report covers the whole run`
		);
		a = runStart;
		b = runEnd;
	} else if (a < runStart || b > runEnd) {
		warnings.push(
			`reporting window ${fromEpochDay(a)} … ${fromEpochDay(b)} is clipped to the run (${fromEpochDay(runStart)} … ${fromEpochDay(runEnd)})`
		);
		a = Math.max(a, runStart);
		b = Math.min(b, runEnd);
	}
	return { from: a - runStart, to: b - runStart, reportStart: fromEpochDay(a), reportEnd: fromEpochDay(b) };
}

/**
 * A unit's river abstractions' pools for the water account (engine ≥ 1.65.0):
 * their storage and evaporation summed per day, in `river.takes` order, and
 * their start (full, or a resumed run's). {} without a pool.
 */
function poolAccount(p: PlanNode, r: NodeResult, days: number): { pool?: { storage: Float64Array; evaporation: Float64Array; initialM3: number } } {
	const tk = p.river?.takes;
	if (!tk || !r.riverTakes || !tk.some((x) => x.pool)) return {};
	const storage = new Float64Array(days);
	const evaporation = new Float64Array(days);
	let initialM3 = 0;
	tk.forEach((x, a) => {
		if (!x.pool) return;
		initialM3 += p.initialPoolM3 ? p.initialPoolM3[a]! : x.pool.capM3;
		const q = r.riverTakes!.pool[a]!;
		const e = r.riverTakes!.poolEvaporation[a]!;
		for (let t = 0; t < days; t++) {
			storage[t]! += q[t]!;
			evaporation[t]! += e[t]!;
		}
	});
	return { pool: { storage, evaporation, initialM3 } };
}

/**
 * An other water user's pump over the run (engine ≥ 1.58.0): the mean river
 * take and the mean demand the pump left unmet, and the days it did (more
 * than float noise of the day's take).
 */
function pumpMeans(river: Float64Array, limited: Float64Array, mean: (a: ArrayLike<number>) => number): Pick<UserSummary, 'avgRiverAbstractionM3Day' | 'avgPumpLimitedM3Day' | 'daysPumpLimited'> {
	let days = 0;
	for (let t = 0; t < limited.length; t++) if (limited[t]! > 1e-9 * Math.max(1, river[t]!)) days++;
	return { avgRiverAbstractionM3Day: mean(river), avgPumpLimitedM3Day: mean(limited), daysPumpLimited: days };
}

/**
 * A river abstraction's pump over the run (engine ≥ 1.66.0, docs/model.md
 * §2.7j): the mean demand its pump left unmet although the water was there,
 * and the days it did (more than float noise of the day's take), as an other
 * water user's pumpMeans counts them.
 */
function takePumpMeans(got: Float64Array, limited: Float64Array, mean: (a: ArrayLike<number>) => number): Pick<RiverTakeSummary, 'avgPumpLimitedM3Day' | 'daysPumpLimited'> {
	const { avgPumpLimitedM3Day, daysPumpLimited } = pumpMeans(got, limited, mean);
	return { avgPumpLimitedM3Day: avgPumpLimitedM3Day!, daysPumpLimited: daysPumpLimited! };
}

/** Series labels that read differently on an other water user (WP-1.33). */
/** A unit with demand objects (engine ≥ 1.7.0): its demand, supply and return are its crops' and its objects' together. */
const OBJECT_LABELS: Record<string, string> = {
	demand: 'Demand (irrigation abstraction + demand objects)',
	supplied: 'Supplied (irrigation + demand objects)',
	deficit: 'Deficit (irrigation + demand objects)',
	return_flow: 'Return flow (irrigation losses + demand objects)'
};

const USER_LABELS: Record<string, string> = {
	demand: 'Demand from the river',
	supplied: 'Taken from the river',
	deficit: 'Demand not met'
};

/** Run warning when no calibration record is chosen and both a gauge and a logger record exist (issue #1). */
export const DEFAULT_GAUGE_PICK_WARNING =
	'calibrated against the observed gauge flow by default: the project also has a logger flow record and no calibration record is chosen. ' +
	'The two may not measure the same river; choose the record in Settings → calibration flow series.';

/**
 * The flow record calibration compares against ([Flow data] rUseFlow): the
 * configured kind when that series exists, else observed gauge flow, else the
 * logger. With no kind configured and both a gauge and a logger record, the
 * default pick of the gauge is never silent: it adds a run warning, because a
 * workbook "gauge" column can be a neighbouring river's gauge.
 */
export function pickObservedKind(
	wanted: CalibrationFlowKind | null,
	series: ModelInput['series'],
	warnings: string[]
): CalibrationFlowKind | null {
	if (wanted) {
		if (series[wanted]) return wanted;
		warnings.push(`calibration flow series "${wanted}" is missing; using the default observed series`);
	} else if (series.flow_observed_m3s && series.flow_logger_m3s) {
		warnings.push(DEFAULT_GAUGE_PICK_WARNING);
	}
	return series.flow_observed_m3s ? 'flow_observed_m3s' : series.flow_logger_m3s ? 'flow_logger_m3s' : null;
}

/**
 * CHIRPS as uploaded and, beside it, CHIRPS × its calendar month's bias factor
 * (§2.4b) on every day it has a value, not only the fallback days, so the two
 * columns can be read side by side. Rain used still only takes the corrected
 * value where the catchment rain is blank. The corrected column, and the
 * factor column beside it (the day's calendar-month factor, NaN for a month
 * without one), are left out when the setting is 'none' or no month has a
 * factor; a month without a factor keeps its raw value. Missing CHIRPS days
 * are NaN, so charts show gaps.
 */
export function chirpsColumns(
	chirps: DailySeries | undefined,
	corr: ChirpsCorrection | null,
	start: number,
	days: number,
	month: Uint8Array
): { key: string; label: string; unit: string; values: number[] }[] {
	if (!chirps) return [];
	const raw = alignSeries(chirps, start, days).map((v) => (v === null ? NaN : v));
	const out = [{ key: 'rain_chirps', label: 'CHIRPS rain as uploaded', unit: 'mm', values: raw }];
	if (corr?.mode === 'monthly' && corr.months.some((m) => m.factor !== null)) {
		// The day's own fit range's factor with a CHIRPS fit period (engine ≥ 0.29.0), else its calendar month's.
		const factor = corr.fitPeriod?.segments.length
			? Array.from({ length: days }, (_, t) => chirpsFactorOn(corr, start + t) ?? NaN)
			: Array.from(month, (m) => corr.months[m - 1]!.factor ?? NaN);
		const corrected = raw.map((v, t) => (Number.isNaN(factor[t]!) ? v : v * factor[t]!));
		out.push({ key: 'rain_chirps_corrected', label: 'CHIRPS rain bias-corrected (× monthly factor)', unit: 'mm', values: corrected });
		out.push({ key: 'chirps_factor', label: 'CHIRPS bias factor for the month', unit: '×', values: factor });
		// The gap map (engine ≥ 1.53.0, CR-23): what a gap day reads, on every day, as rain_chirps_corrected is.
		const mapper = chirpsQuantileMapper(corr, chirps);
		if (mapper) {
			const mapped = corrected.map((v, t) => mapper(start + t) ?? v);
			out.push({ key: 'rain_chirps_mapped', label: 'CHIRPS rain bias-corrected and quantile-mapped (wet days, month totals kept)', unit: 'mm', values: mapped });
		}
	}
	return out;
}

/** The correction as a run summary keeps it: without the gap map's tables and a snapshot's lead (they stay with the pinned fit, as a rain-source period's tables do). */
function summaryCorrection(c: ChirpsCorrection | null): ChirpsCorrection | null {
	if (!c?.quantileMap?.tables && !c?.quantileMap?.lead) return c;
	const { tables: _tables, lead: _lead, ...qm } = c.quantileMap;
	return { ...c, quantileMap: qm };
}

/** Daily net irrigation demand per node (zeros for gauges and crop-less farms). */
function buildDemand(
	input: ModelInput,
	settings: ProjectSettings,
	days: number,
	month: Uint8Array,
	aligned: (k: SeriesKind) => (number | null)[],
	warnings: string[],
	factorFrom: number,
	warm: { captureAt?: number; soilStoreM3?: readonly number[] } = {}
): { net: Float64Array; gross: Float64Array; rainOffset: Float64Array; soilWater: Float64Array; efficiency: (farmEfficiency: number) => number; storeAtM3?: number }[] {
	const { nodes, crops: cropDefs, cropAreas } = input.model;
	const crops: Crop[] = cropDefs.map((c) => {
		// A crop's own irrigation efficiency (engine ≥ 0.43.0, issue #54); one outside (0, 1] falls back to the farm's.
		const e = ownCropEfficiency(c.irrigationEfficiency);
		if (e === undefined && c.irrigationEfficiency != null) warnings.push(`crop "${c.name}": irrigation efficiency ${String(c.irrigationEfficiency)} is not in (0, 1]; using the unit's`);
		return {
			id: c.id,
			name: c.name,
			cropFactor: monthly(c.cropFactor, `crop factors for "${c.name}"`, warnings),
			...(e !== undefined ? { irrigationEfficiency: e } : {})
		};
	});
	const cropIds = new Set(crops.map((c) => c.id));
	// Crops and crop areas are summed in id order (crop id, then area), not
	// list order, so a farm's demand is the same to the last bit however the
	// lists are ordered: a last-bit difference can tip a dam at its drought
	// trigger or at empty (docs/model.md §6, order invariance).
	crops.sort((a, b) => cmpStr(a.id, b.id));
	const sortedAreas = [...cropAreas].sort((a, b) => cmpStr(a.nodeId, b.nodeId) || cmpStr(a.cropId, b.cropId) || a.areaM2 - b.areaM2);

	// [Flow data] R "Use rain": first present of catchment / CHIRPS / forecast,
	// zeroed at or below the rain threshold.
	const catchment = aligned('rain_catchment_mm');
	const chirps = aligned('rain_chirps_mm');
	const forecast = aligned('rain_forecast_mm');
	const thr = settings.calibration.rainThresholdMm;
	const rain = new Float64Array(days);
	for (let t = 0; t < days; t++) {
		rain[t] = aboveRainThreshold(catchment[t] ?? chirps[t] ?? forecast[t] ?? 0, thr);
	}

	const wy = new Uint8Array(days);
	for (let t = 0; t < days; t++) wy[t] = waterYearIndex(month[t]!);

	// Daily A-pan (engine ≥ 0.38.0, issue #45): on the days it covers, gross demand is that day's A-pan × the crop factors.
	const apanDay = apanDailyMm(aligned('evap_apan_mm'));

	// Effective-rain fraction: one for the year, or the month's (engine ≥ 0.43.0, issue #54).
	const erMonthly = settings.effectiveRainFractionMonthly;
	let erFraction: number | Float64Array = settings.effectiveRainFraction;
	if (erMonthly) {
		erFraction = new Float64Array(days);
		for (let t = 0; t < days; t++) erFraction[t] = erMonthly[wy[t]!]!;
	}

	const farmOnly = (e: number) => e;
	let anyArea = false;
	const out = nodes.map((node, ni) => {
		const d = { net: new Float64Array(days), gross: new Float64Array(days), rainOffset: new Float64Array(days), soilWater: new Float64Array(days), efficiency: farmOnly };
		if (node.kind !== 'farm') return d;
		const areas = new Map<string, number>();
		let cropped = 0;
		for (const ca of sortedAreas) {
			if (ca.nodeId !== node.id) continue;
			if (!cropIds.has(ca.cropId)) {
				warnings.push(`unit "${node.name}" has an area for an unknown crop; ignored`);
				continue;
			}
			areas.set(ca.cropId, (areas.get(ca.cropId) ?? 0) + ca.areaM2);
			cropped += ca.areaM2;
		}
		if (cropped === 0) return d;
		anyArea = true;
		const gross = grossFarmDemandM3PerDay(settings.apanMm, crops, areas, settings.februaryDays);
		if (apanDay) {
			const k = cropFactorAreaM2(crops, areas);
			for (let t = 0; t < days; t++) {
				const a = apanDay[t]!;
				d.gross[t] = a === a ? (k[wy[t]!]! * a) / 1000 : gross[wy[t]!]!;
			}
		} else for (let t = 0; t < days; t++) d.gross[t] = gross[wy[t]!]!;
		// Effective rain carries over through the soil-water store (N3, engine ≥ 0.14.0).
		const f = farmDailyDemand(d.gross, cropped, rain, erFraction, settings.effectiveRainStoreMm, {
			...(warm.soilStoreM3 ? { initialM3: warm.soilStoreM3[ni] ?? 0 } : {}),
			...(warm.captureAt !== undefined ? { captureAt: warm.captureAt } : {})
		});
		// A demand factor (engine ≥ 0.41.0, the demand.scale scenario op) scales the crop water
		// requirement F after the store, so the rain used, the store and the gross demand stay as they were;
		// from settings.demandFactorFrom on (engine ≥ 0.44.0, the seasonal outlook), else every day.
		// × the crops' own factor (engine ≥ 1.45.0, demand.scale with part 'crops').
		const factor = unitPartFactor(node, 'crops', warnings);
		if (factor) for (let t = factorFrom; t < days; t++) f.net[t]! *= factor[wy[t]!]!;
		// Crops under their own irrigation system (engine ≥ 0.43.0): weighted by their annual requirement at the monthly A-pan.
		const efficiency = (e: number) => farmIrrigationEfficiency(e, crops, areas, settings.apanMm);
		return { net: f.net, gross: d.gross, rainOffset: f.used, soilWater: f.storeMm, efficiency, ...(f.storeAtM3 !== undefined ? { storeAtM3: f.storeAtM3 } : {}) };
	});
	// With a daily A-pan series the run's A-pan warning (prepare.ts) says which days fall back to these zeros.
	if (anyArea && !apanDay && settings.apanMm.every((v) => v === 0)) {
		warnings.push('A-pan evaporation is 0 for every month, so irrigation demand is 0');
	}
	return out;
}
