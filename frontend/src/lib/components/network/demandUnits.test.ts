import { describe, expect, it } from 'vitest';
import { DEMANDS_UNIT_CHOICES, demandsUnitView, parseDemandsUnit } from './demandUnits';

describe('the Demands grid display unit', () => {
	it('reads the URL value, anything unknown as m³/day', () => {
		expect(parseDemandsUnit('ls')).toBe('ls');
		expect(parseDemandsUnit('m3s')).toBe('m3s');
		expect(parseDemandsUnit(null)).toBeNull();
		expect(parseDemandsUnit('gallons')).toBeNull();
		expect(parseDemandsUnit('')).toBeNull();
	});

	it('converts with the engine scale: 86.4 m³/day is 1 l/s and 0.001 m³/s', () => {
		expect(86.4 * demandsUnitView('ls').scale).toBeCloseTo(1, 12);
		expect(86.4 * demandsUnitView('m3s').scale).toBeCloseTo(0.001, 12);
		expect(demandsUnitView(null)).toEqual({ label: 'm³/day', scale: 1, decimals: 0 });
		expect(demandsUnitView('ls').label).toBe('l/s');
		expect(demandsUnitView('m3s').decimals).toBe(4);
	});

	it('offers m³/day first', () => {
		expect(DEMANDS_UNIT_CHOICES.map((c) => c.label)).toEqual(['m³/day', 'l/s', 'm³/s']);
	});
});
