// Forecast mode's invariants (WP-2.12, ../forecast.ts, model.md § Forecast
// mode). The plan's "prefix stability": a run with a forecast tail and a run
// without it give identical historical series and summaries up to
// forecastFrom − 1.
import { fromEpochDay, toEpochDay } from '../calendar';
import { forecastSplit, runForecastChecked, withoutForecastTail } from '../forecast';
import type { ModelInput, ModelOutput } from '../project';
import { Rng } from '../random';
import { RAIN_SOURCE_CODE } from '../rainSourcePeriods';
import { runModelChecked } from '../run';

/**
 * The input with a forecast tail: `rain_forecast_mm` over the `days` after the
 * last day of the observed rain series (catchment, CHIRPS), replacing any
 * forecast it had, and no simulationEnd (so the run reaches the tail). Some
 * draws also overlap the record by a few days (the forecast must not win
 * there) or leave a gap of dry days before the tail.
 */
export function withForecastTail(input: ModelInput, seed: number, days = 14): ModelInput {
	const rng = new Rng(seed * 7919 + 17);
	const x = structuredClone(input);
	let last = -Infinity;
	for (const k of ['rain_catchment_mm', 'rain_chirps_mm'] as const) {
		const s = x.series[k];
		if (s && s.values.length) last = Math.max(last, toEpochDay(s.startDate) + s.values.length - 1);
	}
	if (!Number.isFinite(last)) return x;
	const shape = rng.pick(['after', 'after', 'overlap', 'gap'] as const);
	const offset = shape === 'overlap' ? -rng.int(1, 5) : shape === 'gap' ? rng.int(2, 6) : 1;
	const len = days + (offset < 1 ? 1 - offset : 0);
	const values = Array.from({ length: len }, () => (rng.bool(0.6) ? 0 : rng.bool(0.1) ? null : rng.logFloat(0.1, 80)));
	x.series.rain_forecast_mm = { startDate: fromEpochDay(last + offset), values };
	x.settings = { ...x.settings, simulationEnd: null };
	return x;
}

/** Two series to the bit (NaN equals NaN; so do 0 and −0). */
function firstDifference(a: readonly number[], b: readonly number[], n: number): number {
	for (let t = 0; t < n; t++) if (a[t] !== b[t] && !(Number.isNaN(a[t]) && Number.isNaN(b[t]))) return t;
	return -1;
}

/**
 * The first summary figure (by key) that differs between two runs, with both
 * values cut to 300 characters, or null when every figure but `forecast`,
 * `forecastRain` and `warnings` is the same. Names the key so a failure in CI,
 * where only the message survives, says which figure moved.
 */
export function summaryDifference(a: ModelOutput, b: ModelOutput): string | null {
	const skip = new Set(['forecast', 'forecastRain', 'warnings']);
	const keys = new Set([...Object.keys(a.summary), ...Object.keys(b.summary)]);
	for (const k of keys) {
		if (skip.has(k)) continue;
		const x = JSON.stringify((a.summary as unknown as Record<string, unknown>)[k]) ?? 'undefined';
		const y = JSON.stringify((b.summary as unknown as Record<string, unknown>)[k]) ?? 'undefined';
		if (x === y) continue;
		let i = 0;
		while (i < x.length && x[i] === y[i]) i++;
		const cut = (v: string) => v.slice(Math.max(0, i - 100), i + 200).slice(0, 300);
		return `summary.${k} differs from character ${i}: …${cut(x)} vs …${cut(y)}`;
	}
	return null;
}

/**
 * Forecast mode keeps history apart from the forecast:
 * - without a forecast tail, runForecastChecked is runModelChecked plus
 *   `forecastFrom: null` (a project without a forecast is unchanged);
 * - with one, forecastFrom is the first forecast-sourced day after the last
 *   observed rain day;
 * - **prefix stability**: every series of the run without the tail
 *   (withoutForecastTail, what an ordinary run uses) equals the forecast
 *   run's up to forecastFrom − 1, to the bit, and so does an ordinary run
 *   of the input with the tail, which passes its own self-checks (the model
 *   is causal across it, engine ≥ 1.28.0, engine-audit.md K1), and every
 *   summary figure but
 *   `forecast`, `forecastRain` and `warnings` is the same (the warnings
 *   only gain the tail run's failed self-checks);
 * - summary.forecast covers exactly the tail days, its counts fit in them,
 *   and its fractions are in range.
 */
export function checkForecastPrefix(input: ModelInput): string | null {
	let out: ModelOutput;
	try {
		out = runForecastChecked(input);
	} catch (e) {
		// An input the model itself refuses (a simulation start after the last
		// data, say) must be refused the same way, not as a forecast problem.
		const own = (() => {
			try {
				runModelChecked(input);
				return null;
			} catch (f) {
				return (f as Error).message;
			}
		})();
		return own === (e as Error).message ? null : `forecast mode threw: ${(e as Error).message}${own ? '' : ' (runModel ran)'}`;
	}
	const split = forecastSplit(input);
	if (!split.forecastFrom) {
		const plain = runModelChecked(input);
		if (out.forecastFrom !== null) return `forecastFrom ${out.forecastFrom} without a forecast tail`;
		if (JSON.stringify({ ...out, forecastFrom: undefined }) !== JSON.stringify(plain)) return 'forecast mode without a tail differs from runModelChecked';
		return null;
	}
	if (out.forecastFrom !== split.forecastFrom) return `forecastFrom ${out.forecastFrom} vs split ${split.forecastFrom}`;
	const cut = toEpochDay(split.forecastFrom) - toEpochDay(out.startDate);
	if (!(cut > 0 && cut < out.days)) return `forecastFrom ${split.forecastFrom} outside the run ${out.startDate}…${out.endDate}`;
	if (split.source[cut] !== RAIN_SOURCE_CODE.forecast) return `forecastFrom ${split.forecastFrom} is not a forecast-rain day`;
	for (let t = cut; t < split.source.length; t++) {
		const c = split.source[t]!;
		if (!Number.isNaN(c) && c !== RAIN_SOURCE_CODE.forecast) return `day ${fromEpochDay(toEpochDay(out.startDate) + t)} after forecastFrom has observed rain (source ${c})`;
	}

	const hist = runModelChecked(withoutForecastTail(input, split));
	if (hist.startDate !== out.startDate || hist.days !== cut) return `the run without the tail spans ${hist.startDate} + ${hist.days} days, expected ${out.startDate} + ${cut}`;
	const byKey = new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	for (const s of hist.series) {
		const f = byKey.get(`${s.nodeId}|${s.key}`);
		if (!f) return `prefix stability: series ${s.nodeId}|${s.key} missing from the forecast run`;
		const t = firstDifference(s.values, f, cut);
		if (t >= 0) return `prefix stability: ${s.nodeId}|${s.key} on ${fromEpochDay(toEpochDay(out.startDate) + t)}: ${s.values[t]} vs ${f[t]}`;
	}
	// The model is causal across a forecast tail (engine ≥ 1.28.0, engine-audit.md K1): an
	// ordinary run of the input with the tail has the same series on every shared day.
	const ordinary = runModelChecked(input);
	const failed = ordinary.summary.verification?.checks.find((c) => !c.passed);
	if (failed) return `the ordinary run with the tail fails its self-check ${failed.id}: ${failed.detail}`;
	const plain = new Map(ordinary.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	for (const s of hist.series) {
		const f = plain.get(`${s.nodeId}|${s.key}`);
		if (!f) return `causality: series ${s.nodeId}|${s.key} missing from the run with the tail`;
		const t = firstDifference(s.values, f, cut);
		if (t >= 0) return `causality: ${s.nodeId}|${s.key} on ${fromEpochDay(toEpochDay(out.startDate) + t)}: ${s.values[t]} vs ${f[t]} with the tail`;
	}
	const summaryDiff = summaryDifference(out, hist);
	if (summaryDiff) return `prefix stability: the summaries differ: ${summaryDiff}`;
	const extra = out.summary.warnings.filter((w) => !hist.summary.warnings.includes(w));
	if (extra.some((w) => !w.startsWith('self-check failed on the run with the forecast tail'))) return `unexpected warnings: ${extra.join(' | ')}`;

	const f = out.summary.forecast;
	if (!f) return 'no summary.forecast on a run with a forecast tail';
	if (f.from !== split.forecastFrom || f.to !== out.endDate || f.days !== out.days - cut) return `summary.forecast spans ${f.from}…${f.to} (${f.days} days)`;
	if (f.lastObserved !== split.lastObserved || !(f.lastObserved < f.from)) return `summary.forecast.lastObserved ${f.lastObserved}`;
	if (!(f.outletEwrDaysAtRisk >= 0 && f.outletEwrDaysAtRisk <= f.days)) return `outletEwrDaysAtRisk ${f.outletEwrDaysAtRisk} of ${f.days}`;
	for (const p of f.perFarm) {
		if (!(p.deficitDays >= 0 && p.deficitDays <= f.days)) return `${p.nodeId}: deficitDays ${p.deficitDays} of ${f.days}`;
		if (p.minDamPct !== null && !(p.minDamPct >= -1e-9 && p.minDamPct <= 1 + 1e-9)) return `${p.nodeId}: minDamPct ${p.minDamPct}`;
		if (p.suppliedFraction !== null && !(p.suppliedFraction >= -1e-9 && p.suppliedFraction <= 1 + 1e-9)) return `${p.nodeId}: suppliedFraction ${p.suppliedFraction}`;
		if (p.suppliedFraction === null && p.demandM3 > 0) return `${p.nodeId}: suppliedFraction null with demand`;
	}
	return null;
}
