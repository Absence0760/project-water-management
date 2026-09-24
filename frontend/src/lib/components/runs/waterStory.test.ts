import type { WaterBalanceRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { waterStory } from './waterStory';

// Two years (730.5 days) on 10 km², so per-year figures are half the totals.
const row = (over: Partial<WaterBalanceRow> = {}): WaterBalanceRow => ({
	waterYear: null,
	days: 730.5,
	rainMm: 1000, // 1 000 mm over 10 km² = 10 Mm³ → 5 Mm³ a year
	naturalFlowMm: 300,
	runoffCoefficient: 0.3,
	runoff: { aetMm: 600, exchangeMm: 0, storageChangeMm: 100, residualMm: 0 },
	naturalFlowM3: 3e6,
	farmRunoffM3: 3e6,
	openingStorageM3: 200_000,
	demandM3: 1e6,
	suppliedM3: 800_000,
	returnFlowM3: 80_000,
	consumptiveUseM3: 720_000,
	transfersM3: 0,
	spillM3: 400_000,
	outflowM3: 2.2e6,
	closingStorageM3: 280_000,
	residualM3: 0,
	...over
});
const summary = (total: WaterBalanceRow | null, legacyRow = false) => ({
	waterBalance: total ? { areaKm2: 10, years: [], total: legacyRow ? { ...total, runoff: null } : total } : undefined,
	catchment: { meanNaturalFlowM3Day: 0, meanSimulatedOutflowM3Day: 0, runoffCoefficient: 0.3, ewrDaysNotMet: 73, ewrFractionDaysNotMet: 0.1 }
});
const by = (items: NonNullable<ReturnType<typeof waterStory>>) => Object.fromEntries(items.map((i) => [i.spot, i]));

describe('waterStory', () => {
	it('tells the balance as yearly averages, rain to outlet, on the eight stops', () => {
		const items = waterStory(summary(row()))!;
		expect(items.map((i) => i.spot)).toEqual(['rain', 'evaporation', 'runoff', 'dam', 'irrigation', 'transfer', 'river', 'outlet']);
		const s = by(items);
		expect(s.rain!.value).toBe('5.00 Mm³ a year');
		expect(s.rain!.detail).toContain('500 mm a year over 10.0 km²');
		expect(s.evaporation!.value).toBe('3.00 Mm³ a year'); // 600 mm × 10 km² over 2 years
		expect(s.evaporation!.detail).toMatch(/^60% of the rain/);
		expect(s.runoff!.value).toBe('1.50 Mm³ a year');
		expect(s.runoff!.detail).toMatch(/^30% of the rain/);
		expect(s.dam!.value).toBe('0.20 Mm³ a year spilled');
		expect(s.dam!.detail).toBe('Storage went from 0.20 Mm³ at the start to 0.28 Mm³ at the end.');
		expect(s.irrigation!.value).toBe('0.40 Mm³ a year');
		expect(s.irrigation!.detail).toMatch(/^80% of the demand of 0.50 Mm³ a year; 0.04 Mm³ a year ran back/);
		expect(s.transfer!.value).toBeNull();
		expect(s.river!.value).toBe('not met on 10% of days');
		expect(s.outlet!.value).toBe('1.10 Mm³ a year');
		expect(s.outlet!.detail).toMatch(/^73% of the natural flow/);
	});

	it('says why there is no evaporation figure for a legacy run', () => {
		const s = by(waterStory(summary(row(), true))!);
		expect(s.evaporation!.value).toBeNull();
		expect(s.evaporation!.detail).toMatch(/legacy/);
	});

	it('copes with no rain, no demand and no natural flow', () => {
		const s = by(waterStory(summary(row({ rainMm: null, demandM3: 0, suppliedM3: 0, naturalFlowM3: 0, runoffCoefficient: null })))!);
		expect(s.rain!.value).toBeNull();
		expect(s.irrigation!.detail).toBe('No irrigation demand in this run.');
		expect(s.outlet!.detail).toBe('No natural flow in this run.');
	});

	it('has nothing to say for a run saved before the water balance existed', () => {
		expect(waterStory(summary(null))).toBeNull();
		expect(waterStory(summary(row({ days: 0 })))).toBeNull();
	});
});
