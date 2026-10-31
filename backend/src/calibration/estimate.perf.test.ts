// The time estimate's envelope still bounds the engine (./estimate.ts): a fit
// evaluation, a model run and a whole server ensemble (its context, members
// and scoring), timed on this machine, against EVALUATION_US and RUN_US before
// WORKER_SLOWDOWN carries them to the worker. An engine change
// that makes a node-day dearer shows here as a ratio past 1, and the
// envelope (and the measurements in estimate.ts's header) then need
// re-deriving; otherwise the server would let through fits that overrun, and
// the job's deadline would fail them. Wall-clock, so the `perf` project: run
// alone (`pnpm test:backend:perf`), median of several runs. The envelope was
// measured on an AMD Ryzen 9 5900HX; a much slower machine fails here
// without any regression.
import { prepareCalibration, resolveEnsembleOptions, runEnsemble, runModel, type ModelInput } from '@water-management/engine';
import { randomInput, withUnitRain } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { build, EXAMPLES, inputOf, ORANJE } from '../../scripts/examples/catchments.js';
import { buildShowcase } from '../../scripts/examples/showcase.js';
import { ensembleSeconds, evaluationSeconds, modelSize, runSeconds, WORKER_SLOWDOWN } from './estimate.js';

const gr4j = (i: ModelInput): ModelInput => ({ ...i, settings: { ...i.settings, runoffModel: 'gr4j' } });
/** Median of `n` timed calls after two untimed warm-ups, in µs. */
function medianUs(n: number, f: () => void): number {
	f();
	f();
	const ms = Array.from({ length: n }, () => {
		const t = performance.now();
		f();
		return performance.now() - t;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]! * 1000;
}

const corpus: [string, ModelInput][] = [
	...[...EXAMPLES, ORANJE].map((s): [string, ModelInput] => [s.key, gr4j(inputOf(build(s, { fit: false })))]),
	['showcase', gr4j(inputOf(buildShowcase({ fit: false })))]
];
// Random networks of up to 40 nodes, every other one with per-unit rain: denser in transfers, dams and demand than any example.
for (let seed = 111; corpus.length < 18 && seed < 300; seed += 2) {
	const input = gr4j(withUnitRain(randomInput(seed, { maxNodes: 40, maxDays: 6000, baseflow: seed % 3 === 0 }), seed));
	// Only networks a fit can run on: a random one may have no usable record, which is no failure here.
	try {
		prepareCalibration(input);
	} catch {
		continue;
	}
	corpus.push([`random ${seed}`, input]);
}

describe('the time estimate’s envelope bounds the engine on this machine', () => {
	it('a fit evaluation and a model run, each well inside its envelope (median of 5)', () => {
		const worst = { evaluation: 0, run: 0 };
		for (const [name, input] of corpus) {
			const size = modelSize(input);
			const pb = prepareCalibration(input);
			const evaluation = medianUs(5, () => pb.simulate(pb.startParams)) / ((evaluationSeconds(size) / WORKER_SLOWDOWN) * 1e6);
			const run = medianUs(3, () => runModel(input)) / ((runSeconds(size) / WORKER_SLOWDOWN) * 1e6);
			console.log(`${name}: ${size.days} days, ${size.nodes} nodes: evaluation ${evaluation.toFixed(2)}, run ${run.toFixed(2)} of the envelope`);
			worst.evaluation = Math.max(worst.evaluation, evaluation);
			worst.run = Math.max(worst.run, run);
		}
		// Measured 2026-10-30: at most 0.75 (evaluations) and 0.72 (runs) over a wider corpus.
		expect(worst.evaluation).toBeLessThan(1);
		expect(worst.run).toBeLessThan(1);
	});

	it('a server ensemble of 30 members, context and scoring included, inside its estimate (one timing each)', () => {
		// Measured 2026-10-30 over 30 networks: at most 0.84 of the estimate, median 0.40.
		let worst = 0;
		for (const [name, input] of corpus.slice(0, 9)) {
			const { options } = resolveEnsembleOptions(input, { members: 30 });
			const t = performance.now();
			runEnsemble(input, options);
			const ratio = (performance.now() - t) / ((ensembleSeconds(options.members, modelSize(input)) / WORKER_SLOWDOWN) * 1000);
			console.log(`${name}: ensemble ${ratio.toFixed(2)} of the estimate`);
			worst = Math.max(worst, ratio);
		}
		expect(worst).toBeLessThan(1);
	});
});
