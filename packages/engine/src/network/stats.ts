// Goodness-of-fit of simulated outflow against an observed flow record.
import type { CalibrationStats } from '../project';

const SEC_PER_DAY = 86_400;

/**
 * NSE, PBIAS and RMSE over the days where an observation exists.
 *
 * - NSE   = 1 − Σ(obs − sim)² / Σ(obs − mean obs)²   (1 = perfect; null if obs is constant)
 * - PBIAS = 100 × Σ(obs − sim) / Σ obs               (%; positive = model under-estimates)
 * - RMSE  = √(Σ(obs − sim)² / n)                     (m³/s)
 *
 * @param simulatedM3Day simulated outflow, m³/day, aligned with `observedM3s`
 * @param observedM3s    observed flow, m³/s; null = missing
 */
export function calibrationStats(
	simulatedM3Day: ArrayLike<number>,
	observedM3s: ArrayLike<number | null>
): CalibrationStats {
	let n = 0;
	let sumObs = 0;
	let sumSim = 0;
	const len = Math.min(simulatedM3Day.length, observedM3s.length);
	for (let t = 0; t < len; t++) {
		const o = observedM3s[t];
		if (o === null || o === undefined || !Number.isFinite(o)) continue;
		n++;
		sumObs += o;
		sumSim += simulatedM3Day[t]! / SEC_PER_DAY;
	}
	if (n === 0) {
		return { days: 0, nse: null, pbias: null, rmseM3s: null, meanObservedM3s: null, meanSimulatedM3s: null };
	}
	const meanObs = sumObs / n;
	let sse = 0;
	let sst = 0;
	let diff = 0;
	for (let t = 0; t < len; t++) {
		const o = observedM3s[t];
		if (o === null || o === undefined || !Number.isFinite(o)) continue;
		const s = simulatedM3Day[t]! / SEC_PER_DAY;
		sse += (o - s) ** 2;
		sst += (o - meanObs) ** 2;
		diff += o - s;
	}
	return {
		days: n,
		nse: sst > 0 ? 1 - sse / sst : null,
		pbias: sumObs !== 0 ? (100 * diff) / sumObs : null,
		rmseM3s: Math.sqrt(sse / n),
		meanObservedM3s: meanObs,
		meanSimulatedM3s: sumSim / n
	};
}
