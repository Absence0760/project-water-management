// The dam shares a dam marked on or off its river proposes for its unit (194; start.ts damSharesOf, docs/model.md §2.7).
import { describe, expect, it } from 'vitest';
import { damRunoff, damSharesOf, runoffShareFor, withDamShares } from './start.js';

describe('damSharesOf', () => {
	it('on the river: everything from upstream and all of its own runoff enters the dam', () => {
		expect(damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'on_channel' })).toEqual({ pctUpstreamToDam: 1, pctRunoffToDam: 1, damCatchmentM2: null, pctRunoffToDamEffective: 1 });
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

describe('the runoff share on the area taken (195)', () => {
	it('is the dam’s catchment over the piece gross, and both less their pans effective', () => {
		const s = damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'off_channel', damCatchmentM2: 0.4e6, nonContributingM2: 1e6, damNonContributingM2: 0.1e6 })!;
		expect(s.pctRunoffToDam).toBe(0.1);
		// (0.4 − 0.1) / (4 − 1) km²: the same water reaches the dam whichever area the unit's runoff is generated over.
		expect(s.pctRunoffToDamEffective).toBe(0.1);
		expect(s.damNonContributingM2).toBe(0.1e6);
		expect(runoffShareFor(s, 'gross')).toBe(0.1);
		const t = damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'off_channel', damCatchmentM2: 0.4e6, nonContributingM2: 1e6, damNonContributingM2: 0 })!;
		expect(t.pctRunoffToDamEffective).toBe(0.133);
		expect(damRunoff('Dam', t, 'effective')).toBe(0.133);
		expect(damRunoff('Dam', t, 'gross')).toBe(0.1);
	});

	it('is 1 for an unmarked dam and on the river, and refused effective without the figures (a plan from before)', () => {
		expect(damRunoff('Dam', undefined, 'effective')).toBe(1);
		expect(damRunoff('Dam', damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'on_channel' })!, 'effective')).toBe(1);
		const old = damSharesOf({ role: 'dam', areaM2: 4e6, damPosition: 'off_channel', damCatchmentM2: 0.4e6 })!;
		expect(old).not.toHaveProperty('pctRunoffToDamEffective');
		expect(damRunoff('Dam', old, 'gross')).toBe(0.1);
		expect(() => damRunoff('Dam', old, 'effective')).toThrow(/^Dam’s share of runoff into its off-channel dam has no effective figure/);
	});
});
