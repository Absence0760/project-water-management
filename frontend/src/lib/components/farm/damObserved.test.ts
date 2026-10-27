// The dam page's "Your dam, seen from space" (./damObserved.ts, issue #604 R5-B).
import { describe, expect, it } from 'vitest';
import type { FarmDamObserved } from '#lib/api/types.js';
import { damObservedCard } from './damObserved';

const sp = (s: string | null | undefined) => s?.replace(/[  ]/g, ' ');
const base: FarmDamObserved = { outlines: 1, latest: { date: '2026-10-14', wetAreaM2: 32_000, source: 'wofs' }, fullAreaM2: 40_000, attribution: 'Digital Earth Africa, CC BY 4.0' };

describe('damObservedCard', () => {
	it('says when a satellite last saw the dam clearly, its water’s area against the area it covers when full (no percentage), with the credit', () => {
		const vm = damObservedCard(base)!;
		expect(vm.heading).toBe('Your dam, seen from space');
		expect(sp(vm.line)).toBe('On 14 Oct 2026 a satellite saw water over 3.2 ha of the 4.0 ha your dam covers when full.');
		// The page already says how full the dam is by volume: a second percentage would read as the same thing.
		expect(vm.line).not.toMatch(/%/);
		expect(vm.about).toBe('A satellite sees the water’s surface, not how deep it is: a check on the model, not a measurement of the water in your dam.');
		expect(vm.credit).toBe('Satellite views: Digital Earth Africa, CC BY 4.0.');
	});

	it('says “more than” when the water spreads past the full area, and leaves the full area out when there is none', () => {
		expect(sp(damObservedCard({ ...base, latest: { ...base.latest!, wetAreaM2: 44_000 } })!.line)).toBe('On 14 Oct 2026 a satellite saw water over 4.4 ha, more than the 4.0 ha your dam covers when full.');
		expect(sp(damObservedCard({ ...base, latest: { ...base.latest!, wetAreaM2: 40_000 } })!.line)).toBe('On 14 Oct 2026 a satellite saw water over 4.0 ha of the 4.0 ha your dam covers when full.');
		expect(sp(damObservedCard({ ...base, fullAreaM2: null })!.line)).toBe('On 14 Oct 2026 a satellite saw water over 3.2 ha of your dam.');
	});

	it('says there is no clear view yet, and shows nothing for a dam not drawn as an outline', () => {
		expect(damObservedCard({ ...base, latest: null })!.line).toBe('No clear view of your dam from space yet. Clouds often hide it; the next clear view will show here.');
		expect(damObservedCard({ ...base, outlines: 0 })).toBeNull();
		expect(damObservedCard(null)).toBeNull();
	});
});
