// The unstressed half of assurance-jit.perf.test.ts (issue #192), in the unit
// suite so the stress harness can't rot unnoticed: its input still builds,
// the `assurance` self-check runs and passes on it, and two runs give the same
// supplyAssurance to the bit. The stress run itself is opt-in (perf project).
import { describe, expect, it } from 'vitest';
import { assuranceJitInput, assuranceJitRun } from './assurance-jit.child.js';

describe('the assurance stress harness (issue #192)', () => {
	it('builds Sandspruit, runs the assurance self-check and gives the same supplyAssurance twice', () => {
		const input = assuranceJitInput();
		const a = assuranceJitRun(input);
		const b = assuranceJitRun(input);
		expect(a).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), passed: true, detail: null });
		expect(b.hash).toBe(a.hash);
	});
});
