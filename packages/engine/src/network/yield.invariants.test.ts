// checkYield (../testing/yieldInvariants.ts) on random networks: the storage–
// yield curve is monotone, every yield is under the mean-supply bound, passes
// with no failure day while a draft a tolerance above it fails, and at
// capacity 0 equals the smallest daily supply (WP-3.6).
import { describe, expect, it } from 'vitest';
import { randomInput } from '../testing/fuzz';
import { checkYield, firstDam } from '../testing/yieldInvariants';

describe('firm-yield invariants on random networks', () => {
	it('hold on the first 40 seeds with a dam', () => {
		let tested = 0;
		for (let seed = 1; seed < 400 && tested < 40; seed++) {
			const input = randomInput(seed, { maxDays: 500, maxNodes: 8 });
			const dam = firstDam(input);
			if (!dam) continue;
			expect(checkYield(input, dam), `seed ${seed}`).toBeNull();
			tested++;
		}
		expect(tested).toBe(40);
	});
});
