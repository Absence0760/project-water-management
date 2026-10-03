// End to end on random networks (testing/fuzz.ts randomInput: records with
// gaps, windows, exclusions, mid-year starts): the run's calibration
// statistics (docs/model.md §2.10) recomputed by hand from the run's own
// `observed_flow` and `simulated_outflow` series. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { excludedDayMask, exclusionRanges } from '../calibrate/provenance';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';

describe('run calibration statistics on random networks match the textbook formulas (§2.10)', () => {
	it('days, NSE, KGE (Gupta 2009), PBIAS and log-NSE on 200 seeds', () => {
		let checked = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const input = randomInput(seed);
			let out;
			try {
				out = runModel(input);
			} catch {
				continue;
			}
			const cal = out.summary.calibration;
			if (!cal || cal.siteNodeId) continue;
			const obs = out.series.find((s) => s.key === 'observed_flow' && s.nodeId === null)?.values;
			if (!obs) continue;
			const sim = out.series.find((s) => s.key === 'simulated_outflow' && s.nodeId === null)!.values;
			const d0 = toEpochDay(out.startDate);
			// The window as the run resolved it (an inverted one is dropped with a warning); no overlap = nothing scored.
			if (input.settings.calibrationStart && input.settings.calibrationEnd && !cal.windowStart) {
				expect(cal.days, `seed ${seed}`).toBe(0);
				continue;
			}
			const lo = cal.windowStart ? toEpochDay(cal.windowStart) - d0 : 0;
			const hi = cal.windowEnd ? toEpochDay(cal.windowEnd) - d0 : obs.length - 1;
			const ex = excludedDayMask(exclusionRanges((input.settings.calibrationExclusions ?? []) as never), out.startDate, obs.length);
			const o: number[] = [];
			const s: number[] = [];
			for (let t = lo; t <= hi; t++) {
				const v = obs[t]!;
				if (!Number.isFinite(v) || ex[t]) continue;
				o.push(v / 86_400);
				s.push(sim[t]! / 86_400);
			}
			expect(cal.days, `seed ${seed}`).toBe(o.length);
			checked++;
			if (o.length < 2) continue;
			const n = o.length;
			const mo = o.reduce((a, b) => a + b, 0) / n;
			const ms = s.reduce((a, b) => a + b, 0) / n;
			let sse = 0;
			let sst = 0;
			let cov = 0;
			let vs = 0;
			for (let i = 0; i < n; i++) {
				sse += (o[i]! - s[i]!) ** 2;
				sst += (o[i]! - mo) ** 2;
				cov += (o[i]! - mo) * (s[i]! - ms);
				vs += (s[i]! - ms) ** 2;
			}
			const tol = (x: number) => 1e-6 * Math.max(1, Math.abs(x));
			if (sst > 0) expect(Math.abs(cal.nse! - (1 - sse / sst)), `seed ${seed} NSE`).toBeLessThan(tol(1 - sse / sst));
			else expect(cal.nse).toBeNull();
			if (mo > 0) {
				expect(Math.abs(cal.pbias! - (100 * (mo - ms)) / mo), `seed ${seed} PBIAS`).toBeLessThan(tol((100 * (mo - ms)) / mo));
				if (sst > 0 && vs > 0) {
					const r = cov / Math.sqrt(sst * vs);
					const kge = 1 - Math.sqrt((r - 1) ** 2 + (Math.sqrt(vs / sst) - 1) ** 2 + (ms / mo - 1) ** 2);
					expect(Math.abs(cal.kge! - kge), `seed ${seed} KGE`).toBeLessThan(tol(kge));
				}
			}
		}
		expect(checked).toBeGreaterThan(100);
	}, 120_000);
});
