// Model entry point: runModel(input) → daily series + summary for a project.
//
// Pipeline (b023 sheet in brackets):
//   1. natural flow from rain                     [Flow data]            → ./runoff (legacy: ./flow.ts)
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
	resolveDataQuality,
	seriesChecks
} from './quality';
import {
	ACCUMULATION_COLUMN,
	accumulationWarnings,
	applyAccumulations,
	claimsDays,
	fitExcludedWindows,
	rainAccumulations,
	spreadAccumulations,
	type AccumulationRun
} from './accumulation';
import {
	applyRainSource,
	finishRainSource,
	RAIN_SOURCE_COLUMN,
	rainSourceFactors,
	rainSourceSpans,
	rainSourcePeriodWarnings,
	resolveRainSource,
	type RainSourceInfo
} from './rainSourcePeriods';
import {
	applyChirpsCorrection,
	blankMasked,
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	chirpsFactorOn,
	finishZeroRainInfill,
	keepDryDoubtWarnings,
	resolveChirpsFitPeriod,
	resolveZeroRain,
	ZERO_RAIN_COLUMN,
	zeroRainMask,
	zeroRainWarnings,
	type ChirpsCorrection,
	type ZeroRainMask
} from './rain';
import { doubleMass as doubleMassOf, doubleMassCheck, doubleMassRunWarning, type DoubleMass } from './doublemass';
import { plausibilityChecks } from './plausibility';
import { daysPerMonth, fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, type Monthly } from './calendar';
import { farmDailyDemand, grossFarmDemandM3PerDay, type Crop } from './demand';
import { computeCurtailment, otherUserCurtailment, type ReportWindow } from './network/curtailment';
import { DEFAULT_ANNUAL_THRESHOLD, supplyAssurance } from './network/reliability';
import { attributeEwrShortfall, bindingSite } from './network/attribution';
import { boreholeOf } from './network/boreholes';
import { DAM_CURVE_CAPACITY_TOLERANCE, damCurveProblem, resolveDamCurve, resolveRelease, seepageReturnOf, type DamCurve, type PlanRelease } from './network/dam';
import { lowFlowThreshold, resolveLandCover } from './network/landcover';
import { flowShares, overAllocationError } from './network/shares';
import { shortfall, simulateNetwork, type FarmWorkings, type NetworkPlan, type NodeResult, type PlanTransfer } from './network/simulate';
import { verifyRun } from './verify/verify';
import { ewrCompliance } from './network/ewr';
import { ewrAgreement } from './network/ewrAgreement';
import { exclusionRanges, sanitizeExclusions } from './calibrate/provenance';
import { calibrationStats } from './network/stats';
import { buildTopology, canonicalOrder } from './network/topology';
import { cmpStr } from './order';
import { resolveWr2012, runRain, wr2012Report } from './reference/wr2012';
import { ewrRuleTableNotes, resolveEwrRules } from './reserve/rules';
import { assessSite, assuranceWarnings, type EwrAssuranceSite } from './reserve/assurance';
import { NATURAL_FLOW, RUNOFF_MODELS, resolveCatchmentAreaKm2, type NaturalFlowInput, type RunContext } from './runoff';
import {
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	DAM_AREA_EXPONENT,
	LAND_COVER_CLASSES,
	defaultProjectSettings,
	ESTIMATED_DAM_DEPTH_M,
	panCoefficientOutOfRange,
	resolvePe,
	PE_SOURCE_MAX,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	upgradeLegacyModel,
	type CalibrationFlowKind,
	type DailySeries,
	type ForecastRainDays,
	type FarmSummary,
	type UserSummary,
	type LandCoverClass,
	type LandCoverSummary,
	type ModelInput,
	type NetworkNode,
	type ModelOutput,
	type ProjectSettings,
	type RunSeries,
	type SeriesKind
} from './project';

export const ENGINE_VERSION = '0.36.0';

const SEC_PER_DAY = 86_400;

export type { NaturalFlowInput, RunContext } from './runoff';
export { resolveCatchmentAreaKm2 } from './runoff';

/** Run the full model: natural flow from the selected runoff model (./runoff), then the network. */
export function runModel(input: ModelInput): ModelOutput {
	return runModelWith(input, (ctx) => NATURAL_FLOW[ctx.settings.runoffModel](input, ctx));
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
	return runNetwork(input, (ctx) => NATURAL_FLOW[ctx.settings.runoffModel](input, ctx), null, null);
}

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
	assuranceOf: typeof supplyAssurance | null
): ModelOutput {
	const { warnings, settings, series, start, end, days, startDate, aligned, month, chirpsCorrection, zeroRain, accumulation, doubleMass, rainSource } = prepareRun(input);

	// --- natural flow ---------------------------------------------------------
	const nf = naturalFlow({ settings, startDate, days, aligned });
	if (nf.naturalFlowM3Day.length !== days) {
		throw new Error(`natural flow has ${nf.naturalFlowM3Day.length} days, expected ${days}`);
	}
	const natural = Float64Array.from(nf.naturalFlowM3Day, (v) => (Number.isFinite(v) ? v : 0));
	warnings.push(...(nf.warnings ?? []));
	if (settings.runoffModel === 'legacy') warnings.push(LEGACY_NOT_EVIDENCE_WARNING);
	const runoffCoefficient = catchmentRunoffCoefficient(input, settings, natural, aligned, warnings, nf.balance);
	// The day's rainfall after gap-filling: catchment, else corrected CHIRPS, else forecast.
	const finalRain = runRain(aligned, !!(series.rain_catchment_mm || series.rain_chirps_mm || series.rain_forecast_mm), days);
	// WR2012 flows are naturalised: compare them with natural flow, never the outflow.
	const wr2012 = wr2012Report(
		{
			settings: settings.wr2012,
			startDate,
			natural,
			areaKm2: resolveCatchmentAreaKm2(settings.calibration, input),
			rainMm: finalRain
		},
		warnings
	);

	// --- network ----------------------------------------------------------------
	const { plan, topo } = buildNetworkPlan(input, settings, days, month, aligned, natural, warnings);
	const nodes = input.model.nodes;
	const ewr = plan.ewr;
	const sim = simulateNetwork(plan, { workings: true });

	// --- outputs -----------------------------------------------------------------
	const out: RunSeries[] = [];
	const push = (nodeId: string | null, key: string, label: string, unit: string, values: ArrayLike<number>) =>
		out.push({ nodeId, key, label, unit, values: Array.from(values) });

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
			OBSERVED_LABEL[observedKind],
			'm³/day',
			// m³/s × 86400 (the workbook rounds [Flow data] P); missing days are NaN so charts show gaps.
			observedM3s.map((v) => (v === null ? NaN : v * SEC_PER_DAY))
		);
	}
	push(null, 'ewr', 'Pragmatic EWR', 'm³/day', ewr);
	push(null, 'ewr_shortfall', 'EWR not met (negative = shortfall)', 'm³/day', ewrShort);

	// Who is charged for a shortfall (engine ≥ 0.17.0, audit Q17): the EWR is
	// assessed at the outlet and every gauge, and each site's shortfall is
	// charged to the farms upstream of it pro rata to their net impact
	// (./network/attribution.ts). Sites: the outlet first, then gauges by node id.
	const gaugeSites = nodes
		.flatMap((n, i) => (n.kind === 'gauge' && i !== topo.outflow ? [i] : []))
		.sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	// A canonical order (network/topology.ts canonicalOrder), not the
	// calculation order, which follows sortOrder: the attribution sums impacts
	// in it, so the charges don't depend on the display order in their last bit.
	const ranked = canonicalOrder(nodes, topo);
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
		transfers: plan.transfers.map((tr, k) => ({ from: tr.from, to: tr.to, volume: sim.transfers[k]! })),
		sites: [
			...(topo.outflow >= 0 ? [{ node: topo.outflow, shortfall: ewrShort }] : []),
			...gaugeSites.map((g) => ({ node: g, shortfall: sim.nodes[g]!.ewrShortfall }))
		]
	});
	const posInOrder = new Int32Array(nodes.length);
	ranked.forEach((node, k) => (posInOrder[node] = k));
	for (const [si, site] of attribution.sites.entries()) {
		const id = si === 0 && topo.outflow >= 0 ? null : nodes[site.node]!.id;
		push(id, 'ewr_charged', 'EWR shortfall charged to the farms upstream (negative)', 'm³/day', site.charged);
		push(id, 'ewr_natural', 'EWR shortfall not caused by use: natural (negative)', 'm³/day', site.natural);
	}
	// The Reserve's assurance rules (engine ≥ 0.21.0, hydrologist Q6): monthly
	// compliance at each EWR site with a rule table (./reserve/assurance.ts).
	const ewrAssurance = assessEwrRules(settings, nodes, topo.outflow, attribution.sites, sim, simOutflow, startDate, days, warnings);
	for (const a of ewrAssurance) push(a.report.nodeId, 'ewr_rule', 'EWR from the Reserve rule table (the month’s requirement, per day)', 'm³/day', a.requiredM3Day);
	for (const s of nf.series ?? []) push(null, s.key, s.label, s.unit, s.values);
	// Before any model's rain threshold (legacy rain_used zeroes rain ≤ threshold); no value from any source = NaN.
	if (finalRain) push(null, 'rain_final', 'Final catchment rainfall (gaps filled by corrected CHIRPS then forecast)', 'mm', finalRain.map((v) => v ?? NaN));
	for (const s of chirpsColumns(series.rain_chirps_mm, chirpsCorrection, start, days, month)) push(null, s.key, s.label, s.unit, s.values);
	if (zeroRain && zeroRain.infill.days > 0) push(null, ZERO_RAIN_COLUMN.key, ZERO_RAIN_COLUMN.label, ZERO_RAIN_COLUMN.unit, zeroRain.mask);
	if (rainSource) push(null, RAIN_SOURCE_COLUMN.key, RAIN_SOURCE_COLUMN.label, RAIN_SOURCE_COLUMN.unit, rainSource.column);
	if (accumulation && accumulation.info.spreadDays > 0) push(null, ACCUMULATION_COLUMN.key, ACCUMULATION_COLUMN.label, ACCUMULATION_COLUMN.unit, accumulation.mask);

	const farmSeries: [keyof NodeResult, string, string][] = [
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
	const WORKING_SERIES: [keyof FarmWorkings, string, string, string][] = [
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
	nodes.forEach((node, i) => {
		const r = sim.nodes[i]!;
		for (const [field, key, label] of farmSeries) {
			if (node.kind === 'gauge' && !gaugeSeries.has(field)) continue;
			if (node.kind === 'user' && !userSeries.has(field)) continue;
			push(node.id, key, node.kind === 'user' ? (USER_LABELS[key] ?? label) : label, key === 'dam_storage' ? 'm³' : 'm³/day', r[field]);
		}
		if (hasSenior) push(node.id, 'senior_requirement', 'Senior users’ demand still to pass below this node', 'm³/day', r.seniorRequirement);
		if (plan.nodes[i]!.landCover) push(node.id, 'landcover_reduction', 'Runoff removed by land cover (invasive plants, forestry)', 'm³/day', r.landCoverReduction);
		if (plan.nodes[i]!.borehole) {
			// Boreholes (WP-1.34): what they gave and what the river loses for it.
			push(node.id, 'groundwater_used', 'Groundwater pumped (part of supplied)', 'm³/day', r.groundwater);
			push(node.id, 'baseflow_depletion', 'Stream depletion taken from the river below (from pumping)', 'm³/day', r.depletion);
			push(node.id, 'depletion_unmet', 'Stream depletion due that the river could not give', 'm³/day', r.depletionUnmet);
			push(node.id, 'depletion_store', 'Stream depletion still to come (lag store)', 'm³', r.depletionStore);
		}
		if (node.kind === 'user') {
			push(node.id, 'return_flow', 'Returned below the user (treated wastewater)', 'm³/day', r.userReturn);
			push(node.id, 'ewr_charge', 'EWR charge: share of the shortfall at the EWR sites below (negative)', 'm³/day', attribution.charge[i]!);
			return;
		}
		const w = sim.workings?.[i];
		if (!w) return;
		// The intermediate columns (engine ≥ 0.12.0), so any day can be redone by hand (verify/columns.ts).
		for (const [field, key, label, unit] of WORKING_SERIES) push(node.id, key, label, unit, w[field]);
		// Dam releases and seepage lost from the catchment (WP-3.5): only on a dam that has them.
		if (plan.nodes[i]!.release) push(node.id, 'dam_release', 'Released below the dam (before irrigation; joins the outflow)', 'm³/day', w.damRelease);
		if (plan.nodes[i]!.seepageReturn !== undefined) push(node.id, 'dam_seepage_lost', 'Dam seepage lost from the catchment (the rest joins the outflow)', 'm³/day', w.damSeepageLost);
		if (hasSenior) push(node.id, 'passed_for_senior', 'Kept out of the dam so the senior users’ demand passes', 'm³/day', w.passedForSenior);
		push(node.id, 'ewr_charge', 'EWR charge: share of the shortfall at the EWR sites below (negative)', 'm³/day', attribution.charge[i]!);
		push(node.id, 'ewr_charge_irrigation', 'EWR charge met by irrigating less (negative)', 'm³/day', attribution.chargeIrrigation[i]!);
	});

	// --- summary -----------------------------------------------------------------
	const mean = (a: ArrayLike<number>) => {
		let s = 0;
		for (let t = 0; t < a.length; t++) s += a[t]!;
		return a.length ? s / a.length : 0;
	};
	/** A node with boreholes: its mean pumping and stream depletion (WP-1.34). */
	const groundwaterMeans = (p: NetworkPlan['nodes'][number], r: NodeResult) =>
		p.borehole ? { avgGroundwaterM3Day: mean(r.groundwater), avgBaseflowDepletionM3Day: mean(r.depletion) } : {};
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
			...groundwaterMeans(plan.nodes[i]!, r)
		});
	});

	boreholeWarnings(nodes, plan, sim, observedKindPresent(series), warnings);

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
			...groundwaterMeans(plan.nodes[i]!, r)
		});
	});

	const window = resolveReportWindow(settings, start, days, warnings);
	const forecastRain = forecastRainDays(input, aligned, start, days, window, warnings);
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
			shortfall: si === 0 && topo.outflow >= 0 ? ewrShort : sim.nodes[site.node]!.ewrShortfall,
			charged: site.charged,
			natural: site.natural
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
	// abstraction), so they are compared with the simulated outflow.
	const calibration = observedKind
		? {
				...calibrationStats(simOutflow, observedM3s, {
					startDate,
					windowStart: settings.calibrationStart,
					windowEnd: settings.calibrationEnd,
					exclusions: exclusionRanges(settings.calibrationExclusions)
				}),
				flowKind: observedKind,
				simulatedKey: 'simulated_outflow' as const
			}
		: null;
	if (!observedKind) warnings.push('no observed flow series: calibration statistics not computed');
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

	// Input data quality: do the two observed flow records agree? Are there
	// impossible or suspicious values? Do the farm areas add up?
	const agreement = observedAgreement(series, agreementOptions(settings.dataQuality));
	const agreementNote = agreementWarning(agreement);
	if (agreementNote) warnings.push(agreementNote);
	const checks = seriesChecks(series);
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
		finalRain,
		plan,
		sim,
		coverTotal,
		ewrShort,
		reserve: ewrAssurance.map((a) => a.report)
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
				depletion: r.depletion,
				storage: r.storage,
				initialStorageM3: kind === 'farm' ? plan.nodes[i]!.initialStorageM3 : 0
			};
		}),
		natural,
		outflow: simOutflow,
		rainMm: finalRain,
		areaKm2: resolveCatchmentAreaKm2(settings.calibration, input),
		sites: attribution.sites.map((site, si) => {
			const outlet = si === 0 && topo.outflow >= 0;
			return {
				nodeId: outlet ? null : nodes[site.node]!.id,
				name: nodes[site.node]!.name,
				required: outlet ? ewr : sim.nodes[site.node]!.ewrCumulative,
				shortfall: outlet ? ewrShort : sim.nodes[site.node]!.ewrShortfall
			};
		})
	});

	return {
		engineVersion: ENGINE_VERSION,
		startDate,
		endDate: fromEpochDay(end),
		days,
		series: out,
		summary: {
			farms,
			...(users.length ? { users } : {}),
			...(hasCover ? { landCover: landCoverSummary(input, natural, coverTotal, plan, sim, days) } : {}),
			catchment: {
				meanNaturalFlowM3Day: mean(natural),
				meanSimulatedOutflowM3Day: mean(simOutflow),
				runoffCoefficient,
				ewrDaysNotMet,
				ewrFractionDaysNotMet: days ? ewrDaysNotMet / days : 0,
				ewrAgreement: ewrObserved
			},
			...(nf.balance ? { runoff: nf.balance } : {}),
			calibration,
			curtailment,
			ewrCompliance: compliance,
			...(ewrAssurance.length ? { ewrAssurance: ewrAssurance.map((a) => a.report) } : {}),
			...(wr2012 ? { wr2012 } : {}),
			dataQuality: { observedAgreement: agreement, seriesChecks: checks, areaMismatches: areas, doubleMass },
			...(checked ? { plausibility: checked.checks } : {}),
			chirpsCorrection,
			...(forecastRain !== undefined ? { forecastRain } : {}),
			zeroRainInfill: zeroRain?.infill ?? null,
			rainSource: rainSource?.info ?? null,
			rainAccumulation: accumulation?.info ?? null,
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
	const dams = new Float64Array(days);
	for (const i of byId) {
		const w = sim.workings?.[i];
		if (!w || plan.nodes[i]!.kind !== 'farm') continue;
		const q = sim.nodes[i]!.storage;
		let prev = plan.nodes[i]!.initialStorageM3;
		for (let t = 0; t < days; t++) {
			dams[t] = dams[t]! + (q[t]! - prev) + w.damEvaporation[t]! - w.rainOnDam[t]! + w.damSeepageLost[t]!;
			prev = q[t]!;
		}
	}
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
		damsM3Day: dams,
		landCoverM3Day: r.coverTotal,
		rainMm: r.finalRain,
		station,
		hasStation: !!series.rain_catchment_mm,
		ewrShortfall: r.ewrShort,
		reserve: r.reserve,
		areaKm2: resolveCatchmentAreaKm2(settings.calibration, input)
	});
}

/** The run's settings, window and aligned inputs: everything before natural flow. */
export interface PreparedRun {
	warnings: string[];
	settings: ProjectSettings;
	series: ModelInput['series'];
	/** First and last simulated epoch day. */
	start: number;
	end: number;
	days: number;
	startDate: string;
	/**
	 * A project series cut/padded to the run window (null where missing). CHIRPS
	 * comes back bias-corrected on the days it stands in for blank catchment
	 * rain (./rain.ts); every other series, and CHIRPS on other days, as stored.
	 */
	aligned: (kind: SeriesKind) => (number | null)[];
	/** Calendar month (1–12) of each simulated day. */
	month: Uint8Array;
	/** The CHIRPS fallback correction (null without a CHIRPS series). */
	chirpsCorrection: ChirpsCorrection | null;
	/** Catchment rain days set aside as missing (CR-20; null without a catchment rain series). */
	zeroRain: ZeroRainMask | null;
	/** Multi-day accumulations and the days they spread over (engine ≥ 0.20.0, audit B4; null without a catchment rain series). */
	accumulation: AccumulationRun | null;
	/** The double-mass check of catchment rain against CHIRPS (engine ≥ 0.18.0; null without both or too few years). */
	doubleMass: DoubleMass | null;
	/** settings.rainSource as applied, and the per-day `rain_source` column (engine ≥ 0.30.0; null without periods). */
	rainSource: { info: RainSourceInfo; column: Float64Array } | null;
}

/** Merge the settings, work out the run window and align the input series to it. */
export function prepareRun(input: ModelInput): PreparedRun {
	const warnings: string[] = [];
	const settings = mergeSettings(input.settings, warnings);
	const series = input.series ?? {};

	// --- run window ---------------------------------------------------------
	const drivers: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
	let first = Infinity;
	let last = -Infinity;
	for (const k of drivers) {
		const s = series[k];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		first = Math.min(first, d0);
		last = Math.max(last, d0 + s.values.length - 1);
	}
	// A rain-source period's series drives the run too, inside its period (engine ≥ 0.30.0).
	for (const p of settings.rainSource) {
		const s = series[p.series];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		const a = Math.max(d0, toEpochDay(p.start));
		const b = Math.min(d0 + s.values.length - 1, toEpochDay(p.end));
		if (a > b) continue;
		first = Math.min(first, a);
		last = Math.max(last, b);
	}
	const start = settings.simulationStart ? toEpochDay(settings.simulationStart) : first;
	const end = settings.simulationEnd ? toEpochDay(settings.simulationEnd) : last;
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		throw new Error('no rainfall series: cannot work out the simulation period');
	}
	if (end < start) throw new Error(`simulation end ${fromEpochDay(end)} is before start ${fromEpochDay(start)}`);
	const days = end - start + 1;
	const startDate = fromEpochDay(start);
	const month = new Uint8Array(days);
	for (let t = 0; t < days; t++) month[t] = monthOfEpochDay(start + t);

	// Rain used = catchment ?? CHIRPS ?? forecast; CHIRPS is bias-corrected
	// where it fills in (audit B1). Catchment rain is blanked first on the days
	// settings.zeroRainRuns sets aside (CR-20), so they fall back too, and a
	// multi-day accumulation's recorded total is spread over the days it
	// covers (audit B4), which the zero-run fill then leaves alone. Every
	// consumer (runoff models, demand, calibration, the runoff coefficient)
	// reads the rain through `aligned`.
	// settings.chirpsFitPeriod (engine ≥ 0.29.0, issue #40): which years the CHIRPS factors are fitted on.
	// settings.rainSource (engine ≥ 0.30.0, issue #40 (b), ./rainSourcePeriods.ts):
	// periods whose catchment rain comes from another series × monthly
	// factors. Their primary reading is left out of every fit and of the
	// zero-run handling, and replaced after the accumulations are applied.
	const doubleMass = doubleMassOf(series, settings.zeroRainRuns);
	const replaced = rainSourceSpans(settings.rainSource);
	const isReplaced = (day: number) => replaced.some((w) => day >= w.from && day <= w.to);
	const fitOpts = { fitPeriod: settings.chirpsFitPeriod, ...(replaced.length ? { replaced } : {}) };
	const acc = rainAccumulations(series, settings.zeroRainRuns, settings.chirpsBiasCorrection, fitOpts);
	const claimed = new Set<number>();
	for (const w of acc?.windows ?? []) if (claimsDays(w.status)) for (let d = w.from; d <= w.to; d++) claimed.add(d);
	const zeroRain = zeroRainMask(series.rain_catchment_mm, settings.zeroRainRuns, start, days, (day) => claimed.has(day), isReplaced);
	const chirpsCorrection = chirpsBiasFactors(series, settings.chirpsBiasCorrection, settings.zeroRainRuns, fitExcludedWindows(acc), fitOpts);
	if (acc) spreadAccumulations(acc, series.rain_chirps_mm, chirpsCorrection);
	const catchment = blankMasked(alignSeries(series.rain_catchment_mm, start, days), zeroRain);
	const accumulation = acc ? applyAccumulations(acc, catchment, start) : null;
	const rainSource = settings.rainSource.length
		? applyRainSource(series, settings.rainSource, rainSourceFactors(series, settings.rainSource, settings.zeroRainRuns, fitExcludedWindows(acc)), catchment, start)
		: null;
	const chirpsRaw = alignSeries(series.rain_chirps_mm, start, days);
	if (rainSource) for (let t = 0; t < days; t++) if (rainSource.blockChirps[t]) chirpsRaw[t] = null;
	const chirpsUsed = chirpsCorrection ? applyChirpsCorrection(chirpsCorrection, catchment, chirpsRaw, month, start) : null;
	const aligned = (kind: SeriesKind) =>
		kind === 'rain_catchment_mm'
			? catchment.slice()
			: kind === 'rain_chirps_mm' && chirpsUsed
				? chirpsUsed.slice()
				: alignSeries(series[kind], start, days);
	const chirpsNote = chirpsCorrectionWarning(chirpsCorrection);
	if (chirpsNote) warnings.push(chirpsNote);
	warnings.push(...keepDryDoubtWarnings(chirpsCorrection));
	// A double-mass break: does CHIRPS fill days in an era whose ratio differs from the fit's?
	const dmNote = doubleMassRunWarning(doubleMass, chirpsCorrection, catchment, alignSeries(series.rain_chirps_mm, start, days), start);
	if (dmNote) warnings.push(dmNote);
	if (zeroRain) {
		const chirps = aligned('rain_chirps_mm');
		const forecast = aligned('rain_forecast_mm');
		finishZeroRainInfill(zeroRain, (t) => chirps[t] ?? forecast[t] ?? null);
		warnings.push(...zeroRainWarnings(zeroRain.infill));
	}
	const rainSourceColumn = rainSource ? finishRainSource(rainSource, catchment, aligned('rain_chirps_mm'), aligned('rain_forecast_mm'), start) : null;
	if (rainSource) warnings.push(...rainSourcePeriodWarnings(rainSource.info));
	if (accumulation) {
		// Left as recorded while CHIRPS fills the zero run it ends: that rain counts twice.
		const filled = (w: { start: string; end: string }) => {
			if (!zeroRain) return false;
			for (let d = Math.max(toEpochDay(w.start), start); d <= Math.min(toEpochDay(w.end), end); d++) if (zeroRain.mask[d - start]) return true;
			return false;
		};
		const doubled = accumulation.info.windows.filter((w) => w.status === 'asRecorded' && filled(w));
		warnings.push(...accumulationWarnings(accumulation.info, doubled));
	}

	if (!series.rain_catchment_mm && !series.rain_chirps_mm && !series.rain_forecast_mm) {
		warnings.push(
			settings.runoffModel === 'legacy'
				? 'no rainfall series: natural flow is only the receding initial base flow, and demand is not reduced by rain'
				: 'no rainfall series: natural flow is only what drains from the stores the warm-up filled, and demand is not reduced by rain'
		);
	}

	return {
		warnings,
		settings,
		series,
		start,
		end,
		days,
		startDate,
		aligned,
		month,
		chirpsCorrection,
		zeroRain,
		accumulation,
		doubleMass,
		rainSource: rainSource ? { info: rainSource.info, column: rainSourceColumn! } : null
	};
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
	warnings: string[]
): { plan: NetworkPlan; topo: ReturnType<typeof buildTopology> } {
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

	const demand = buildDemand({ ...input, model }, settings, days, month, aligned, warnings);

	const indexById = new Map(nodes.map((n, i) => [n.id, i]));
	const transfers: PlanTransfer[] = [];
	// In id order: rules of one priority add into the same destination and draw on the same source.
	for (const tr of [...model.transfers].sort((a, b) => cmpStr(a.id, b.id))) {
		if (!tr.enabled) continue;
		const from = indexById.get(tr.fromNodeId);
		const to = indexById.get(tr.toNodeId);
		if (from === undefined || to === undefined) {
			warnings.push(`transfer ${tr.id} references a node that does not exist; skipped`);
			continue;
		}
		if (nodes[from]!.kind !== 'farm' || nodes[to]!.kind !== 'farm') {
			warnings.push(`transfer ${nodes[from]!.name} → ${nodes[to]!.name}: transfers must be between farms; skipped`);
			continue;
		}
		const activeMonth = new Uint8Array(13);
		for (const m of tr.months) if (m >= 1 && m <= 12) activeMonth[m] = 1;
		// b023 "Transfer capacity max" = max rate m³/s × 86400 (the workbook rounds it); an explicit daily cap can only lower it.
		let maxDaily = tr.maxRateM3s * SEC_PER_DAY;
		if (tr.dailyCapM3 !== null) maxDaily = Math.min(maxDaily, tr.dailyCapM3);
		transfers.push({
			from,
			to,
			activeMonth,
			// The source keeps the rule's minimum or its dam's minimum operating level, whichever is higher (audit Q5).
			reserveM3: nodes[from]!.damCapacityM3 * Math.max(tr.minStoragePct, nodes[from]!.damMinPct),
			maxDailyM3: Math.max(0, maxDaily),
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
	for (let t = 0; t < days; t++) {
		const m = waterYearIndex(month[t]!);
		lakeEvapMmDay[t] = ((lakeK ? lakeK[m]! : settings.lakeEvapFactor) * settings.apanMm[m]!) / monthDays[m]!;
	}
	const rain = runRain(aligned, !!(input.series?.rain_catchment_mm || input.series?.rain_chirps_mm || input.series?.rain_forecast_mm), days);
	const damRainMm = rain ? Float64Array.from(rain, (v) => (v !== null && v > 0 ? v : 0)) : undefined;
	// A dam with a survey curve (WP-3.5) takes its area from it; one the run can't use says why and runs on the power law.
	for (const n of nodes) {
		if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) continue;
		const bad = damCurveProblem(n.damCurve);
		if (bad) warnings.push(`farm "${n.name}": dam survey curve not used (${bad}); using the power-law area`);
		const top = resolveDamCurve(n)?.volume.at(-1);
		if (top !== undefined && Math.abs(top - n.damCapacityM3) > DAM_CURVE_CAPACITY_TOLERANCE * n.damCapacityM3)
			warnings.push(
				`farm "${n.name}": the dam survey curve tops out at ${Math.round(top)} m³ but the capacity is ${Math.round(n.damCapacityM3)} m³ (more than 1 % apart); ` +
					`above the top row the area stays at its last value. Check the capacity against the survey`
			);
	}
	const estimated = nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0 && (n.damAreaFullM2 === null || n.damAreaFullM2 === undefined) && !resolveDamCurve(n));
	if (estimated.length) {
		warnings.push(
			`${estimated.length} dam${estimated.length === 1 ? ' has' : 's have'} no full-supply area, so dam evaporation uses an estimate: ` +
				`capacity ÷ ${ESTIMATED_DAM_DEPTH_M} m mean depth (Mantel & Hughes 2023). Enter the area for (${estimated.map((n) => n.name).join('; ')})`
		);
	}

	const users = otherUsers(nodes, topo, shares.share, days, month, warnings);
	const cover = resolveLandCover(model, warnings);

	const plan: NetworkPlan = {
		days,
		order: topo.order,
		lakeEvapMmDay,
		...(damRainMm ? { damRainMm } : {}),
		// Sum each node's upstream in node-id order, not display order, so the
		// float result can't depend on how the nodes are listed (review F8).
		upstream: topo.upstream.map((ups) => Int32Array.from(ups).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id))),
		transfers,
		month,
		naturalFlow: natural,
		ewr,
		nodes: nodes.map((n, i) => {
			// The workbook rounds capacity and initial storage to whole m³ (a 0.4 m³ dam became 0); the engine doesn't.
			const cap = n.kind === 'user' ? 0 : n.damCapacityM3;
			const u = users.byNode.get(i);
			return {
				kind: n.kind,
				share: shares.share[i]!,
				pctUpstreamToDam: n.pctUpstreamToDam,
				pctRunoffToDam: n.pctRunoffToDam,
				divertCapacityM3Day: n.divertCapacityM3Day,
				damCapacityM3: cap,
				initialStorageM3: n.damInitialPct * cap,
				deadStorageM3: n.kind === 'farm' ? n.damMinPct * cap : 0,
				...irrigation(n, warnings),
				...damLosses(n, warnings),
				...damStorage(n, warnings),
				demand: u?.demand ?? demand[i]!.net,
				grossDemand: demand[i]!.gross,
				rainOffset: demand[i]!.rainOffset,
				soilWater: demand[i]!.soilWater,
				...(u ? { userReturn: u.returnPct, senior: u.senior, seniorClaimed: u.claimed } : {}),
				...boreholeOf(n, warnings),
				...(cover[i] ? { landCover: { mar: cover[i]!.mar, lowFlow: cover[i]!.lowFlow } } : {}),
				...(users.claims[i] ? { seniorClaim: users.claims[i] } : {})
			};
		})
	};
	return { plan, topo };
}

// ---------------------------------------------------------------------------

/**
 * The land-cover summary (WP-1.35): the low-flow threshold, the mean and
 * relative reduction, and per class its condensed area, mean reduction and
 * mm per year over that area. The reduction is linear in the class weights,
 * so each class's part is its own lowFlow × MIN(I0, q) + mar × (I0 − that),
 * with I0 = the farm's runoff + its reduction (the natural runoff).
 */
function landCoverSummary(input: ModelInput, natural: Float64Array, total: Float64Array, plan: NetworkPlan, sim: ReturnType<typeof simulateNetwork>, days: number): LandCoverSummary {
	const cover = resolveLandCover(upgradeLegacyModel(input.model), []);
	const qLow = lowFlowThreshold(natural);
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
 * Run warnings for boreholes (WP-1.34): stream depletion the river could not
 * give (it had no flow left at the node), and, when the project has an
 * observed record, the double-counting caution: flows measured while these
 * boreholes pumped already carry their depletion, so a calibration that
 * leaves them out would fit natural flow too low and then take it off again.
 */
function boreholeWarnings(nodes: readonly NetworkNode[], plan: NetworkPlan, sim: ReturnType<typeof simulateNetwork>, observed: boolean, warnings: string[]) {
	let unmet = 0;
	let depleting = 0;
	const names: string[] = [];
	plan.nodes.forEach((p, i) => {
		if (!p.borehole) return;
		const r = sim.nodes[i]!;
		let u = 0;
		for (let t = 0; t < plan.days; t++) u += r.depletionUnmet[t]!;
		if (u > 1e-9) {
			unmet += u;
			names.push(nodes[i]!.name);
		}
		if (p.borehole.depletionFrac > 0) depleting++;
	});
	if (unmet > 1e-9) {
		warnings.push(
			`stream depletion of ${unmet.toFixed(0)} m³ over the run could not be taken from the river, which had no flow left there; it is drawn from aquifer storage instead and not counted (${names.join('; ')})`
		);
	}
	if (depleting && observed) {
		warnings.push(
			`${depleting} node${depleting === 1 ? ' has' : 's have'} boreholes that deplete the river: if the gauge or logger record was measured while they pumped, keep them in the model when calibrating, so the fitted natural flow isn't reduced twice (docs/model.md §2.7d)`
		);
	}
}

/** k: the share of what a node is supplied that it consumes, 1 − β(1 − e) for a farm (audit N1), 1 − r for an other user (WP-1.33). */
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
}

function otherUsers(
	nodes: readonly NetworkNode[],
	topo: ReturnType<typeof buildTopology>,
	share: Float64Array,
	days: number,
	month: Uint8Array,
	warnings: string[]
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
		const r = n.userReturnPct ?? 0;
		const returnPct = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
		if (returnPct !== r) warnings.push(`user "${n.name}": return share ${String(r)} is not in [0, 1]; using ${returnPct}`);
		const senior = (n.userPriority ?? 'senior') !== 'junior';
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
					for (let t = 0; t < days; t++) c[t]! += demand[t]! * f;
				}
			} else {
				warnings.push(`senior user "${n.name}" has no farm with a flow share upstream: its demand can't be passed down to it, so it takes only what reaches it`);
			}
		}
		byNode.set(i, { demand, returnPct, senior, claimed });
	}
	return { byNode, claims };
}

/**
 * A dam's evaporation and seepage parameters (audit N2): the full-supply area
 * as entered, or capacity ÷ 3 m when it isn't known (warning W6, in
 * buildNetworkPlan); the area exponent (0 < b ≤ 3, else 0.7 with a warning);
 * seepage per day clamped to 0–1. A node without a dam gets none.
 */
function damLosses(n: NetworkNode, warnings: string[]): { damAreaFullM2: number; damAreaExponent: number; damSeepagePerDay: number } {
	const cap = n.damCapacityM3;
	if (n.kind !== 'farm' || !(cap > 0)) return { damAreaFullM2: 0, damAreaExponent: DAM_AREA_EXPONENT, damSeepagePerDay: 0 };
	let area = n.damAreaFullM2 ?? cap / ESTIMATED_DAM_DEPTH_M;
	if (!(Number.isFinite(area) && area >= 0)) {
		warnings.push(`farm "${n.name}": dam area ${String(n.damAreaFullM2)} m² is not a size ≥ 0; using capacity ÷ ${ESTIMATED_DAM_DEPTH_M} m`);
		area = cap / ESTIMATED_DAM_DEPTH_M;
	}
	let b = n.damAreaExponent;
	if (!(b > 0 && b <= 3)) {
		warnings.push(`farm "${n.name}": dam area exponent ${String(b)} is not in (0, 3]; using ${DAM_AREA_EXPONENT}`);
		b = DAM_AREA_EXPONENT;
	}
	const s = n.damSeepagePerDay;
	const seep = Number.isFinite(s) ? Math.min(Math.max(s, 0), 1) : 0;
	if (seep !== s) warnings.push(`farm "${n.name}": dam seepage ${String(s)} per day is not in [0, 1]; using ${seep}`);
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
	if (n.damSeepageReturnPct !== undefined && ret !== n.damSeepageReturnPct) warnings.push(`farm "${n.name}": seepage return ${String(n.damSeepageReturnPct)} is not in [0, 1]; using ${ret}`);
	return { ...(curve ? { damCurve: curve } : {}), ...(release ? { release } : {}), ...(ret < 1 ? { seepageReturn: ret } : {}) };
}

/**
 * A farm's irrigation efficiency and loss return (audit N1). Validation keeps
 * 0 < e ≤ 1 and 0 ≤ β ≤ 1; a value outside that (a hand-edited document)
 * runs as e = 1 and β clamped, with a warning, rather than dividing by 0.
 */
function irrigation(n: NetworkNode, warnings: string[]): { irrigationEfficiency: number; lossReturnFraction: number } {
	if (n.kind !== 'farm') return { irrigationEfficiency: 1, lossReturnFraction: 0 };
	let e = n.irrigationEfficiency;
	if (!(e > 0 && e <= 1)) {
		warnings.push(`farm "${n.name}": irrigation efficiency ${String(e)} is not in (0, 1]; using 1`);
		e = 1;
	}
	const b = n.lossReturnFraction;
	const beta = Number.isFinite(b) ? Math.min(Math.max(b, 0), 1) : 0;
	if (beta !== b) warnings.push(`farm "${n.name}": loss return fraction ${String(b)} is not in [0, 1]; using ${beta}`);
	return { irrigationEfficiency: e, lossReturnFraction: beta };
}

/**
 * Natural-flow volume / rain volume over the run (null without rain). A value
 * above 1 means the catchment gives back more water than fell on it, which no
 * catchment can do over a whole record: warn (audit H1, W1). Also counts the
 * days without any rainfall value, which the model silently treats as dry (W2).
 */
function catchmentRunoffCoefficient(
	input: ModelInput,
	settings: ProjectSettings,
	natural: Float64Array,
	aligned: (k: SeriesKind) => (number | null)[],
	warnings: string[],
	balance: NaturalFlowInput['balance']
): number | null {
	const kinds: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
	if (!kinds.some((k) => input.series?.[k])) return null;
	const [c, ch, f] = kinds.map(aligned) as [(number | null)[], (number | null)[], (number | null)[]];
	let rainMm = 0;
	let missing = 0;
	for (let t = 0; t < natural.length; t++) {
		const v = c[t] ?? ch[t] ?? f[t] ?? null;
		if (v === null) missing++;
		else if (v > 0) rainMm += v;
	}
	if (missing > 0) {
		warnings.push(
			`${missing} of ${natural.length} days have no rainfall value (catchment, CHIRPS or forecast); the model treats them as dry (0 mm)`
		);
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
		warnings.push(
			`the rain model makes more runoff than rainfall: natural flow is ${coefficient.toFixed(2)}× the rain volume over the run. ` +
				'Check the calibration (a, b, the season factors, the recession curve) and the catchment area'
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
	warnings: string[]
): { report: EwrAssuranceSite; requiredM3Day: Float64Array }[] {
	const out: { report: EwrAssuranceSite; requiredM3Day: Float64Array }[] = [];
	const siteOf = new Map(sites.map((s) => [s.node, s]));
	const key = (id: string | null) => id ?? '';
	const tables = [...settings.ewrRules].sort((a, b) => (key(a.siteNodeId) < key(b.siteNodeId) ? -1 : key(a.siteNodeId) > key(b.siteNodeId) ? 1 : 0));
	const done = new Set<number>();
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
		if (done.has(node)) {
			// A table keyed by the outlet node's id besides one for "the outlet" (null).
			warnings.push(`a second EWR rule table for "${nodes[node]!.name}" is ignored: each site has one`);
			continue;
		}
		if (!isOutlet && nodes[node]!.kind !== 'gauge') {
			warnings.push(`EWR rule table for "${nodes[node]!.name}" skipped: an EWR site is the outlet or a gauge`);
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
		const a = assessSite(startDate, days, { table, nodeId: isOutlet ? null : nodes[node]!.id, name, isOutlet, natural, impacted });
		warnings.push(...assuranceWarnings(a.report));
		done.add(node);
		out.push(a);
	}
	return out;
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

/** Series labels that read differently on an other water user (WP-1.33). */
const USER_LABELS: Record<string, string> = {
	demand: 'Demand from the river',
	supplied: 'Taken from the river',
	deficit: 'Demand not met'
};

const OBSERVED_LABEL: Record<CalibrationFlowKind, string> = {
	flow_observed_m3s: 'Observed flow',
	flow_logger_m3s: 'Observed flow (logger)'
};

/**
 * Every legacy run carries this (audit H1, operator decision 2026-09-24): the
 * b023 recession model doesn't conserve water at the event scale (a storm can
 * return several times its own rain as flow — docs/engine-audit.md H1), so it
 * stays unchanged for workbook comparison only. The "LEGACY_NOT_EVIDENCE:"
 * prefix is a stable code a caller can match on even if the wording changes.
 */
export const LEGACY_NOT_EVIDENCE_WARNING =
	'LEGACY_NOT_EVIDENCE: Legacy runoff model (b023 workbook): does not conserve water at the event scale (audit H1); ' +
	'workbook comparison only, not evidence for a licence, Reserve or compliance assessment.';

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
	}
	return out;
}

function alignSeries(s: DailySeries | undefined, start: number, days: number): (number | null)[] {
	const out = new Array<number | null>(days).fill(null);
	if (!s) return out;
	const offset = toEpochDay(s.startDate) - start;
	const from = Math.max(0, -offset);
	const to = Math.min(s.values.length, days - offset);
	for (let i = from; i < to; i++) {
		const v = s.values[i];
		out[i + offset] = typeof v === 'number' && Number.isFinite(v) ? v : null;
	}
	return out;
}

const WATER_YEAR_MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

function monthly(v: unknown, name: string, warnings: string[]): Monthly {
	const arr = Array.isArray(v) ? v : [];
	if (arr.length !== 12) warnings.push(`${name} should have 12 monthly values, has ${arr.length}; missing months are 0`);
	return Array.from({ length: 12 }, (_, i) => {
		const x = Number(arr[i]);
		return Number.isFinite(x) ? x : 0;
	}) as unknown as Monthly;
}

function mergeSettings(raw: ModelInput['settings'], warnings: string[]): ProjectSettings {
	const d = defaultProjectSettings();
	const s = { ...d, ...(raw ?? {}) } as ProjectSettings;
	s.calibration = { ...d.calibration, ...((raw?.calibration as object | undefined) ?? {}) };
	s.hiLoSplit = { ...d.hiLoSplit, ...((raw?.hiLoSplit as object | undefined) ?? {}) };
	s.gr4j = { ...d.gr4j, ...((raw?.gr4j as object | undefined) ?? {}) };
	s.panCoefficient = monthly(s.panCoefficient, 'pan coefficient', warnings);
	s.dataQuality = resolveDataQuality(raw?.dataQuality, warnings);
	s.zeroRainRuns = resolveZeroRain(raw?.zeroRainRuns, warnings);
	s.wr2012 = resolveWr2012(raw?.wr2012, warnings);
	s.ewrRules = resolveEwrRules(raw?.ewrRules, warnings);
	s.apanMm = monthly(s.apanMm, 'A-pan evaporation', warnings);
	s.ewrPragmaticM3PerDay = monthly(s.ewrPragmaticM3PerDay, 'pragmatic EWR', warnings);
	if (typeof s.lakeEvapFactor !== 'number' || !Number.isFinite(s.lakeEvapFactor) || s.lakeEvapFactor < 0) {
		warnings.push(`dam evaporation factor "${String(s.lakeEvapFactor)}" is not a number ≥ 0; using ${d.lakeEvapFactor}`);
		s.lakeEvapFactor = d.lakeEvapFactor;
	}
	// Monthly lake factors (WP-3.5): 12 numbers ≥ 0, or none.
	if (s.lakeEvapFactorMonthly != null) {
		const k = s.lakeEvapFactorMonthly;
		if (!Array.isArray(k) || k.length !== 12 || !k.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) {
			warnings.push(`monthly dam evaporation factors should be 12 numbers ≥ 0; using ${s.lakeEvapFactor} in every month`);
			s.lakeEvapFactorMonthly = null;
		}
	}
	if (typeof s.effectiveRainStoreMm !== 'number' || !Number.isFinite(s.effectiveRainStoreMm) || s.effectiveRainStoreMm < 0) {
		warnings.push(`soil-water store "${String(s.effectiveRainStoreMm)}" mm is not a size ≥ 0; using ${d.effectiveRainStoreMm} mm`);
		s.effectiveRainStoreMm = d.effectiveRainStoreMm;
	}
	if (s.calibrationFlowKind != null && !CALIBRATION_FLOW_KINDS.includes(s.calibrationFlowKind)) {
		warnings.push(`unknown calibration flow series "${String(s.calibrationFlowKind)}"; using the default`);
		s.calibrationFlowKind = null;
	}
	s.calibrationFlowKind ??= null;
	s.calibrationExclusions = sanitizeExclusions(raw?.calibrationExclusions, warnings);
	// Provenance only: never read by the model.
	s.fitRecord = (raw?.fitRecord as ProjectSettings['fitRecord'] | undefined) ?? null;
	for (const key of ['calibrationStart', 'calibrationEnd'] as const) {
		const v = s[key];
		if (v == null || v === '') {
			s[key] = null;
		} else if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
			warnings.push(`${key} "${String(v)}" is not an ISO date (YYYY-MM-DD); ignored`);
			s[key] = null;
		}
	}
	if (s.calibrationStart && s.calibrationEnd && s.calibrationStart > s.calibrationEnd) {
		warnings.push(`calibration window ${s.calibrationStart} … ${s.calibrationEnd} ends before it starts; scoring the whole record`);
		s.calibrationStart = null;
		s.calibrationEnd = null;
	}
	if (!(RUNOFF_MODELS as readonly string[]).includes(s.runoffModel)) {
		warnings.push(`unknown runoff model "${String(s.runoffModel)}"; using ${d.runoffModel}`);
		s.runoffModel = d.runoffModel;
	}
	s.pe = resolvePe(raw?.pe, warnings);
	// Provenance only (never read by the model): a string, capped like the PE source.
	s.panCoefficientSource = typeof raw?.panCoefficientSource === 'string' ? raw.panCoefficientSource.slice(0, PE_SOURCE_MAX) : '';
	// The Kp plausibility check only means something when GR4J's PE is Kp × A-pan.
	if (s.runoffModel === 'gr4j' && s.pe.kind === 'pan') {
		const months = panCoefficientOutOfRange(s.panCoefficient);
		if (months.length) {
			const names = months.map((i) => WATER_YEAR_MONTH_NAMES[i]).join(', ');
			warnings.push(
				`pan coefficient is outside FAO-56's typical Class A pan range (${PAN_COEFFICIENT_TYPICAL_MIN}–${PAN_COEFFICIENT_TYPICAL_MAX}) in ${names}: confirm against local humidity and wind`
			);
		}
	}
	s.chirpsFitPeriod = resolveChirpsFitPeriod(raw?.chirpsFitPeriod, warnings);
	s.rainSource = resolveRainSource(raw?.rainSource, warnings);
	if (!(CHIRPS_BIAS_MODES as readonly string[]).includes(s.chirpsBiasCorrection)) {
		warnings.push(`unknown CHIRPS bias correction "${String(s.chirpsBiasCorrection)}"; using ${d.chirpsBiasCorrection}`);
		s.chirpsBiasCorrection = d.chirpsBiasCorrection;
	}
	if (s.assuranceAnnualThreshold !== undefined && !(typeof s.assuranceAnnualThreshold === 'number' && s.assuranceAnnualThreshold > 0 && s.assuranceAnnualThreshold <= 1)) {
		warnings.push(`annual assurance threshold "${String(s.assuranceAnnualThreshold)}" is not a fraction in (0, 1]; using ${DEFAULT_ANNUAL_THRESHOLD}`);
		delete s.assuranceAnnualThreshold;
	}
	if (!['area', 'hiLo', 'manual'].includes(s.flowShareMethod)) {
		warnings.push(`unknown flow share method "${String(s.flowShareMethod)}"; using area`);
		s.flowShareMethod = 'area';
	}
	return s;
}

/** Daily net irrigation demand per node (zeros for gauges and crop-less farms). */
function buildDemand(
	input: ModelInput,
	settings: ProjectSettings,
	days: number,
	month: Uint8Array,
	aligned: (k: SeriesKind) => (number | null)[],
	warnings: string[]
): { net: Float64Array; gross: Float64Array; rainOffset: Float64Array; soilWater: Float64Array }[] {
	const { nodes, crops: cropDefs, cropAreas } = input.model;
	const crops: Crop[] = cropDefs.map((c) => ({
		id: c.id,
		name: c.name,
		cropFactor: monthly(c.cropFactor, `crop factors for "${c.name}"`, warnings)
	}));
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
		const v = catchment[t] ?? chirps[t] ?? forecast[t] ?? 0;
		rain[t] = v > thr ? v : 0;
	}

	const wy = new Uint8Array(days);
	for (let t = 0; t < days; t++) wy[t] = waterYearIndex(month[t]!);

	let anyArea = false;
	const out = nodes.map((node) => {
		const d = { net: new Float64Array(days), gross: new Float64Array(days), rainOffset: new Float64Array(days), soilWater: new Float64Array(days) };
		if (node.kind !== 'farm') return d;
		const areas = new Map<string, number>();
		let cropped = 0;
		for (const ca of sortedAreas) {
			if (ca.nodeId !== node.id) continue;
			if (!cropIds.has(ca.cropId)) {
				warnings.push(`farm "${node.name}" has an area for an unknown crop; ignored`);
				continue;
			}
			areas.set(ca.cropId, (areas.get(ca.cropId) ?? 0) + ca.areaM2);
			cropped += ca.areaM2;
		}
		if (cropped === 0) return d;
		anyArea = true;
		const gross = grossFarmDemandM3PerDay(settings.apanMm, crops, areas, settings.februaryDays);
		for (let t = 0; t < days; t++) d.gross[t] = gross[wy[t]!]!;
		// Effective rain carries over through the soil-water store (N3, engine ≥ 0.14.0).
		const f = farmDailyDemand(d.gross, cropped, rain, settings.effectiveRainFraction, settings.effectiveRainStoreMm);
		return { net: f.net, gross: d.gross, rainOffset: f.used, soilWater: f.storeMm };
	});
	if (anyArea && settings.apanMm.every((v) => v === 0)) {
		warnings.push('A-pan evaporation is 0 for every month, so irrigation demand is 0');
	}
	return out;
}
