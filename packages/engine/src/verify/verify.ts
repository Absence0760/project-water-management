// What runModel reports about its own output (engine ≥ 0.12.0):
// - verification: the invariant checks of ./checks.ts, each run on its own
//   so one failure doesn't hide another, with node ids and day numbers turned
//   into names and dates a user can look up;
// - waterBalance: where the water went, per water year and over the run.
// Pure: it reads only the model input and the output's own series.
import { fromEpochDay, toEpochDay } from '../calendar';
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
import { checkBalance, checkReportTotals, checkRunoffBalance, checkTransferLimits, checkWorkings } from './checks';

const CHECKS: [VerificationCheckId, string, (input: ModelInput, out: ModelOutput) => string | null][] = [
	['balance', 'Every farm balances every day, storage stays within the dam, supply stays within demand', checkBalance],
	['workings', 'The intermediate columns follow their formulas (the daily farm CSV)', checkWorkings],
	['runoff', 'The runoff model balances: rain − evaporation − flow + exchange = change in storage', checkRunoffBalance],
	['transfers', 'Transfers stay within their months, rates, daily caps and minimum storage', checkTransferLimits],
	['reports', 'The EWR grid, farm summaries and curtailment report add up to the daily series', checkReportTotals]
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
	// The catchment's rain after gap-filling, before any model threshold; the
	// legacy model's rain_used has rain at or below the threshold zeroed.
	const rain = cat('rain_final') ?? cat('rain_used');
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
	const [fRunoff, fDemand, fSupplied, fReturn, fTransfer, fSpill, fStorage] = ['runoff', 'demand', 'supplied', 'return_flow', 'transfer', 'spill', 'dam_storage'].map(totals) as Float64Array[];
	const initialStorage = farms.reduce((s, n) => s + n.damInitialPct * n.damCapacityM3, 0);
	const farmStorage = (t: number) => (t < 0 ? initialStorage : fStorage![t]!);

	const row = (waterYear: number | null, from: number, to: number): WaterBalanceRow => {
		let rainMm = 0;
		let rainDays = 0;
		let modelRainMm = 0;
		const r = { natural: 0, runoff: 0, demand: 0, supplied: 0, ret: 0, transfer: 0, spill: 0, outflow: 0, aet: 0, ex: 0 };
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
			spillM3: r.spill,
			outflowM3: r.outflow,
			closingStorageM3: closing,
			residualM3: opening + r.runoff + r.transfer - consumptive - r.outflow - closing
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
