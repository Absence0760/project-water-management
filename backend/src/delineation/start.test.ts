// The dam shares a dam marked on or off its river proposes for its unit (194; start.ts damSharesOf, docs/model.md §2.7).
import { describe, expect, it } from 'vitest';
import { damSharesOf, withDamShares } from './start.js';

describe('damSharesOf', () => {
	it('on the river: everything from upstream and all of its own runoff enters the dam', () => {
		expect(damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'on_channel' })).toEqual({ pctUpstreamToDam: 1, pctRunoffToDam: 1, damCatchmentM2: null });
	});

	it('off-channel: the river passes it by, and only its own catchment’s share of the unit’s runoff enters it', () => {
		expect(damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'off_channel', damCatchmentM2: 0.1e6 })).toEqual({ pctUpstreamToDam: 0, pctRunoffToDam: 0.025, damCatchmentM2: 0.1e6 });
		// To 0.001, never past 1; a dam with no river below it owns its whole piece.
		expect(damSharesOf({ role: 'dam', areaM2: 3e6, damPosition: 'off_channel', damCatchmentM2: 1e6 })!.pctRunoffToDam).toBe(0.333);
		expect(damSharesOf({ role: 'dam', areaM2: 1e6, damPosition: 'off_channel', damCatchmentM2: 1.0000001e6 })!.pctRunoffToDam).toBe(1);
		expect(damSharesOf({ role: 'dam', areaM2: 1e6, damPosition: 'off_channel' })).toEqual({ pctUpstreamToDam: 0, pctRunoffToDam: 1, damCatchmentM2: null });
	});

	it('proposes nothing for an unmarked dam (today’s plan) or any other unit', () => {
		expect(damSharesOf({ role: 'dam', areaM2: 4e6 })).toBeNull();
		expect(damSharesOf({ role: 'abstraction', areaM2: 4e6, damPosition: 'off_channel', damCatchmentM2: 1 })).toBeNull();
		expect(withDamShares({ role: 'dam', areaM2: 4e6 })).toEqual({});
		expect(withDamShares({ role: 'dam', areaM2: 4e6, damPosition: 'on_channel' })).toHaveProperty('damShares');
	});
});
