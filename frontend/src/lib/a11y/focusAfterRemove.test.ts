import { describe, expect, it } from 'vitest';
import { rowAfterRemove } from './focusAfterRemove';

describe('rowAfterRemove', () => {
	it('keeps the index: the next row moved up into it', () => {
		expect(rowAfterRemove(0, 2)).toBe(0);
		expect(rowAfterRemove(1, 3)).toBe(1);
	});
	it('takes the last row when the removed one was last', () => {
		expect(rowAfterRemove(2, 2)).toBe(1);
		expect(rowAfterRemove(5, 1)).toBe(0);
	});
	it('reads an index not found (-1) as the first row', () => {
		expect(rowAfterRemove(-1, 3)).toBe(0);
	});
	it('is null once no row is left', () => {
		expect(rowAfterRemove(0, 0)).toBeNull();
	});
});
