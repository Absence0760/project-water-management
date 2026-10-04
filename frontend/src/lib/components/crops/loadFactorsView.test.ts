import { describe, expect, it } from 'vitest';
import { CROP_LIBRARY, type StagedLibraryCrop } from './library';
import type { DemandRow } from './loadFactors';
import { applyLine, matchedLine, plantingFor, rowsByChange } from './loadFactorsView';

const row = (nodeId: string, gross: [number, number], abstraction: [number, number]): DemandRow => ({ nodeId, name: nodeId, gross, abstraction });
const staged = (id: string) => CROP_LIBRARY.find((c): c is StagedLibraryCrop => c.id === id && c.kind === 'staged')!;

describe('rowsByChange', () => {
	it('puts the biggest change in abstraction first, either way', () => {
		const out = rowsByChange([row('a', [100, 90], [120, 108]), row('b', [100, 150], [120, 180]), row('c', [100, 40], [120, 48])]);
		expect(out.map((r) => r.nodeId)).toEqual(['c', 'b', 'a']);
	});
	it('breaks a tie on abstraction by the crop requirement, then keeps the model order', () => {
		// An efficiency change alone moves abstraction, not the requirement.
		const out = rowsByChange([row('a', [10, 10], [12, 10]), row('b', [10, 12], [12, 10]), row('c', [5, 5], [5, 5]), row('d', [5, 5], [5, 5])]);
		expect(out.map((r) => r.nodeId)).toEqual(['b', 'a', 'c', 'd']);
	});
	it('leaves its input alone', () => {
		const rows = [row('a', [1, 1], [1, 1]), row('b', [1, 2], [1, 2])];
		rowsByChange(rows);
		expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b']);
	});
});

describe('plantingFor', () => {
	it('starts a new planting with no month, the 1st and the crop’s first Table 4.7 season', () => {
		expect(plantingFor(staged('beans'))).toEqual({ month: 0, day: 1, days: 100, for: 'beans' });
	});
	it('keeps a planting already made for the same crop, season included', () => {
		const prev = { month: 5, day: 12, days: 75, for: 'beans' };
		expect(plantingFor(staged('beans'), prev)).toBe(prev);
	});
	it('keeps the date but takes the new crop’s own season when the vegetable changes', () => {
		expect(plantingFor(staged('beans'), { month: 5, day: 12, days: 160, for: 'onions' })).toEqual({ month: 5, day: 12, days: 100, for: 'beans' });
	});
});

describe('the dialog’s lines', () => {
	it('says how many crops matched by name', () => {
		expect(matchedLine(14, 30)).toBe('14 of 30 crops matched by name. Check each match.');
		expect(matchedLine(1, 1)).toBe('1 of 1 crop matched by name. Check each match.');
		expect(matchedLine(0, 3)).toMatch(/^No crop matched/);
		expect(matchedLine(0, 0)).toBe('');
	});
	it('says how many crops Apply changes', () => {
		expect(applyLine(0, 30)).toBe('Nothing to apply yet.');
		expect(applyLine(3, 30)).toBe('3 of 30 crops will change. Save the model afterwards to keep it.');
		expect(applyLine(1, 1)).toBe('1 of 1 crop will change. Save the model afterwards to keep it.');
	});
});
