// The issue #192 workaround (docs/engine-audit.md V1) must not move a figure:
// every supplyAssurance input that real runs build (25 random networks; the
// example catchments live in the backend and were compared byte for byte when
// the change was made) goes through both the current module and
// the pre-#192 reference (./__fixtures__/reliability-pre192.ts), and the whole
// result, every SupplyReliability, stress grid and water-account row, must be
// equal. The inputs are recorded by wrapping supplyAssurance, so they are the
// ones run.ts builds, account nodes and EWR sites included.
import { describe, expect, it, vi } from 'vitest';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import * as reference from './__fixtures__/reliability-pre192';
import type { SupplyAssuranceInput } from './reliability';

const recorded: SupplyAssuranceInput[] = [];
vi.mock('./reliability', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./reliability')>();
	return {
		...actual,
		supplyAssurance: (x: SupplyAssuranceInput) => {
			recorded.push(x);
			return actual.supplyAssurance(x);
		}
	};
});

describe('the assurance of supply is bit-identical to the pre-#192 code', () => {
	it('on random networks: reliability, stress grids and the water account', async () => {
		const current = await vi.importActual<typeof import('./reliability')>('./reliability');
		let nodes = 0;
		for (let seed = 1; seed <= 25; seed++) {
			recorded.length = 0;
			runModel(randomInput(seed, { maxDays: 900 }));
			expect(recorded.length, `seed ${seed}`).toBeGreaterThan(0);
			for (const recordedInput of recorded) {
				// The run-of-river pools (engine 1.64.0) came after the reference; it can't read them, so both sides
				// compare without them (the pools' own terms are held by the water account invariant, testing/invariants.ts).
				const x = { ...recordedInput, accountNodes: recordedInput.accountNodes.map(({ pool: _pool, ...n }) => n) };
				expect(current.supplyAssurance(x), `seed ${seed}`).toEqual(reference.supplyAssurance(x));
				nodes += x.demandNodes.length;
			}
		}
		// Guard against a vacuous pass: the seeds had demand nodes to compare.
		expect(nodes).toBeGreaterThan(25);
	});
});
