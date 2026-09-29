// The landing page's figures (data.generated.ts, the engine on the invented
// Kleinberg example, `pnpm gen:landing-art`): the shape the page reads, and the
// hydrology they must show, so a regeneration that broke the model or the
// script can't ship a what-if that contradicts itself.
import { describe, expect, it } from 'vitest';
import { DATA } from './data.generated';

describe('landing data', () => {
	it('is one water year by week, and says it is synthetic', () => {
		expect(DATA.source).toMatch(/invented example catchment/i);
		const s = DATA.story;
		for (const v of [s.rain, s.runoff, s.dam.pctFull, s.farm.demand, s.farm.supplied, s.river.flow, s.river.reserve]) expect(v).toHaveLength(52);
		expect(s.waterYear).toMatch(/^\d{4}\/\d{2}$/);
		expect(Math.max(...s.dam.pctFull)).toBeLessThanOrEqual(100.0001);
		// A farm never gets more than it asked for.
		s.farm.supplied.forEach((v, i) => expect(v).toBeLessThanOrEqual(s.farm.demand[i]! + 1));
		expect(s.river.weeksBelow).toBe(s.river.flow.filter((q, i) => q < s.river.reserve[i]!).length);
	});

	it('the what-if grid moves the way the hydrology says it must', () => {
		const w = DATA.whatIf;
		expect(w.grid).toHaveLength(w.extraHa.length);
		for (const row of w.grid) expect(row).toHaveLength(w.damScale.length);
		expect(w.extraHa[0]).toBe(0);
		expect(w.damScale[0]).toBe(1);
		expect(w.grid[0]![0]!.supplied).toBe(w.baseSupplied);
		for (let d = 0; d < w.damScale.length; d++) {
			for (let h = 1; h < w.extraHa.length; h++) {
				// More orchard on the same dam: the farm gets a smaller share, the river is never better off.
				expect(w.grid[h]![d]!.supplied).toBeLessThanOrEqual(w.grid[h - 1]![d]!.supplied);
				expect(w.grid[h]![d]!.reserveDays).toBeGreaterThanOrEqual(w.grid[h - 1]![d]!.reserveDays);
			}
		}
		for (let h = 0; h < w.extraHa.length; h++) {
			for (let d = 1; d < w.damScale.length; d++) {
				// A bigger dam never supplies less.
				expect(w.grid[h]![d]!.supplied).toBeGreaterThanOrEqual(w.grid[h]![d - 1]!.supplied);
			}
		}
		for (const row of w.grid) for (const c of row) expect(c.reserveDays).toBeLessThanOrEqual(366);
	});

	it('the hero figure is the run’s own', () => {
		expect(DATA.hero.reserveNotMetPct).toBeGreaterThan(0);
		expect(DATA.hero.reserveNotMetPct).toBeLessThanOrEqual(100);
		expect(DATA.hero.days).toBeGreaterThanOrEqual(365 * DATA.hero.years - 5);
	});

	it('the trust figure is a calibration score the page can stand behind', () => {
		// Nash–Sutcliffe: at most 1 (perfect); the page calls it a fit worth trusting, so a
		// regeneration whose example no longer fits its weir (under 0.5, "unsatisfactory"
		// in Moriasi et al. 2007) must not ship silently.
		expect(DATA.hero.calibrationNse).toBeLessThanOrEqual(1);
		expect(DATA.hero.calibrationNse).toBeGreaterThanOrEqual(0.5);
		expect(DATA.hero.calibrationNse).toBe(Math.round(DATA.hero.calibrationNse * 100) / 100);
	});
});
