// Wall-clock performance budget for a GR4J run of an example catchment,
// split out of examples.invariants.test.ts (docs/followups.md, "Wall-clock
// test flakes under load", 2026-09-24; issue #4 phase 2). Asserting a hard
// millisecond ceiling inside the default `pnpm test` run flakes under load —
// three workspaces' suites running in parallel, or a busy laptop, can push
// any single run over budget with no engine regression involved. This file
// is its own vitest project (`perf`, see vitest.workspace.ts): excluded from
// `pnpm test`, run serially via `pnpm test:perf` / the root
// `pnpm test:backend:perf`.
import { resolveEnsembleOptions, runEnsemble, runModel, verifyEnsemble } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';

const examples = buildExamples({ fit: false });

describe('engine performance on the example catchments', () => {
	it('a GR4J run of an example catchment takes under 50 ms (issue #4 phase 2)', () => {
		const input = inputOf(examples[0]!);
		input.settings = { ...input.settings, runoffModel: 'gr4j' };
		// Median of 7 after a warm-up run, so one slow run on a busy machine doesn't decide it.
		runModel(input);
		const ms = Array.from({ length: 7 }, () => {
			const t = performance.now();
			runModel(input);
			return performance.now() - t;
		}).sort((a, b) => a - b);
		expect(ms[3]).toBeLessThan(50);
	});

	it('an uncertainty ensemble costs one model run per member, and the server check a handful (issue #4 phase 9)', () => {
		// 60 sampled sets + the run's own: ~15–35 ms each on the examples (docs/model.md §2.10e), so well under 6 s;
		// the server's check (the sample, member 0 and three more) well under a second.
		const input = inputOf(examples[0]!);
		const { options } = resolveEnsembleOptions(input, { members: 60 });
		let t = performance.now();
		const r = runEnsemble(input, options);
		expect(performance.now() - t).toBeLessThan(6000);
		t = performance.now();
		expect(verifyEnsemble(input, options, r.members, 3, Math.random).mismatches).toEqual([]);
		expect(performance.now() - t).toBeLessThan(1000);
	});
});
