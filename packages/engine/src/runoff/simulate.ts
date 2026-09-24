// Runs a daily RunoffModel over a run's forcing: builds rain and potential
// evaporation, warms the stores up, steps every day and converts mm to m³/day.
import { monthOfEpochDay, toEpochDay, waterYearIndex } from '../calendar';
import type { ProjectSettings } from '../project';
import { requireCatchmentAreaKm2 } from './area';
import { gr4j, GR4J_PARAMS, type Gr4jParams } from './gr4j';
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
 * dry (the run warns how many). PET: pan coefficient × A-pan for the month,
 * spread evenly over the month's days, so a month's PET totals exactly
 * coefficient × A-pan. Negative inputs count as 0.
 */
export function runoffForcing(settings: Pick<ProjectSettings, 'apanMm' | 'panCoefficient'>, ctx: Pick<RunContext, 'startDate' | 'days' | 'aligned'>): RunoffForcing {
	const { days } = ctx;
	const c = ctx.aligned('rain_catchment_mm');
	const ch = ctx.aligned('rain_chirps_mm');
	const f = ctx.aligned('rain_forecast_mm');
	const rainMm = new Float64Array(days);
	const petMm = new Float64Array(days);
	const d0 = toEpochDay(ctx.startDate);
	for (let t = 0; t < days; t++) {
		rainMm[t] = Math.max(0, c[t] ?? ch[t] ?? f[t] ?? 0);
		const wy = waterYearIndex(monthOfEpochDay(d0 + t));
		petMm[t] = Math.max(0, (settings.panCoefficient[wy]! * settings.apanMm[wy]!) / daysInMonth(d0 + t));
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
	opts: { warmupDays: number; fill?: number; trace?: boolean; days?: number }
): RunoffTrace {
	// The warm-up cycles the whole forcing; `days` (default all) cuts the output short.
	const len = forcing.rainMm.length;
	const n = Math.min(len, opts.days ?? len);
	const trace = opts.trace ?? true;
	const st = model.init(p, opts.fill);
	const day: DayFluxes = { qMm: 0, aetMm: 0, exchangeMm: 0 };
	const warm = len > 0 ? Math.max(0, Math.floor(opts.warmupDays)) : 0;
	for (let k = 0; k < warm; k++) model.step(p, st, forcing.rainMm[k % len]!, forcing.petMm[k % len]!, day);

	const qMm = new Float64Array(n);
	const aetMm = new Float64Array(trace ? n : 0);
	const exchangeMm = new Float64Array(trace ? n : 0);
	const stores = model.stores.map(() => new Float64Array(trace ? n : 0));
	const now = new Float64Array(model.stores.length);
	const storageStartMm = model.storage(st);
	for (let t = 0; t < n; t++) {
		model.step(p, st, forcing.rainMm[t]!, forcing.petMm[t]!, day);
		qMm[t] = day.qMm;
		if (!trace) continue;
		aetMm[t] = day.aetMm;
		exchangeMm[t] = day.exchangeMm;
		model.readStores(st, now);
		for (let j = 0; j < now.length; j++) stores[j]![t] = now[j]!;
	}
	return { qMm, aetMm, exchangeMm, stores, storageStartMm, storageEndMm: model.storage(st) };
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
	const areaKm2 = requireCatchmentAreaKm2(ctx.settings.calibration, input);
	const p = resolveParams<Gr4jParams>(GR4J_PARAMS, ctx.settings.gr4j, 'GR4J', warnings);
	const warmupDays = resolveWarmupDays(ctx.settings.gr4j?.warmupDays, warnings);
	const forcing = runoffForcing(ctx.settings, ctx);
	const tr = simulateRunoff(gr4j, p, forcing, { warmupDays });

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
	if (!ctx.settings.apanMm.some((v) => v > 0)) warnings.push('A-pan evaporation is 0 for every month, so GR4J runs with no evaporation');
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
			petMm: total(forcing.petMm),
			aetMm: total(tr.aetMm),
			flowMm: total(tr.qMm),
			exchangeMm: total(tr.exchangeMm),
			storageStartMm: tr.storageStartMm,
			storageEndMm: tr.storageEndMm
		}
	};
};
