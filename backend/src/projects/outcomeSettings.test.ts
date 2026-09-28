import { DEFAULT_OUTCOME_RISK_CUTOFFS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { cutoffsError, effectiveCutoffs, OUTCOME_DEFAULTS, resolveOutcomes } from './outcomeSettings.js';
import { patchSettings, SettingsPatch } from './settings.js';

const ok = (outcomes: unknown) => SettingsPatch.safeParse({ outcomes }).success;
const custom = { reserveMonthsMet: { lower: 0.95, increasing: 0.8 }, daysBelowEwr: { lower: 0.1, increasing: 0.3 } };

describe('SettingsPatch.outcomes', () => {
	it('accepts each method, any subset, defaults (null) per metric, custom cut-offs and the boundaries', () => {
		for (const m of ['auto', 'terciles', 'quintiles']) expect(ok({ yearClassMethod: m }), m).toBe(true);
		expect(ok({})).toBe(true);
		expect(ok({ riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } })).toBe(true);
		expect(ok({ riskCutoffs: custom })).toBe(true);
		expect(ok({ riskCutoffs: { reserveMonthsMet: { lower: 1, increasing: 0 }, daysBelowEwr: { lower: 0, increasing: 1 } } })).toBe(true);
		// Equal cut-offs: no "increasing" band, but not out of order.
		expect(ok({ riskCutoffs: { reserveMonthsMet: { lower: 0.8, increasing: 0.8 }, daysBelowEwr: null } })).toBe(true);
		// The Reserve site: the outlet (null) or a node id (the route checks it is an eligible gauge).
		expect(ok({ siteNodeId: null })).toBe(true);
		expect(ok({ siteNodeId: '11111111-1111-4111-8111-111111111111' })).toBe(true);
	});

	it("rejects an unknown method, cut-offs out of order or outside 0–1 (the engine's validateOutcomeCutoffs), a half-sent pair and unknown keys", () => {
		for (const bad of [
			{ yearClassMethod: 'deciles' },
			{ yearClassMethod: null },
			// Months met: lower risk needs the higher share.
			{ riskCutoffs: { reserveMonthsMet: { lower: 0.7, increasing: 0.9 }, daysBelowEwr: null } },
			// Days below the EWR: lower risk needs the lower share.
			{ riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: 0.3, increasing: 0.1 } } },
			{ riskCutoffs: { reserveMonthsMet: { lower: 1.2, increasing: 0.5 }, daysBelowEwr: null } },
			{ riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: { lower: -0.1, increasing: 0.2 } } },
			{ riskCutoffs: { reserveMonthsMet: { lower: Number.NaN, increasing: 0.5 }, daysBelowEwr: null } },
			// riskCutoffs is replaced whole: both metrics, always.
			{ riskCutoffs: { reserveMonthsMet: null } },
			{ riskCutoffs: { reserveMonthsMet: { lower: 0.9 }, daysBelowEwr: null } },
			{ riskCutoffs: { ...custom, extra: null } },
			{ method: 'auto' },
			{ siteNodeId: 'gauge-1' },
			{ siteNodeId: 3 },
			null,
			'auto'
		]) {
			expect(ok(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it("says which rule failed in the engine's words", () => {
		const r = SettingsPatch.safeParse({ outcomes: { riskCutoffs: { reserveMonthsMet: { lower: 0.7, increasing: 0.9 }, daysBelowEwr: null } } });
		expect(r.success).toBe(false);
		expect(r.error!.issues[0]!.message).toBe('reserveMonthsMet cut-offs must be shares with lower ≥ increasing');
	});
});

describe('resolveOutcomes', () => {
	it('fills the defaults when nothing is stored: auto, and the engine cut-offs (null) pending the hydrologist', () => {
		expect(resolveOutcomes({})).toEqual({ yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null }, siteNodeId: null });
		expect(resolveOutcomes(null)).toEqual(OUTCOME_DEFAULTS);
		expect(resolveOutcomes({ outcomes: 'x' })).toEqual(OUTCOME_DEFAULTS);
	});

	it('keeps what is stored, and falls back field by field (metric by metric) when a stored value is not valid', () => {
		const g = '22222222-2222-4222-8222-222222222222';
		expect(resolveOutcomes({ outcomes: { yearClassMethod: 'quintiles', riskCutoffs: custom, siteNodeId: g } })).toEqual({ yearClassMethod: 'quintiles', riskCutoffs: custom, siteNodeId: g });
		expect(
			resolveOutcomes({
				outcomes: { yearClassMethod: 'deciles', riskCutoffs: { reserveMonthsMet: { lower: 0.5, increasing: 0.9 }, daysBelowEwr: custom.daysBelowEwr }, siteNodeId: 'not-a-uuid' }
			})
		).toEqual({ yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: custom.daysBelowEwr }, siteNodeId: null });
	});
});

describe('effectiveCutoffs and cutoffsError', () => {
	it('fills a null metric with the engine defaults, and copies them (never hands out the frozen object)', () => {
		const e = effectiveCutoffs({ reserveMonthsMet: null, daysBelowEwr: custom.daysBelowEwr });
		expect(e).toEqual({ reserveMonthsMet: DEFAULT_OUTCOME_RISK_CUTOFFS.reserveMonthsMet, daysBelowEwr: custom.daysBelowEwr });
		expect(e.reserveMonthsMet).not.toBe(DEFAULT_OUTCOME_RISK_CUTOFFS.reserveMonthsMet);
		expect(cutoffsError({ reserveMonthsMet: null, daysBelowEwr: null })).toBeNull();
		expect(cutoffsError({ reserveMonthsMet: null, daysBelowEwr: { lower: 0.5, increasing: 0.2 } })).toMatch(/daysBelowEwr/);
	});
});

describe('patchSettings with outcomes', () => {
	it('merges one level deep: the method alone keeps stored cut-offs, and the cut-offs are replaced whole', () => {
		const stored = { outcomes: { yearClassMethod: 'terciles', riskCutoffs: custom } };
		expect((patchSettings(stored, { outcomes: { yearClassMethod: 'quintiles' } }) as unknown as { outcomes: unknown }).outcomes).toEqual({
			yearClassMethod: 'quintiles',
			riskCutoffs: custom
		});
		// The site alone keeps the rest.
		const g = '22222222-2222-4222-8222-222222222222';
		expect((patchSettings(stored, { outcomes: { siteNodeId: g } }) as unknown as { outcomes: unknown }).outcomes).toEqual({ ...stored.outcomes, siteNodeId: g });
		const reset = patchSettings(stored, { outcomes: { riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } } }) as unknown as { outcomes: unknown };
		expect(reset.outcomes).toEqual({ yearClassMethod: 'terciles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } });
	});
});
