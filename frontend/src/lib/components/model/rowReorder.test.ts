import { describe, expect, it } from 'vitest';
import { targetIndex } from './rowReorder.svelte';

describe('targetIndex', () => {
	it('accounts for the dragged row leaving its old slot', () => {
		expect(targetIndex(0, 3)).toBe(2); // dropped before row 3 → lands at 2
		expect(targetIndex(3, 0)).toBe(0);
		expect(targetIndex(2, 2)).toBe(2); // dropped on itself
		expect(targetIndex(2, 3)).toBe(2); // just below itself: no move
		expect(targetIndex(1, 5)).toBe(4); // after the last of five
	});
});
