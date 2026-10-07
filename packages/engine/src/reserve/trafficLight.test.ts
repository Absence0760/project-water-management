import { describe, expect, it } from 'vitest';
import { EWR_TRAFFIC_LIGHT, ewrBand } from './trafficLight';

describe('ewrBand', () => {
	it('is green below 5 % of days, amber below 20 %, red otherwise', () => {
		expect(EWR_TRAFFIC_LIGHT).toEqual({ green: 5, amber: 20 });
		expect(ewrBand(0, 30)).toBe('green');
		expect(ewrBand(4, 100)).toBe('green');
		expect(ewrBand(5, 100)).toBe('amber');
		expect(ewrBand(19, 100)).toBe('amber');
		expect(ewrBand(20, 100)).toBe('red');
		expect(ewrBand(31, 31)).toBe('red');
	});

	it('reads a boundary exactly (7 of 100 is 7 %, not a hair over)', () => {
		expect(ewrBand(7, 100, { green: 7, amber: 50 })).toBe('amber');
		expect(ewrBand(1, 20)).toBe('amber');
	});

	it('is null for an empty or impossible count, never a false green', () => {
		expect(ewrBand(0, 0)).toBeNull();
		expect(ewrBand(-1, 30)).toBeNull();
		expect(ewrBand(31, 30)).toBeNull();
		expect(ewrBand(Number.NaN, 30)).toBeNull();
	});
});
