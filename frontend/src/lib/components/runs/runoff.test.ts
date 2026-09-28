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
	it('lists GR4J parameters with units, X2 only when set', () => {
		expect(describeParams(balance())).toBe('X1 350 mm · X3 90 mm · X4 1.7 days');
		expect(describeParams(balance({ params: { x1: 350, x2: -1.2, x3: 90, x4: 1.7 } }))).toBe('X1 350 mm · X2 -1.2 mm/day · X3 90 mm · X4 1.7 days');
	});
});
