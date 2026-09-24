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
	applyChirpsCorrection,
	blankMasked,
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	finishZeroRainInfill,
	resolveZeroRain,
	ZERO_RAIN_COLUMN,
	zeroRainMask,
	zeroRainWarnings,
	type ChirpsCorrection,
	type ZeroRainMask
} from './rain';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, type Monthly } from './calendar';
import { farmDailyDemand, grossFarmDemandM3PerDay, type Crop } from './demand';
import { computeCurtailment, type ReportWindow } from './network/curtailment';
import { flowShares } from './network/shares';
import { shortfall, simulateNetwork, type FarmWorkings, type NetworkPlan, type NodeResult, type PlanTransfer } from './network/simulate';
import { verifyRun } from './verify/verify';
import { ewrCompliance } from './network/ewr';
import { ewrAgreement } from './network/ewrAgreement';
import { exclusionRanges, sanitizeExclusions } from './calibrate/provenance';
import { calibrationStats } from './network/stats';
import { buildTopology } from './network/topology';
import { resolveWr2012, runRain, wr2012Report } from './reference/wr2012';
import { NATURAL_FLOW, RUNOFF_MODELS, resolveCatchmentAreaKm2, type NaturalFlowInput, type RunContext } from './runoff';
import {
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	defaultProjectSettings,
	type CalibrationFlowKind,
	type DailySeries,
	type FarmSummary,
	type ModelInput,
	type ModelOutput,
	type ProjectSettings,
	type RunSeries,
	type SeriesKind
} from './project';

export const ENGINE_VERSION = '0.15.0';

const SEC_PER_DAY = 86_400;

export type { NaturalFlowInput, RunContext } from './runoff';
export { resolveCatchmentAreaKm2 } from './runoff';

/** Run the full model: natural flow from the selected runoff model (./runoff), then the network. */
export function runModel(input: ModelInput): ModelOutput {
	return runModelWith(input, (ctx) => NATURAL_FLOW[ctx.settings.runoffModel](input, ctx));
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
	const { warnings, settings, series, start, end, days, startDate, aligned, month, chirpsCorrection, zeroRain } = prepareRun(input);

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
	for (const s of nf.series ?? []) push(null, s.key, s.label, s.unit, s.values);
	// Before any model's rain threshold (legacy rain_used zeroes rain ≤ threshold); no value from any source = NaN.
	if (finalRain) push(null, 'rain_final', 'Final catchment rainfall (gaps filled by corrected CHIRPS then forecast)', 'mm', finalRain.map((v) => v ?? NaN));
	for (const s of chirpsColumns(series.rain_chirps_mm, chirpsCorrection, start, days, month)) push(null, s.key, s.label, s.unit, s.values);
	if (zeroRain && zeroRain.infill.days > 0) push(null, ZERO_RAIN_COLUMN.key, ZERO_RAIN_COLUMN.label, ZERO_RAIN_COLUMN.unit, zeroRain.mask);

	const farmSeries: [keyof NodeResult, string, string][] = [
		['demand', 'demand', 'Irrigation demand (net)'],
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
		['ewrShortfallIncremental', 'ewr_shortfall_incremental', 'EWR shortfall caused here']
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
		['returnFlow', 'return_flow', 'Irrigation return flow', 'm³/day'],
		['balanceResidual', 'balance_residual', 'Balance check (should be 0)', 'm³/day']
	];
	const gaugeSeries = new Set<keyof NodeResult>(['inflowUpstream', 'outflow', 'ewrCumulative', 'ewrShortfall']);
	nodes.forEach((node, i) => {
		const r = sim.nodes[i]!;
		for (const [field, key, label] of farmSeries) {
			if (node.kind === 'gauge' && !gaugeSeries.has(field)) continue;
			push(node.id, key, label, key === 'dam_storage' ? 'm³' : 'm³/day', r[field]);
		}
		const w = sim.workings?.[i];
		if (!w) return;
		// The intermediate columns (engine ≥ 0.12.0), so any day can be redone by hand (verify/columns.ts).
		for (const [field, key, label, unit] of WORKING_SERIES) push(node.id, key, label, unit, w[field]);
	});

	// --- summary -----------------------------------------------------------------
	const mean = (a: ArrayLike<number>) => {
		let s = 0;
		for (let t = 0; t < a.length; t++) s += a[t]!;
		return a.length ? s / a.length : 0;
	};
	const farms: FarmSummary[] = [];
	nodes.forEach((node, i) => {
		if (node.kind !== 'farm') return;
		const r = sim.nodes[i]!;
		const avgDemand = mean(r.demand);
		const avgSupplied = mean(r.supplied);
		let notMet = 0;
		for (let t = 0; t < days; t++) if (r.ewrShortfallIncremental[t]! < 0) notMet++;
		farms.push({
			nodeId: node.id,
			name: node.name,
			avgDemandM3Day: avgDemand,
			avgSuppliedM3Day: avgSupplied,
			avgDeficitM3Day: avgDemand - avgSupplied,
			fractionSupplied: avgDemand > 0 ? avgSupplied / avgDemand : 1,
			// Positive volume: the average EWR shortfall this farm adds (b023 [Shortfalls] col R, sign flipped).
			avgEwrShortfallM3Day: -mean(r.ewrShortfallIncremental),
			daysEwrNotMet: notMet
		});
	});

	const window = resolveReportWindow(settings, start, days, warnings);
	const curtailment = computeCurtailment(
		nodes.flatMap((node, i) => {
			if (node.kind !== 'farm') return [];
			const r = sim.nodes[i]!;
			return [
				{
					nodeId: node.id,
					name: node.name,
					demand: r.demand,
					supplied: r.supplied,
					ewrShortfallIncremental: r.ewrShortfallIncremental
				}
			];
		}),
		window
	);

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
				? [{ nodeId: node.id, name: node.name, shortfallM3Day: sim.nodes[i]!.ewrShortfallIncremental }]
				: []
		)
	);

	return {
		engineVersion: ENGINE_VERSION,
		startDate,
		endDate: fromEpochDay(end),
		days,
		series: out,
		summary: {
			farms,
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
			...(wr2012 ? { wr2012 } : {}),
			dataQuality: { observedAgreement: agreement, seriesChecks: checks, areaMismatches: areas },
			chirpsCorrection,
			zeroRainInfill: zeroRain?.infill ?? null,
			warnings
		}
	};
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
	// settings.zeroRainRuns sets aside (CR-20), so they fall back too. Every
	// consumer (runoff models, demand, calibration, the runoff coefficient)
	// reads the rain through `aligned`.
	const zeroRain = zeroRainMask(series.rain_catchment_mm, settings.zeroRainRuns, start, days);
	const catchment = blankMasked(alignSeries(series.rain_catchment_mm, start, days), zeroRain);
	const chirpsCorrection = chirpsBiasFactors(series, settings.chirpsBiasCorrection, exclusionRanges(settings.zeroRainRuns.missing));
	const chirpsUsed = chirpsCorrection ? applyChirpsCorrection(chirpsCorrection, catchment, alignSeries(series.rain_chirps_mm, start, days), month) : null;
	const aligned = (kind: SeriesKind) =>
		kind === 'rain_catchment_mm'
			? catchment.slice()
			: kind === 'rain_chirps_mm' && chirpsUsed
				? chirpsUsed.slice()
				: alignSeries(series[kind], start, days);
	const chirpsNote = chirpsCorrectionWarning(chirpsCorrection);
	if (chirpsNote) warnings.push(chirpsNote);
	if (zeroRain) {
		const chirps = aligned('rain_chirps_mm');
		const forecast = aligned('rain_forecast_mm');
		finishZeroRainInfill(zeroRain, (t) => chirps[t] ?? forecast[t] ?? null);
		warnings.push(...zeroRainWarnings(zeroRain.infill));
	}

	if (!series.rain_catchment_mm && !series.rain_chirps_mm && !series.rain_forecast_mm) {
		warnings.push(
			settings.runoffModel === 'legacy'
				? 'no rainfall series: natural flow is only the receding initial base flow, and demand is not reduced by rain'
				: 'no rainfall series: natural flow is only what drains from the stores the warm-up filled, and demand is not reduced by rain'
		);
	}

	return { warnings, settings, series, start, end, days, startDate, aligned, month, chirpsCorrection, zeroRain };
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
	const { model } = input;
	const nodes = model.nodes;
	const topo = buildTopology(nodes);
	warnings.push(...topo.warnings);
	const shares = flowShares(nodes, settings.flowShareMethod, settings.hiLoSplit);
	warnings.push(...shares.warnings);

	const ewrWy = settings.ewrPragmaticM3PerDay;
	const ewr = new Float64Array(days);
	for (let t = 0; t < days; t++) ewr[t] = ewrWy[waterYearIndex(month[t]!)]!;

	const demand = buildDemand(input, settings, days, month, aligned, warnings);

	const indexById = new Map(nodes.map((n, i) => [n.id, i]));
	const transfers: PlanTransfer[] = [];
	for (const tr of model.transfers) {
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
			reserveM3: nodes[from]!.damCapacityM3 * tr.minStoragePct,
			maxDailyM3: Math.max(0, maxDaily)
		});
	}

	const plan: NetworkPlan = {
		days,
		order: topo.order,
		// Sum each node's upstream in node-id order, not display order, so the
		// float result can't depend on how the nodes are listed (review F8).
		upstream: topo.upstream.map((ups) => Int32Array.from(ups).sort((a, b) => (nodes[a]!.id < nodes[b]!.id ? -1 : nodes[a]!.id > nodes[b]!.id ? 1 : 0))),
		transfers,
		month,
		naturalFlow: natural,
		ewr,
		nodes: nodes.map((n, i) => {
			// The workbook rounds capacity and initial storage to whole m³ (a 0.4 m³ dam became 0); the engine doesn't.
			const cap = n.damCapacityM3;
			return {
				kind: n.kind,
				share: shares.share[i]!,
				pctUpstreamToDam: n.pctUpstreamToDam,
				pctRunoffToDam: n.pctRunoffToDam,
				divertCapacityM3Day: n.divertCapacityM3Day,
				damCapacityM3: cap,
				initialStorageM3: n.damInitialPct * cap,
				returnFlowPct: n.returnFlowPct,
				demand: demand[i]!.net,
				grossDemand: demand[i]!.gross,
				rainOffset: demand[i]!.rainOffset,
				soilWater: demand[i]!.soilWater
			};
		})
	};
	return { plan, topo };
}

// ---------------------------------------------------------------------------

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
		const factor = Array.from(month, (m) => corr.months[m - 1]!.factor ?? NaN);
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
	s.apanMm = monthly(s.apanMm, 'A-pan evaporation', warnings);
	s.ewrPragmaticM3PerDay = monthly(s.ewrPragmaticM3PerDay, 'pragmatic EWR', warnings);
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
	if (!(CHIRPS_BIAS_MODES as readonly string[]).includes(s.chirpsBiasCorrection)) {
		warnings.push(`unknown CHIRPS bias correction "${String(s.chirpsBiasCorrection)}"; using ${d.chirpsBiasCorrection}`);
		s.chirpsBiasCorrection = d.chirpsBiasCorrection;
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
		for (const ca of cropAreas) {
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
