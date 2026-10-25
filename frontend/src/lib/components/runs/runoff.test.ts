import type { RunoffBalance } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { balanceRows, describeParams } from './runoff';

const balance = (over: Partial<RunoffBalance> = {}): RunoffBalance => ({
	model: 'gr4j',
	params: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
	warmupDays: 365,
	areaKm2: 20,
	rainMm: 1000,
	petMm: 1500,
	aetMm: 700,
	flowMm: 290,
	exchangeMm: 0,
	storageStartMm: 100,
	storageEndMm: 110,
	...over
});

describe('balanceRows', () => {
	it('closes: rain + exchange = evaporation + flow + change in storage', () => {
		for (const b of [balance(), balance({ exchangeMm: -40, flowMm: 250 })]) {
			const r = Object.fromEntries(balanceRows(b).map((x) => [x.key, x.mm]));
			expect(r.rain! + (r.exchange ?? 0)).toBeCloseTo(r.aet! + r.flow! + r.storage!, 9);
		}
	});

	it('shows exchange only when there was some, and shares of the rain', () => {
		expect(balanceRows(balance()).map((r) => r.key)).toEqual(['rain', 'aet', 'flow', 'storage']);
		expect(balanceRows(balance({ exchangeMm: -40, flowMm: 250 })).map((r) => r.key)).toEqual(['rain', 'aet', 'flow', 'exchange', 'storage']);
		expect(balanceRows(balance()).find((r) => r.key === 'flow')!.ofRain).toBeCloseTo(0.29, 12);
		expect(balanceRows(balance({ rainMm: 0 }))[0]!.ofRain).toBeNull();
	});
});

describe('describeParams', () => {
	it('lists GR4J parameters by name with units, X2 only when set', () => {
		expect(describeParams(balance())).toBe('Production store capacity X1 350 mm · Routing store capacity X3 90 mm · Unit hydrograph time base X4 1.7 days');
		expect(describeParams(balance({ params: { x1: 350, x2: -1.2, x3: 90, x4: 1.7 } }))).toBe(
			'Production store capacity X1 350 mm · Groundwater exchange X2 −1.2 mm/day · Routing store capacity X3 90 mm · Unit hydrograph time base X4 1.7 days'
		);
	});
	it('rounds a fitted parameter to at most 3 decimals, as Where the parameters came from does (#586 D10)', () => {
		expect(describeParams(balance({ params: { x1: 426.0810500977728, x2: 0, x3: 47.3793803685375, x4: 2.5447538701361117 } }))).toBe(
			'Production store capacity X1 426.081 mm · Routing store capacity X3 47.379 mm · Unit hydrograph time base X4 2.545 days'
		);
	});
});
