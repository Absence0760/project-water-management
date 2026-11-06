// Calibration's verification against a reference gauge (docs/ui.md § Calibration → Verification against a reference
// gauge, docs/model.md § importing a reference gauge): a gauge on a neighbouring river (the project's
// `flow_reference_m3s` record), scaled by area to the outlet, beside the shown run's simulated and natural flow there.
// Verification only: no run reads the record, no fit scores it. The areas are settings.referenceGauge (no model
// input, backend projects/referenceGaugeSettings.ts). Pure, so it is unit-tested; ReferenceGaugeCheck.svelte is thin.
import { fromEpochDay, kgePrime, toEpochDay, type DailySeries } from '@water-management/engine';
import type { ReferenceGauge } from '#lib/api/types.js';

/** The record kind a reference gauge is stored as. */
export const REFERENCE_KIND = 'flow_reference_m3s';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const area = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** settings.referenceGauge, or null when absent or not valid (as the server's resolveReferenceGauge). */
export function resolveReferenceGauge(settings: { referenceGauge?: unknown } | null | undefined): ReferenceGauge | null {
	const r = settings?.referenceGauge;
	if (!isObj(r) || !area(r.areaKm2)) return null;
	return { areaKm2: r.areaKm2, targetAreaKm2: area(r.targetAreaKm2) ? r.targetAreaKm2 : null, name: typeof r.name === 'string' ? r.name.trim() : '' };
}

/** What the comparison calls the gauge: its name, else "the reference gauge". */
export const referenceName = (g: Pick<ReferenceGauge, 'name'> | null | undefined): string => g?.name?.trim() || 'the reference gauge';

/**
 * The model's catchment area at the outlet (km²) as a run read it: its own catchment area setting when set, else its
 * hydrological units' areas (the engine's resolveCatchmentAreaKm2, which uses the units' areas whenever any has land).
 * null when the run kept no model.
 */
export function modelCatchmentAreaKm2(
	model: { nodes?: readonly { kind: string; areaKm2?: number | null }[] } | null | undefined,
	calibration: { catchmentAreaKm2?: number | null } | null | undefined
): number | null {
	const nodes = model?.nodes;
	if (!nodes) return null;
	const units = nodes.filter((n) => n.kind === 'farm').reduce((s, n) => s + (n.areaKm2 && n.areaKm2 > 0 ? n.areaKm2 : 0), 0);
	if (units > 0) return units;
	const set = calibration?.catchmentAreaKm2;
	return set != null && set > 0 ? set : null;
}

/** The area factor (outlet area ÷ the reference gauge's), with where the outlet area came from; null without areas. */
export function areaFactor(g: ReferenceGauge | null, modelAreaKm2: number | null): { factor: number; targetKm2: number; refKm2: number; targetFrom: 'set' | 'model' } | null {
	if (!g) return null;
	const target = g.targetAreaKm2 ?? modelAreaKm2;
	if (!(target !== null && target > 0)) return null;
	return { factor: target / g.areaKm2, targetKm2: target, refKm2: g.areaKm2, targetFrom: g.targetAreaKm2 !== null ? 'set' : 'model' };
}

/** m³ a day per one of the record's units, or null for a unit it can't read. */
export function perDay(unit: string): number | null {
	const u = unit.replace(/\s/g, '').toLowerCase().replace('3', '³');
	if (u === 'm³/s') return 86_400;
	if (u === 'm³/day' || u === 'm³/d') return 1;
	if (u === 'ml/day' || u === 'ml/d') return 1_000;
	return null;
}

/** The record scaled to the outlet, in m³/day: × the area factor; a day with no reading stays null. */
export function scaledReference(rec: { startDate: string; unit: string; values: readonly (number | null)[] }, factor: number): DailySeries | null {
	const k = perDay(rec.unit);
	if (k === null) return null;
	return { startDate: rec.startDate, values: rec.values.map((v) => (v === null || !Number.isFinite(v) ? null : v * k * factor)) };
}

/** One model series against the scaled record, over the days both have a value. */
export interface VerificationRow {
	/** Days compared (both have a value, before any forecast). */
	days: number;
	from: string | null;
	to: string | null;
	/** KGE′ (Kling–Gupta 2012), the record as the observation; null when it can't be worked out (a flat or zero mean). */
	kge: number | null;
	/** Σ model ÷ Σ record − 1, %: positive = the model carries more water than the scaled record. */
	biasPct: number | null;
	/** Pearson correlation of the daily flows. */
	r: number | null;
}

function pearson(o: ArrayLike<number>, s: ArrayLike<number>): number | null {
	const n = o.length;
	if (n < 2) return null;
	let mo = 0;
	let ms = 0;
	for (let i = 0; i < n; i++) {
		mo += o[i]!;
		ms += s[i]!;
	}
	mo /= n;
	ms /= n;
	let cov = 0;
	let so = 0;
	let ss = 0;
	for (let i = 0; i < n; i++) {
		cov += (o[i]! - mo) * (s[i]! - ms);
		so += (o[i]! - mo) ** 2;
		ss += (s[i]! - ms) ** 2;
	}
	return so > 0 && ss > 0 ? cov / Math.sqrt(so * ss) : null;
}

/**
 * `model` against the scaled record `ref` (both m³/day, each from its own start date), on the days both have a finite
 * value, before `forecastFrom` (a forecast run's history only). Null when they share no day.
 */
export function verificationRow(ref: DailySeries, model: DailySeries, forecastFrom: string | null = null): VerificationRow | null {
	const r0 = toEpochDay(ref.startDate);
	const m0 = toEpochDay(model.startDate);
	const lo = Math.max(r0, m0);
	const hi = Math.min(r0 + ref.values.length, m0 + model.values.length, forecastFrom ? toEpochDay(forecastFrom) : Infinity);
	const o: number[] = [];
	const s: number[] = [];
	let first = -1;
	let last = -1;
	for (let d = lo; d < hi; d++) {
		const a = ref.values[d - r0];
		const b = model.values[d - m0];
		if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
		o.push(a);
		s.push(b);
		if (first < 0) first = d;
		last = d;
	}
	if (!o.length) return null;
	const so = o.reduce((x, v) => x + v, 0);
	const ss = s.reduce((x, v) => x + v, 0);
	return { days: o.length, from: fromEpochDay(first), to: fromEpochDay(last), kge: kgePrime(o, s), biasPct: so > 0 ? (ss / so - 1) * 100 : null, r: pearson(o, s) };
}

/** A month with fewer shared days than this is a gap in the monthly comparison, not a low value. */
export const MONTH_MIN_DAYS = 20;

/** One calendar month of the monthly comparison: each flow's volume (m³) over the days all of them have a value. */
export interface MonthVolumes {
	/** YYYY-MM. */
	month: string;
	/** Days every compared flow has a value (before any forecast). */
	days: number;
	daysInMonth: number;
	/** Volumes in m³ over those days; null when the month has fewer than MONTH_MIN_DAYS of them (a gap). */
	reference: number | null;
	simulated: number | null;
	natural: number | null;
}

/**
 * The scaled record and the model's flows (all m³/day) as monthly volumes, from the first to the last month their
 * spans share, counting only the days every flow given has a finite value (a flow not given, null, is left out of
 * that test and its volumes are null). A month with under `minDays` such days is a gap: every volume null.
 */
export function monthlyVolumes(
	ref: DailySeries,
	simulated: DailySeries | null,
	natural: DailySeries | null,
	forecastFrom: string | null = null,
	minDays = MONTH_MIN_DAYS
): MonthVolumes[] {
	const flows = [ref, simulated, natural];
	const starts = flows.map((f) => (f ? toEpochDay(f.startDate) : 0));
	let lo = -Infinity;
	let hi = forecastFrom ? toEpochDay(forecastFrom) : Infinity;
	flows.forEach((f, i) => {
		if (!f) return;
		lo = Math.max(lo, starts[i]!);
		hi = Math.min(hi, starts[i]! + f.values.length);
	});
	const out: MonthVolumes[] = [];
	if (!(hi > lo)) return out;
	let cur: { month: string; days: number; daysInMonth: number; sums: [number, number, number] } | null = null;
	const close = () => {
		if (!cur) return;
		const ok = cur.days >= minDays;
		const v = (i: number) => (ok && flows[i] ? cur!.sums[i]! : null);
		out.push({ month: cur.month, days: cur.days, daysInMonth: cur.daysInMonth, reference: v(0), simulated: v(1), natural: v(2) });
	};
	for (let d = lo; d < hi; d++) {
		const iso = fromEpochDay(d);
		const month = iso.slice(0, 7);
		if (!cur || cur.month !== month) {
			close();
			const [y, m] = month.split('-').map(Number) as [number, number];
			cur = { month, days: 0, daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(), sums: [0, 0, 0] };
		}
		const vals = flows.map((f, i) => (f ? f.values[d - starts[i]!] : undefined));
		if (vals.some((v, i) => flows[i] && (v === null || v === undefined || !Number.isFinite(v)))) continue;
		cur.days++;
		vals.forEach((v, i) => {
			if (flows[i]) cur!.sums[i as 0 | 1 | 2] += v as number;
		});
	}
	close();
	return out;
}

/** A volume unit for the monthly chart: million m³ when the largest month reaches one, else thousand m³. */
export function volumeUnit(rows: readonly MonthVolumes[]): { text: string; div: number } {
	let max = 0;
	for (const r of rows) for (const v of [r.reference, r.simulated, r.natural]) if (v !== null && v > max) max = v;
	return max >= 1e6 ? { text: 'million m³', div: 1e6 } : { text: 'thousand m³', div: 1e3 };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2021-10" → "Oct 2021". */
export const monthLabel = (ym: string): string => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1] ?? ym.slice(5, 7)} ${ym.slice(0, 4)}`;
