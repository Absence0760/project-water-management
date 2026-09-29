// What runModel reports about its own output (engine ≥ 0.12.0):
// - verification: the invariant checks of ./checks.ts, each run on its own
//   so one failure doesn't hide another, with node ids and day numbers turned
//   into names and dates a user can look up;
// - waterBalance: where the water went, per water year and over the run.
// Pure: it reads only the model input and the output's own series.
import { fromEpochDay, toEpochDay } from '../calendar';
import { capacityScaleOf } from '../network/development';
import {
	upgradeLegacyModel,
	type ModelInput,
	type ModelOutput,
	type RunVerification,
	type VerificationCheck,
	type VerificationCheckId,
	type WaterBalance,
	type WaterBalanceRow
} from '../project';
import { checkAllocations, checkBalance, checkEwrAttribution, checkGroundwater, checkLandCover, checkReportTotals, checkRunoffBalance, checkSoilWater, checkTransferLimits, checkWorkings } from './checks';

const CHECKS: [VerificationCheckId, string, (input: ModelInput, out: ModelOutput) => string | null][] = [
	['balance', 'Every farm balances every day, storage stays within the dam, supply stays within demand', checkBalance],
	['workings', 'The intermediate columns follow their formulas (the daily farm CSV)', checkWorkings],
	['soilWater', 'Each farm’s soil-water store stays between empty and full and hands out no more effective rain than fell', checkSoilWater],
	['runoff', 'The runoff model balances: rain − evaporation − flow + exchange = change in storage', checkRunoffBalance],
	['transfers', 'Transfers stay within their months, rates, daily caps and minimum storage; river off-takes within their capacity and the flow above what they must leave', checkTransferLimits],
	['reports', 'The EWR grid, farm summaries and curtailment report add up to the daily series', checkReportTotals],
	['ewrAttribution', 'Each EWR site’s shortfall splits exactly into the part charged to the farms upstream (pro rata to their net impact, never more than a farm took) and the natural part', checkEwrAttribution],
	['groundwater', 'Boreholes pump within their capacity, and the stream depletion they cause is lagged without losing or making water and never takes the river below 0', checkGroundwater],
	['landCover', 'Land cover removes no more than each farm’s natural runoff, by its low-flow and MAR reductions, and the catchment total adds up', checkLandCover],
	['allocations', 'Registered volumes: a cap is never exceeded in a water year, a full allocation’s demand adds up to the registered volume, and the run’s allocation summary matches its own series', checkAllocations]
];

export function verifyRun(raw: ModelInput, out: ModelOutput, areaKm2: number | null = null): { verification: RunVerification; waterBalance: WaterBalance } {
	// Read the model as the run did (runModel upgrades a model saved by an older engine).
	const input = { ...raw, model: upgradeLegacyModel(raw.model) };
	const names = new Map(input.model.nodes.map((n) => [n.id, n.name]));
	const d0 = toEpochDay(out.startDate);
	// "<uuid> day 12" → "Farm A on 2001-10-13", so the detail points at something the user can open.
	const humanize = (text: string) => {
		let t = text.replace(/\bday (\d+)\b/g, (_, d: string) => `on ${fromEpochDay(d0 + Number(d))}`);
		for (const [id, name] of names) t = t.replace(new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), () => `"${name}"`);
		return t;
	};
	const checks: VerificationCheck[] = CHECKS.map(([id, label, fn]) => {
		let detail: string | null;
		try {
			detail = fn(input, out);
		} catch (e) {
			// A check that can't run hasn't passed: report why instead of dropping it.
			detail = `the check could not run: ${e instanceof Error ? e.message : String(e)}`;
		}
		return { id, label, passed: detail === null, detail: detail === null ? null : humanize(detail) };
	});
	return {
		verification: { passed: checks.every((c) => c.passed), checks, maxResidual: maxResidual(input, out) },
		waterBalance: waterBalance(input, out, areaKm2)
	};
}

function maxResidual(input: ModelInput, out: ModelOutput): RunVerification['maxResidual'] {
	let best: RunVerification['maxResidual'] = null;
	let bestT = 0;
	for (const s of out.series) {
		if (s.key !== 'balance_residual' || !s.nodeId) continue;
		for (let t = 0; t < s.values.length; t++) {
			const v = Math.abs(s.values[t]!);
			if (best === null || v > best.valueM3Day) {
				best = { valueM3Day: v, nodeId: s.nodeId, name: '', date: '' };
				bestT = t;
			}
		}
	}
	if (best) {
		best.name = input.model.nodes.find((n) => n.id === best!.nodeId)?.name ?? best.nodeId;
		best.date = fromEpochDay(toEpochDay(out.startDate) + bestT);
	}
	return best;
}

/** Water year (Oct–Sep) of an ISO date, by its start year. */
const waterYearOf = (iso: string) => {
	const y = Number(iso.slice(0, 4));
	return Number(iso.slice(5, 7)) >= 10 ? y : y - 1;
};

function waterBalance(input: ModelInput, out: ModelOutput, areaKm2: number | null): WaterBalance {
	const series = new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	const cat = (k: string) => series.get(`null|${k}`);
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const farm = (id: string, k: string) => series.get(`${id}|${k}`) ?? [];
	const area = areaKm2 && areaKm2 > 0 ? areaKm2 : (out.summary.runoff?.areaKm2 ?? null);
	// The catchment's rain after gap-filling, and after the areal rainfall correction when the run has one (engine ≥ 1.13.0).
	const rain = cat('rain_areal') ?? cat('rain_final') ?? cat('rain_used');
	const rainUsed = cat('rain_used');
	const natural = cat('natural_flow') ?? [];
	const outflow = cat('simulated_outflow') ?? [];
	const aet = cat('aet');
	const exchange = cat('exchange');
	const stores = ['production_store', 'routing_store', 'uh_store'].map(cat);
	const hasStores = !!out.summary.runoff && !!aet && stores.every(Boolean);
	const storeSum = (t: number) => (t < 0 ? out.summary.runoff!.storageStartMm : stores.reduce((s, x) => s + x![t]!, 0));
	// Σ over farms of each daily column, once, so the per-year sums are plain array reads.
	const totals = (k: string) => {
		const a = new Float64Array(out.days);
		for (const n of farms) {
			const v = farm(n.id, k);
			for (let t = 0; t < out.days; t++) a[t]! += v[t] ?? 0;
		}
		return a;
	};
	const [fRunoff, fDemand, fSupplied, fReturn, fTransfer, fSpill, fStorage, fRainOnDam, fEvap] = ['runoff', 'demand', 'supplied', 'return_flow', 'transfer', 'spill', 'dam_storage', 'rain_on_dam', 'dam_evaporation'].map(totals) as Float64Array[];
	// Runs before engine 0.16.0 have no dam evaporation columns (audit N2).
	const hasDamLosses = farms.some((n) => series.has(`${n.id}|dam_evaporation`));
	// Other water users' consumptive use (WP-1.33): taken − returned, per day.
	const users = input.model.nodes.filter((n) => n.kind === 'user');
	const userUse = new Float64Array(out.days);
	for (const n of users) {
		const g = farm(n.id, 'supplied');
		const r = farm(n.id, 'return_flow');
		for (let t = 0; t < out.days; t++) userUse[t]! += (g[t] ?? 0) - (r[t] ?? 0);
	}
	// Boreholes (WP-1.34, WP-3.9), farms and other users: groundwater into supply
	// and into the dams, stream depletion out of the river.
	const gwNodes = input.model.nodes.filter((n) => series.has(`${n.id}|groundwater_used`));
	const gwIn = new Float64Array(out.days);
	const depOut = new Float64Array(out.days);
	for (const n of gwNodes) {
		const g = farm(n.id, 'groundwater_used');
		const gd = farm(n.id, 'groundwater_to_dam');
		const d = farm(n.id, 'baseflow_depletion');
		for (let t = 0; t < out.days; t++) {
			gwIn[t]! += (g[t] ?? 0) + (gd[t] ?? 0);
			depOut[t]! += d[t] ?? 0;
		}
	}
	// Dam seepage lost from the catchment and dam releases (WP-3.5): only on dams that have them.
	const seepLostNodes = farms.filter((n) => series.has(`${n.id}|dam_seepage_lost`));
	const releaseNodes = farms.filter((n) => series.has(`${n.id}|dam_release`));
	const [fSeepLost, fRelease] = ['dam_seepage_lost', 'dam_release'].map(totals) as Float64Array[];
	// Land cover (WP-1.35): natural flow removed before it reached the farms.
	const coverRed = cat('landcover_reduction');
	// The storage reset's steps (engine ≥ 0.46.0, settings.damStorageReset), over the farms that have one; null without.
	const setNodes = farms.filter((n) => series.has(`${n.id}|dam_storage_set`));
	const fSet = setNodes.length ? totals('dam_storage_set') : null;
	// River off-takes (engine ≥ 1.14.0): what they took less what arrived is lost on the way (conveyance losses).
	const hasOfftakes = farms.some((n) => series.has(`${n.id}|offtake_out`));
	const [fOtOut, fOtIn] = hasOfftakes ? (['offtake_out', 'offtake_in'].map(totals) as Float64Array[]) : [null, null];
	// A dam whose capacity changes (engine ≥ 1.28.0) starts at its share of the first day's capacity.
	const initialStorage = farms.reduce((s, n) => s + n.damInitialPct * n.damCapacityM3 * (capacityScaleOf(n, toEpochDay(out.startDate), out.days, [])?.[0] ?? 1), 0);
	const farmStorage = (t: number) => (t < 0 ? initialStorage : fStorage![t]!);

	const row = (waterYear: number | null, from: number, to: number): WaterBalanceRow => {
		let rainMm = 0;
		let rainDays = 0;
		let modelRainMm = 0;
		const r = { set: 0, natural: 0, runoff: 0, demand: 0, supplied: 0, ret: 0, transfer: 0, spill: 0, outflow: 0, aet: 0, ex: 0, rainOnDams: 0, evap: 0, otherUse: 0, gw: 0, dep: 0, cover: 0, seepLost: 0, release: 0, conveyance: 0 };
		for (let t = from; t <= to; t++) {
			if (rain && Number.isFinite(rain[t]!)) {
				rainMm += rain[t]!;
				rainDays++;
			}
			r.natural += natural[t] ?? 0;
			r.outflow += outflow[t] ?? 0;
			r.runoff += fRunoff![t]!;
			r.demand += fDemand![t]!;
			r.supplied += fSupplied![t]!;
			r.ret += fReturn![t]!;
			r.transfer += fTransfer![t]!;
			r.spill += fSpill![t]!;
			r.rainOnDams += fRainOnDam![t]!;
			r.evap += fEvap![t]!;
			r.otherUse += userUse[t]!;
			r.gw += gwIn[t]!;
			r.dep += depOut[t]!;
			r.cover += coverRed?.[t] ?? 0;
			r.seepLost += fSeepLost![t]!;
			r.release += fRelease![t]!;
			if (fSet) r.set += fSet[t]!;
			if (fOtOut) r.conveyance += fOtOut[t]! - fOtIn![t]!;
			if (hasStores) {
				modelRainMm += rainUsed?.[t] ?? 0;
				r.aet += aet![t]!;
				r.ex += exchange?.[t] ?? 0;
			}
		}
		const opening = farmStorage(from - 1);
		const closing = farmStorage(to);
		const consumptive = r.supplied - r.ret;
		const hasRain = !!rain && rainDays > 0;
		const naturalFlowMm = area ? r.natural / (area * 1000) : null;
		let runoff: WaterBalanceRow['runoff'] = null;
		if (hasStores) {
			const storageChangeMm = storeSum(to) - storeSum(from - 1);
			runoff = { aetMm: r.aet, exchangeMm: r.ex, storageChangeMm, residualMm: modelRainMm - r.aet - (naturalFlowMm ?? 0) + r.ex - storageChangeMm };
		}
		return {
			waterYear,
			days: to - from + 1,
			rainMm: hasRain ? rainMm : null,
			naturalFlowMm,
			runoffCoefficient: hasRain && naturalFlowMm !== null && rainMm > 0 ? naturalFlowMm / rainMm : null,
			runoff,
			naturalFlowM3: r.natural,
			farmRunoffM3: r.runoff,
			openingStorageM3: opening,
			demandM3: r.demand,
			suppliedM3: r.supplied,
			returnFlowM3: r.ret,
			consumptiveUseM3: consumptive,
			transfersM3: r.transfer,
			...(hasDamLosses ? { rainOnDamsM3: r.rainOnDams, damEvaporationM3: r.evap } : {}),
			...(users.length ? { otherUseM3: r.otherUse } : {}),
			...(gwNodes.length ? { groundwaterM3: r.gw, streamDepletionM3: r.dep } : {}),
			...(fSet ? { storageSetM3: r.set } : {}),
			...(coverRed ? { landCoverReductionM3: r.cover } : {}),
			...(seepLostNodes.length ? { damSeepageLostM3: r.seepLost } : {}),
			...(releaseNodes.length ? { damReleaseM3: r.release } : {}),
			...(hasOfftakes ? { conveyanceLossM3: r.conveyance } : {}),
			spillM3: r.spill,
			outflowM3: r.outflow,
			closingStorageM3: closing,
			residualM3: (fSet ? opening + r.runoff + r.transfer + r.rainOnDams + r.gw + r.set : opening + r.runoff + r.transfer + r.rainOnDams + r.gw) - consumptive - r.evap - r.otherUse - r.dep - r.seepLost - r.conveyance - r.outflow - closing
		};
	};

	const years: WaterBalanceRow[] = [];
	const d0 = toEpochDay(out.startDate);
	let from = 0;
	let wy = waterYearOf(fromEpochDay(d0));
	for (let t = 1; t <= out.days; t++) {
		const next = t < out.days ? waterYearOf(fromEpochDay(d0 + t)) : NaN;
		if (next !== wy) {
			years.push(row(wy, from, t - 1));
			from = t;
			wy = next;
		}
	}
	return { areaKm2: area, years, total: row(null, 0, Math.max(0, out.days - 1)) };
}
