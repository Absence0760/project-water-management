import { describe, expect, it } from 'vitest';
import { farmNames, toggleFarm } from './farmers';

const farms = [
	{ id: 'a', name: 'Farm A' },
	{ id: 'b', name: 'Farm B' },
	{ id: 'c', name: 'Farm C' }
];

describe('farmNames', () => {
	it('names the linked farms in the farms’ order', () => {
		expect(farmNames({ nodeIds: ['c', 'a'] }, farms)).toEqual(['Farm A', 'Farm C']);
		expect(farmNames({ nodeIds: [] }, farms)).toEqual([]);
	});

	it('counts links to farms the model no longer has instead of dropping them', () => {
		expect(farmNames({ nodeIds: ['a', 'gone'] }, farms)).toEqual(['Farm A', 'a removed farm']);
		expect(farmNames({ nodeIds: ['x', 'y'] }, farms)).toEqual(['2 removed farms']);
	});
});

describe('toggleFarm', () => {
	it('adds and removes a farm, keeping the farms’ order', () => {
		expect(toggleFarm(['c'], 'a', farms)).toEqual(['a', 'c']);
		expect(toggleFarm(['a', 'c'], 'a', farms)).toEqual(['c']);
	});
});
