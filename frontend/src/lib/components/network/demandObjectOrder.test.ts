import { describe, expect, it } from 'vitest';
import type { DemandObject } from '@water-management/engine';
import { orderRows, positionChoices, PRIORITY_OPTION_LABEL, renumberSupplyOrder, setPriority, setSupplyPosition, showsSupplyOrder, supplyOrderText } from './demandObjectOrder';

const object = (name: string, over: Partial<DemandObject> = {}): DemandObject => ({
	id: name,
	nodeId: 'a',
	name,
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(40),
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
const classes = (objects: DemandObject[]) => objects.map((o) => [o.priority, o.rank ?? null]);

describe('the supply order on the node form (issue #343)', () => {
	it('shows the numbered order from two objects on, the dropdown below that', () => {
		expect(showsSupplyOrder([])).toBe(false);
		expect(showsSupplyOrder([object('A')])).toBe(false);
		expect(showsSupplyOrder([object('A'), object('B')])).toBe(true);
	});

	it('keeps the dropdown’s words short enough not to be cut off', () => {
		for (const text of Object.values(PRIORITY_OPTION_LABEL)) expect(text.length).toBeLessThanOrEqual(24);
	});

	it('orders two municipalities before the crops: Demand 1, then Demand 2, then the crops', () => {
		// Both first: they share (positions 1, 1; crops 2). B to 2 shares with the crops; the crops to 3 put B before them.
		const objs = [object('A'), object('B')];
		expect(supplyOrderText(objs)).toBe('A and B pro rata, then the crops');
		setSupplyPosition(objs, 1, 2);
		expect(classes(objs)).toEqual([
			['first', null],
			['shared', null]
		]);
		expect(supplyOrderText(objs)).toBe('A, then B and the crops pro rata');
		setSupplyPosition(objs, 'crops', 3);
		expect(classes(objs)).toEqual([
			['first', 1],
			['first', 2]
		]);
		expect(supplyOrderText(objs)).toBe('A, then B, then the crops');
		// Back to equal: the ranks clear, as an object saved before ranks has none.
		setSupplyPosition(objs, 1, 1);
		expect(classes(objs)).toEqual([
			['first', null],
			['first', null]
		]);
	});

	it('moves the crops, which turns objects into before, with or after them', () => {
		const objs = [object('A'), object('B', { priority: 'last' })];
		// A 1, crops 2, B 3. Crops to 1: A shares with them, B stays after.
		setSupplyPosition(objs, 'crops', 1);
		expect(classes(objs)).toEqual([
			['shared', null],
			['last', null]
		]);
		expect(supplyOrderText(objs)).toBe('A and the crops pro rata, then B');
		// Crops to 3 (after B's 2): both before, in order.
		setSupplyPosition(objs, 'crops', 3);
		expect(classes(objs)).toEqual([
			['first', 1],
			['first', 2]
		]);
	});

	it('inserts between two places in one choice, and offers every place', () => {
		const objs = [object('A'), object('B')];
		// A and B share 1, the crops 2: B between 1 and 2 goes after A, before the crops.
		setSupplyPosition(objs, 1, 1.5);
		expect(supplyOrderText(objs)).toBe('A, then B, then the crops');
		// Before 1: ahead of A.
		setSupplyPosition(objs, 1, 0.5);
		expect(supplyOrderText(objs)).toBe('B, then A, then the crops');
		expect(positionChoices(2).map((c) => c.label)).toEqual(['Before 1', '1', 'Between 1 and 2', '2', 'After 2']);
		// Many objects: one choice moves one to just before the crops, whatever the list's length.
		const many = Array.from({ length: 10 }, (_, k) => object(`O${k + 1}`, { rank: k + 1 }));
		setSupplyPosition(many, 4, 10.5);
		expect(supplyOrderText(many)).toBe('O1, then O2, then O3, then O4, then O6, then O7, then O8, then O9, then O10, then O5, then the crops');
	});

	it('lists the rows in supply order, the crops at their place', () => {
		const objs = [object('A', { priority: 'last' }), object('B')];
		expect(orderRows(objs)).toEqual([
			{ which: 1, position: 1 },
			{ which: 'crops', position: 2 },
			{ which: 0, position: 3 }
		]);
	});

	it('closes up the ranks when a demand is removed, and a lone one keeps none', () => {
		const objs = [object('A', { rank: 1 }), object('B', { rank: 2 }), object('C', { rank: 3 })];
		const rest = objs.filter((o) => o.name !== 'B');
		renumberSupplyOrder(rest);
		expect(classes(rest)).toEqual([
			['first', 1],
			['first', 2]
		]);
		const lone = [object('C', { rank: 2 })];
		renumberSupplyOrder(lone);
		expect(classes(lone)).toEqual([['first', null]]);
	});

	it('ignores a position that isn’t a number > 0', () => {
		const objs = [object('A'), object('B')];
		for (const p of [null, 0, -2, NaN]) setSupplyPosition(objs, 0, p);
		expect(classes(objs)).toEqual([
			['first', null],
			['first', null]
		]);
	});

	it('clears the rank when the dropdown sets a class', () => {
		const o = object('A', { rank: 2 });
		setPriority(o, 'last');
		expect([o.priority, o.rank]).toEqual(['last', null]);
	});
});
