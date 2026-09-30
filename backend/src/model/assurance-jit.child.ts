// The child process of assurance-jit.perf.test.ts (issue #192): runs the
// Sandspruit example catchment through runModelChecked several times, under
// whatever V8 flags its parent starts it with, and prints one line of JSON per
// run: a hash of summary.supplyAssurance and the `assurance` self-check's
// result. Bundled by the test with esbuild and run with plain `node`, so the
// stress flags reach only the model, not a TypeScript loader.
import { createHash } from 'node:crypto';
import { forecastSplit, runModelChecked, withoutForecastTail } from '@water-management/engine';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';

export interface AssuranceJitRun {
	hash: string;
	/** The `assurance` self-check: null when the run has none. */
	passed: boolean | null;
	detail: string | null;
}

/** The input the parent and the child both run: Sandspruit, without a forecast tail, as a saved run. */
export function assuranceJitInput() {
	const ex = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'));
	if (!ex) throw new Error('the Sandspruit example is missing');
	const input = inputOf(ex);
	return withoutForecastTail(input, forecastSplit(input));
}

export function assuranceJitRun(input: ReturnType<typeof assuranceJitInput>): AssuranceJitRun {
	const out = runModelChecked(input);
	const check = out.summary.verification?.checks.find((c) => c.id === 'assurance');
	return {
		hash: createHash('sha256').update(JSON.stringify(out.summary.supplyAssurance)).digest('hex'),
		passed: check ? check.passed : null,
		detail: check?.detail ?? null
	};
}

// Run as a script (the bundle's entry), not when the test imports the helpers.
if (process.argv[1] && /assurance-jit\.child\.m?js$/.test(process.argv[1])) {
	const runs = Number(process.argv[2] ?? 6);
	const input = assuranceJitInput();
	for (let i = 0; i < runs; i++) process.stdout.write(`${JSON.stringify(assuranceJitRun(input))}\n`);
}
