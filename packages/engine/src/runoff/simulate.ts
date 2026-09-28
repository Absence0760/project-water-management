// Runs a daily RunoffModel over a run's forcing: builds rain and potential
// evaporation, warms the stores up, steps every day and converts mm to m³/day.
import { monthOfEpochDay, toEpochDay, waterYearIndex } from '../calendar';
import { apanDailyMm, hasDailyApanValue } from '../evaporation/apanDaily';
import { arealRainFactors, gr4jPeMonthlyMm, type ArealRain, type PeInput, type ProjectSettings } from '../project';
import { requireCatchmentAreaKm2 } from './area';
import { gr4j } from './gr4j';
import { GR4J_PARAMS, type Gr4jParams } from './params';
import { GR4J_NO_PET, hasPotentialEvaporation } from './pet';
import type { DayFluxes, NaturalFlowGenerator, ParamSpec, RunContext, RunoffModel } from './types';

/** Daily model drivers (mm/day). */
export interface RunoffForcing {
	rainMm: Float64Array;
	petMm: Float64Array;
}

/** A simulation's daily output. Stores are end-of-day contents, in the model's `stores` order. */
export interface RunoffTrace {
	qMm: Float64Array;
	aetMm: Float64Array;
	exchangeMm: Float64Array;
	stores: Float64Array[];
	storageStartMm: number;
	storageEndMm: number;
	/** saveState's numbers at the start of day `captureAt`, when asked. */
	captured?: number[];
}

/**
 * Days in the calendar month containing an epoch day. Real calendar days, not
 * settings.februaryDays (demand's 28.25): only then does each month's PET
 * total exactly coefficient × A-pan.
 */
function daysInMonth(day: number): number {
	const d = new Date(day * 86_400_000);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Rain: the first present of catchment, CHIRPS and forecast rain, no
 * threshold (the threshold was part of the legacy model); a day with none is
 * dry (the run warns how many). PET: the month's PE (`gr4jPeMonthlyMm`: pan
 * coefficient × A-pan, or `settings.pe`'s monthly row, issue #39), spread
 * evenly over the month's days, so a month's PET totals exactly that. Under
 * `pe.kind: 'pan'`, a day the daily A-pan series covers (engine ≥ 0.38.0,
 * issue #45) is pan coefficient × that day's A-pan instead. Negative inputs
 * count as 0. With `settings.arealRain` (engine ≥ 1.13.0, docs/model.md
 * §2.4g) each day's rain is × its water-year month's areal factor; demand
 * and the dams never read this rain.
 */
export function runoffForcing(
	settings: Pick<ProjectSettings, 'apanMm' | 'panCoefficient'> & { pe?: PeInput | null; arealRain?: ArealRain | null },
	ctx: Pick<RunContext, 'startDate' | 'days' | 'aligned'>
): RunoffForcing {
	const { days } = ctx;
	const c = ctx.aligned('rain_catchment_mm');
	const ch = ctx.aligned('rain_chirps_mm');
	const f = ctx.aligned('rain_forecast_mm');
	const rainMm = new Float64Array(days);
	const petMm = new Float64Array(days);
	const d0 = toEpochDay(ctx.startDate);
	const peMm = gr4jPeMonthlyMm(settings);
	// A monthly PE row replaces A-pan for GR4J altogether, the daily series too.
	const apan = settings.pe?.kind === 'monthly' ? null : apanDailyMm(ctx.aligned('evap_apan_mm'));
	// The areal rainfall correction (engine ≥ 1.13.0, §2.4g): runoff's rain only.
	const areal = arealRainFactors(settings.arealRain);
	for (let t = 0; t < days; t++) {
		const wy = waterYearIndex(monthOfEpochDay(d0 + t));
		rainMm[t] = Math.max(0, c[t] ?? ch[t] ?? f[t] ?? 0) * (areal ? areal[wy]! : 1);
		const a = apan ? apan[t]! : NaN;
		petMm[t] = a === a ? Math.max(0, (settings.panCoefficient[wy] ?? 0) * a) : Math.max(0, peMm[wy]! / daysInMonth(d0 + t));
	}
	return { rainMm, petMm };
}

/**
 * Step `model` over the forcing. The stores start at `fill` of capacity, then
 * run `warmupDays` days that cycle the forcing from its first day (day k of
 * the warm-up uses day k mod n); only the days after the warm-up are output.
 * With `trace` false only qMm is filled (the calibration fast path).
 */
export function simulateRunoff<P, S>(
	model: RunoffModel<P, S>,
	p: P,
	forcing: RunoffForcing,
	opts: {
		warmupDays: number;
		fill?: number;
		trace?: boolean;
		days?: number;
		/** Start from this saved state (model.saveState's numbers) instead of `fill` and the warm-up (engine ≥ 1.1.0). */
		initial?: readonly number[];
		/** Return the state at the start of this day (0 … days) as `captured`. */
		captureAt?: number;
	}
): RunoffTrace {
	// The warm-up cycles the whole forcing; `days` (default all) cuts the output short.
	const len = forcing.rainMm.length;
	const n = Math.min(len, opts.days ?? len);
	const trace = opts.trace ?? true;
	const needsState = opts.initial !== undefined || opts.captureAt !== undefined;
	if (needsState && (!model.saveState || !model.loadState)) throw new Error(`the ${model.id} runoff model can't save its state`);
	const st = opts.initial !== undefined ? model.loadState!(p, opts.initial) : model.init(p, opts.fill);
	const day: DayFluxes = { qMm: 0, aetMm: 0, exchangeMm: 0 };
	const warm = len > 0 && opts.initial === undefined ? Math.max(0, Math.floor(opts.warmupDays)) : 0;
	for (let k = 0; k < warm; k++) model.step(p, st, forcing.rainMm[k % len]!, forcing.petMm[k % len]!, day);
	let captured: number[] | undefined;

	const qMm = new Float64Array(n);
	const aetMm = new Float64Array(trace ? n : 0);
	const exchangeMm = new Float64Array(trace ? n : 0);
	const stores = model.stores.map(() => new Float64Array(trace ? n : 0));
	const now = new Float64Array(model.stores.length);
	const storageStartMm = model.storage(st);
	for (let t = 0; t < n; t++) {
		if (t === opts.captureAt) captured = model.saveState!(st);
		model.step(p, st, forcing.rainMm[t]!, forcing.petMm[t]!, day);
		qMm[t] = day.qMm;
		if (!trace) continue;
		aetMm[t] = day.aetMm;
		exchangeMm[t] = day.exchangeMm;
		model.readStores(st, now);
		for (let j = 0; j < now.length; j++) stores[j]![t] = now[j]!;
	}
	if (opts.captureAt === n) captured = model.saveState!(st);
	return { qMm, aetMm, exchangeMm, stores, storageStartMm, storageEndMm: model.storage(st), ...(captured ? { captured } : {}) };
}

/**
 * Parameters checked against their spec: a missing, non-numeric or
 * out-of-bounds value is replaced by the default, with a warning. (The backend
 * rejects such settings; this guards runs of older or hand-made inputs.)
 */
export function resolveParams<P>(specs: ParamSpec<P>[], raw: unknown, what: string, warnings: string[]): P {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const out: Record<string, number> = {};
	for (const s of specs) {
		const v = r[s.key];
		if (typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max) out[s.key] = v;
		else {
			if (v !== undefined) warnings.push(`${what} ${s.label} ${JSON.stringify(v)} is outside ${s.min}–${s.max} ${s.unit}; using ${s.default}`);
			out[s.key] = s.default;
		}
	}
	return out as P;
}

/** Warm-up length: whole days 0–3650, default 365. */
export function resolveWarmupDays(v: unknown, warnings: string[]): number {
	if (v === undefined) return 365;
	if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650) return v;
	warnings.push(`warm-up ${JSON.stringify(v)} days is not a whole number of days 0–3650; using 365`);
	return 365;
}

const MM_KM2_TO_M3 = 1000; // 1 mm over 1 km² = 1 000 m³

export const gr4jNaturalFlow: NaturalFlowGenerator = (input, ctx) => {
	const warnings: string[] = [];
	// With no evaporation the production store only fills, so nearly all rain
	// becomes flow: refuse, as a run with no rainfall is refused.
	if (!hasPotentialEvaporation(ctx.settings, hasDailyApanValue(ctx.aligned('evap_apan_mm')))) throw new Error(GR4J_NO_PET);
	const areaKm2 = requireCatchmentAreaKm2(ctx.settings.calibration, input);
	const p = resolveParams<Gr4jParams>(GR4J_PARAMS, ctx.settings.gr4j, 'GR4J', warnings);
	const warmupDays = resolveWarmupDays(ctx.settings.gr4j?.warmupDays, warnings);
	const forcing = runoffForcing(ctx.settings, ctx);
	const w = ctx.warm;
	const tr = simulateRunoff(gr4j, p, forcing, {
		warmupDays,
		...(w?.resume !== undefined ? { initial: w.resume } : {}),
		...(w?.captureAt !== undefined ? { captureAt: w.captureAt } : {})
	});

	const toM3 = areaKm2 * MM_KM2_TO_M3;
	const naturalFlowM3Day = Array.from(tr.qMm, (q) => q * toM3);
	const series = [
		{ key: 'rain_used', label: 'Rain used', unit: 'mm', values: Array.from(forcing.rainMm) },
		{ key: 'pet', label: 'Potential evaporation', unit: 'mm', values: Array.from(forcing.petMm) },
		{ key: 'aet', label: 'Actual evaporation', unit: 'mm', values: Array.from(tr.aetMm) },
		...gr4j.stores.map((s, j) => ({ key: s.key, label: s.label, unit: 'mm', values: Array.from(tr.stores[j]!) }))
	];
	if (p.x2 !== 0) series.push({ key: 'exchange', label: 'Groundwater exchange (+ gained / − lost)', unit: 'mm', values: Array.from(tr.exchangeMm) });

	const total = (a: Float64Array) => a.reduce((s, v) => s + v, 0);
	return {
		naturalFlowM3Day,
		series,
		warnings,
		balance: {
			model: 'gr4j',
			params: { ...p },
			warmupDays,
			areaKm2,
			rainMm: total(forcing.rainMm),
			...(ctx.settings.arealRain ? { arealRain: { ...structuredClone(ctx.settings.arealRain), rainBeforeMm: total(runoffForcing({ ...ctx.settings, arealRain: null }, ctx).rainMm) } } : {}),
			petMm: total(forcing.petMm),
			aetMm: total(tr.aetMm),
			flowMm: total(tr.qMm),
			exchangeMm: total(tr.exchangeMm),
			storageStartMm: tr.storageStartMm,
			storageEndMm: tr.storageEndMm
		},
		...(tr.captured ? { state: tr.captured } : {})
	};
};
