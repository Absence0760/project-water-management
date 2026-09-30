import { describe, expect, it } from 'vitest';
import type { DemandObject } from '@water-management/engine';
import { floorLine, peopleHint } from './demandObjectFloor';

const o = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'o',
	nodeId: 'a',
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(400),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

describe('the node form’s basic-needs floor line (engine 1.44.0)', () => {
	it('says there is none until a monthly object has people, and nothing on other categories', () => {
		expect(floorLine(o())).toMatch(/^No basic-needs floor: enter the people it serves/);
		expect(floorLine(o({ category: 'industrial', population: 2000 }))).toBeNull();
	});

	it('states the floor and whose people it counts', () => {
		expect(floorLine(o({ population: 2000 }))).toMatch(
			/^Basic-needs floor 50 m³\/day \(2\D000 people served\), 25 litres a person a day: a restriction never cuts it below that, or below its demand when that is less\.$/
		);
		expect(floorLine(o({ category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 1000, litresPerUnitDay: 230 }))).toMatch(/^Basic-needs floor 25 m³\/day \(its number of people, 1\D000\)/);
	});

	it('never states a floor above what the object asks for as a cut it holds', () => {
		// 20 000 people × 25 l = 500 m³/day, more than the town's 400.
		expect(floorLine(o({ population: 20000 }))).toMatch(/^Basic-needs floor 500 m³\/day \(20\D000 people served\), at least its whole demand: a restriction never cuts it\.$/);
	});

	it('says which number the floor counts when People served is blank', () => {
		expect(peopleHint(o({ sizing: 'perUnit', count: 1200 }))).toMatch(/^Blank: the floor counts its number of people \(1\D200\)/);
		expect(peopleHint(o())).toMatch(/^Blank: no basic-needs floor/);
	});
});
