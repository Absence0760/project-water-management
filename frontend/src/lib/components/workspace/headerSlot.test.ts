import type { Snippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { fillHeader, headerSlot } from './headerSlot.svelte';

const snippet = () => (() => {}) as unknown as Snippet;

describe('fillHeader', () => {
	it('puts the context, status, actions and main action in the header, and clears them when the tab goes', () => {
		const [context, status, actions, main] = [snippet(), snippet(), snippet(), snippet()];
		const clear = fillHeader({ context, status, actions, main });
		expect(headerSlot).toEqual({ context, status, actions, main });
		clear?.();
		expect(headerSlot).toEqual({ context: null, status: null, actions: null, main: null });
	});

	it('leaves the parts a later tab filled when an earlier one clears', () => {
		const clearFirst = fillHeader({ main: snippet() });
		const next = snippet();
		const clearNext = fillHeader({ context: next });
		clearFirst?.();
		expect(headerSlot.context).toBe(next);
		expect(headerSlot.main).toBeNull();
		clearNext?.();
		expect(headerSlot.context).toBeNull();
	});

	it('fills nothing when off (a tab inside a modal)', () => {
		expect(fillHeader({ main: snippet() }, false)).toBeUndefined();
		expect(headerSlot.main).toBeNull();
	});
});
