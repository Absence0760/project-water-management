// Regression tests for the calibration bug the engine end-to-end tests found (fixed
// in engine 1.69.0; erratum ER-22), asserting the behaviour docs/model.md specifies.
// Synthetic values only (the repo is public).
import { describe, expect, it } from 'vitest';
import { calibrationStats } from '../network/stats';
import { kgePrime } from '../calibrate/objective';

const SEC = 86_400;

describe('fixed in 1.69.0: the run statistics give no KGE for a flat simulated outflow (docs/model.md §2.10)', () => {
	// §2.10: "The benchmark that does carry over is the mean flow, which scores NSE 0 and KGE −0.41
	// (Knoben et al. 2019)", and the KGE row reads "> −0.41 beats the mean flow". calibrationStats
	// (network/stats.ts:166) sets r = null whenever the simulation has no variance, so KGE, r and R²
	// are null: the mean-flow benchmark has no KGE at all, and an outlet the network dries out
	// completely (simulated outflow 0 every day, the worst possible fit) shows "not computed"
	// instead of a very poor score. The fit's own KGE′ (calibrate/objective.ts pearson) already
	// scores a flat simulation with r = 0, as Knoben et al. do.
	const obs = [1, 3, 2, 8, 4, 0.5, 6, 2.5];
	const mean = obs.reduce((a, b) => a + b, 0) / obs.length;

	it('a simulation equal to the mean observed flow every day scores KGE = 1 − √2 (and NSE 0)', () => {
		const st = calibrationStats(
			obs.map(() => mean * SEC),
			obs
		);
		expect(st.nse!).toBeCloseTo(0, 12);
		expect(st.kge).not.toBeNull();
		expect(st.kge!).toBeCloseTo(1 - Math.SQRT2, 9);
		// Consistent with the fit's KGE′ of the same benchmark.
		expect(kgePrime(obs, obs.map(() => mean))!).toBeCloseTo(1 - Math.SQRT2, 9);
	});

	it('a simulated outflow of zero every day (a dried-out outlet) scores KGE = 1 − √3, not null', () => {
		const st = calibrationStats(
			obs.map(() => 0),
			obs
		);
		expect(st.kge).not.toBeNull();
		expect(st.kge!).toBeCloseTo(1 - Math.sqrt(3), 9);
	});
});
