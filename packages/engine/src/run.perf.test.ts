// Wall-clock performance budgets for the client-catchment workbook regression
// fixture, split out of run.test.ts (docs/followups.md, "Wall-clock test
// flakes under load", 2026-09-24). Asserting a hard millisecond ceiling
// inside the default `pnpm test` run flakes under load — a busy laptop or
// three workspaces' suites running in parallel can push any single run over
// budget with no engine regression involved. This file is its own vitest
// project (`perf`, see vitest.config.ts): excluded from `pnpm test`, run
// serially via `pnpm test:engine:perf` / the root `pnpm test:engine:perf`,
// and takes the median of several runs so one slow sample doesn't decide it
// (the same technique backend/src/model/examples.perf.test.ts uses).
//
// Needs the gitignored `data/client-catchment` fixture (from
// scripts/wbt-import/extract_project.py); skips with a named placeholder
// test when absent, same as run.test.ts.
import { describe, expect, it } from 'vitest';
import { runModel, runModelWith } from './run';
import { loadClientCatchmentFixture } from './testing/client-catchment-fixture';

const fixture = await loadClientCatchmentFixture();

/** Median of `n` timed runs after one untimed warm-up. */
function medianMs(n: number, run: () => void): number {
	run();
	const ms = Array.from({ length: n }, () => {
		const t0 = performance.now();
		run();
		return performance.now() - t0;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]!;
}

describe.skipIf(!fixture)('runModel performance: client catchment (needs data/client-catchment)', () => {
	if (!fixture) {
		it('needs data/client-catchment', () => {});
		return;
	}
	const { modelInput, natural } = fixture;

	it('runs the full catchment record well under a second (median of 7)', () => {
		const ms = medianMs(7, () => {
			runModelWith(modelInput, () => ({ naturalFlowM3Day: natural }));
		});
		expect(ms).toBeLessThan(1000);
	});

	it('end to end with the rain model stays well under a second (median of 7)', () => {
		const withRainModel: typeof modelInput = { ...modelInput, settings: { ...modelInput.settings, chirpsBiasCorrection: 'none' } };
		const ms = medianMs(7, () => {
			runModel(withRainModel);
		});
		expect(ms).toBeLessThan(1000);
	});
});
