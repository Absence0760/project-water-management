// The registry of invalid number fields (invalidFields.svelte.ts) that the
// save bar and the leave guard read: a count that follows set and delete,
// the fields to name, and reset() moving the epoch NumberInput follows.
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import { invalidFields } from './invalidFields.svelte';

describe('invalidFields', () => {
	it('counts the invalid fields, reactively, and names them', () => {
		const seen: number[] = [];
		const stop = $effect.root(() => {
			$effect(() => {
				seen.push(invalidFields.count);
			});
		});
		flushSync();
		invalidFields.set('a', { id: 'loss', label: 'Losses on the way, %', message: 'Enter a number from 0 to 99.9' });
		flushSync();
		invalidFields.set('a', { id: 'loss', label: 'Losses on the way, %', message: 'Enter a number from 0 to 99.9' });
		invalidFields.set('b', { id: 'prio', label: 'Priority', message: 'Enter 1 or more' });
		flushSync();
		expect(invalidFields.fields.map((f) => f.label)).toEqual(['Losses on the way, %', 'Priority']);
		invalidFields.delete('a');
		invalidFields.delete('b');
		flushSync();
		expect(seen).toEqual([0, 1, 2, 0]);
		stop();
	});

	it('reset() moves the epoch', () => {
		const before = invalidFields.epoch;
		invalidFields.reset();
		expect(invalidFields.epoch).toBe(before + 1);
	});
});
