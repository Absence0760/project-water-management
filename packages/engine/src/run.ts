// Model entry point: runModel(input) → daily series + summary for a project.
//
// Pipeline (b023 sheet in brackets):
//   1. natural flow from rain                     [Flow data]            → ./flow.ts
//   2. per-farm share of flow and EWR             [Fragmented flow/EWR]  → ./network/shares.ts
//   3. daily net irrigation demand                [Irrigation Demand]    → ./demand.ts
//   4. transfers + farm dams, routed downstream   [Transfers], Elements  → ./network/simulate.ts
//   5. EWR shortfalls, calibration statistics     [EWR shortfalls]       → ./network/stats.ts
// See ./network/README.md for the column-by-column mapping.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, type Monthly } from './calendar';
import { grossFarmDemandM3PerDay, netDailyDemandM3, type Crop } from './demand';
import { computeNaturalFlow } from './flow';
import { WBT_PRECISION, excelRound } from './network/round';
import { flowShares } from './network/shares';
import { simulateNetwork, type NetworkPlan, type NodeResult, type PlanTransfer } from './network/simulate';
import { calibrationStats } from './network/stats';
import { buildTopology } from './network/topology';
import {
	defaultProjectSettings,
	type DailySeries,
	type FarmSummary,
	type ModelInput,
	type ModelOutput,
	type ProjectSettings,
	type RunSeries,
	type SeriesKind
} from './project';

export const ENGINE_VERSION = '0.2.0';

const SEC_PER_DAY = 86_400;

/** Natural flow for the run window, plus any extra catchment series to report. */
export interface NaturalFlowInput {
	naturalFlowM3Day: ArrayLike<number>;
	series?: { key: string; label: string; unit: string; values: number[] }[];
}

/** Explicit catchment area, else the sum of the farm areas (the workbook's rFarmSpec_AreaTotal). */
export function resolveCatchmentAreaKm2(cal: { catchmentAreaKm2: number | null }, input: ModelInput): number {
	if (cal.catchmentAreaKm2 != null && cal.catchmentAreaKm2 > 0) return cal.catchmentAreaKm2;
	return input.model.nodes.filter((n) => n.kind === 'farm').reduce((sum, n) => sum + (n.areaKm2 || 0), 0);
}

function withCatchmentArea<T extends { catchmentAreaKm2: number | null }>(cal: T, input: ModelInput): T & { catchmentAreaKm2: number } {
	const area = resolveCatchmentAreaKm2(cal, input);
	if (!(area > 0)) throw new Error('catchment area is 0 — give the farms an area (km²) or set calibration.catchmentAreaKm2');
	return { ...cal, catchmentAreaKm2: area };
}

/** Run the full model: natural flow from rain (./flow.ts), then the network. */
export function runModel(input: ModelInput): ModelOutput {
	return runModelWith(input, (ctx) =>
		computeNaturalFlow(withCatchmentArea(ctx.settings.calibration, input), {
			startDate: ctx.startDate,
			days: ctx.days,
			rainCatchmentMm: ctx.aligned('rain_catchment_mm'),
			rainChirpsMm: ctx.aligned('rain_chirps_mm'),
			rainForecastMm: ctx.aligned('rain_forecast_mm'),
			flowPitmanM3s: ctx.aligned('flow_pitman_m3s')
		})
	);
}

export interface RunContext {
	settings: ProjectSettings;
	startDate: string;
	days: number;
	/** A project series cut/padded to the run window (null where missing). */
	aligned(kind: SeriesKind): (number | null)[];
}

/**
 * Run the network with natural flow supplied by `naturalFlow` instead of the
 * rain model. runModel uses this with ./flow.ts; the workbook regression test
 * uses it to feed the workbook's own natural flow and so test the network on
 * its own.
 */
export function runModelWith(
	input: ModelInput,
	naturalFlow: (ctx: RunContext) => NaturalFlowInput
): ModelOutput {
	const warnings: string[] = [];
	const settings = mergeSettings(input.settings, warnings);
	const { model } = input;
	const series = input.series ?? {};

	// --- run window ---------------------------------------------------------
	const drivers: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm', 'flow_pitman_m3s'];
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
		throw new Error('no rainfall or Pitman flow series: cannot work out the simulation period');
	}
	if (end < start) throw new Error(`simulation end ${fromEpochDay(end)} is before start ${fromEpochDay(start)}`);
	const days = end - start + 1;
	const startDate = fromEpochDay(start);
	const aligned = (kind: SeriesKind) => alignSeries(series[kind], start, days);

	if (!series.rain_catchment_mm && !series.rain_chirps_mm && !series.rain_forecast_mm) {
		warnings.push('no rainfall series: natural flow falls back to Pitman flow and demand is not reduced by rain');
	}

	const month = new Uint8Array(days);
	for (let t = 0; t < days; t++) month[t] = monthOfEpochDay(start + t);

	// --- natural flow ---------------------------------------------------------
	const nf = naturalFlow({ settings, startDate, days, aligned });
	if (nf.naturalFlowM3Day.length !== days) {
		throw new Error(`natural flow has ${nf.naturalFlowM3Day.length} days, expected ${days}`);
	}
	const natural = Float64Array.from(nf.naturalFlowM3Day, (v) => (Number.isFinite(v) ? v : 0));

	// --- network ----------------------------------------------------------------
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
		// b023: "Transfer capacity max" = ROUND(max rate m³/s × 86400); an explicit daily cap can only lower it.
		let maxDaily = excelRound(tr.maxRateM3s * SEC_PER_DAY, 0);
		if (tr.dailyCapM3 !== null) maxDaily = Math.min(maxDaily, tr.dailyCapM3);
		transfers.push({
			from,
			to,
			activeMonth,
			// fGetDamCapacity reads the unrounded capacity from [Farm spec].
			reserveM3: nodes[from]!.damCapacityM3 * tr.minStoragePct,
			maxDailyM3: Math.max(0, maxDaily)
		});
	}

	const plan: NetworkPlan = {
		days,
		order: topo.order,
		upstream: topo.upstream,
		transfers,
		month,
		naturalFlow: natural,
		ewr,
		nodes: nodes.map((n, i) => {
			const cap = excelRound(n.damCapacityM3, 0);
			return {
				kind: n.kind,
				share: shares.share[i]!,
				pctUpstreamToDam: n.pctUpstreamToDam,
				pctRunoffToDam: n.pctRunoffToDam,
				divertCapacityM3Day: n.divertCapacityM3Day,
				damCapacityM3: cap,
				initialStorageM3: excelRound(n.damInitialPct * cap, 0),
				returnFlowPct: n.returnFlowPct,
				demand: demand[i]!
			};
		})
	};
	const sim = simulateNetwork(plan);

	// --- outputs -----------------------------------------------------------------
	const out: RunSeries[] = [];
	const push = (nodeId: string | null, key: string, label: string, unit: string, values: ArrayLike<number>) =>
		out.push({ nodeId, key, label, unit, values: Array.from(values) });

	const simOutflow = topo.outflow >= 0 ? sim.nodes[topo.outflow]!.outflow : new Float64Array(days);
	const observedM3s = series.flow_observed_m3s ? aligned('flow_observed_m3s') : aligned('flow_logger_m3s');
	const observedKind = series.flow_observed_m3s ? 'observed' : series.flow_logger_m3s ? 'logger' : null;
	const ewrShort = new Float64Array(days);
	let ewrDaysNotMet = 0;
	for (let t = 0; t < days; t++) {
		const d = simOutflow[t]! - ewr[t]!;
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
			observedKind === 'observed' ? 'Observed flow' : 'Observed flow (logger)',
			'm³/day',
			// b023 [Flow data] P: ROUND(m³/s × 86400); missing days are NaN so charts show gaps.
			observedM3s.map((v) => (v === null ? NaN : excelRound(v * SEC_PER_DAY, 0)))
		);
	}
	push(null, 'ewr', 'Pragmatic EWR', 'm³/day', ewr);
	push(null, 'ewr_shortfall', 'EWR not met (negative = shortfall)', 'm³/day', ewrShort);
	for (const s of nf.series ?? []) push(null, s.key, s.label, s.unit, s.values);

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
	const gaugeSeries = new Set<keyof NodeResult>(['inflowUpstream', 'outflow', 'ewrCumulative', 'ewrShortfall']);
	nodes.forEach((node, i) => {
		const r = sim.nodes[i]!;
		for (const [field, key, label] of farmSeries) {
			if (node.kind === 'gauge' && !gaugeSeries.has(field)) continue;
			push(node.id, key, label, key === 'dam_storage' ? 'm³' : 'm³/day', r[field]);
		}
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

	const calibration = observedKind ? calibrationStats(simOutflow, observedM3s) : null;
	if (!observedKind) warnings.push('no observed flow series: calibration statistics not computed');
	else if (calibration && calibration.days === 0) warnings.push('observed flow has no values inside the simulation period');

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
				ewrDaysNotMet,
				ewrFractionDaysNotMet: days ? ewrDaysNotMet / days : 0
			},
			calibration,
			warnings
		}
	};
}

// ---------------------------------------------------------------------------

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
	s.apanMm = monthly(s.apanMm, 'A-pan evaporation', warnings);
	s.ewrPragmaticM3PerDay = monthly(s.ewrPragmaticM3PerDay, 'pragmatic EWR', warnings);
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
): Float64Array[] {
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
		const d = new Float64Array(days);
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
		const gross = grossFarmDemandM3PerDay(settings.apanMm, crops, areas, settings.februaryDays, {
			cropMm: WBT_PRECISION.cropGrossMm,
			farmM3Day: WBT_PRECISION.farmDemandM3Day
		});
		for (let t = 0; t < days; t++) {
			d[t] = netDailyDemandM3(
				gross[wy[t]!]!,
				cropped,
				rain[t]!,
				settings.effectiveRainFraction,
				WBT_PRECISION.netDemandM3Day
			);
		}
		return d;
	});
	if (anyArea && settings.apanMm.every((v) => v === 0)) {
		warnings.push('A-pan evaporation is 0 for every month, so irrigation demand is 0');
	}
	return out;
}
