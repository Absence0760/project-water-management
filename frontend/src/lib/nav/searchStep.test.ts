import { describe, expect, it } from 'vitest';
import { SearchStep } from './searchStep';

describe('SearchStep', () => {
	it('adds an entry on the first write after the focus, and replaces it for the rest of that search', () => {
		const step = new SearchStep();
		expect([step.replace(), step.replace(), step.replace()]).toEqual([false, true, true]);
		// Back in the box: a new search is a new step.
		step.focus();
		expect([step.replace(), step.replace()]).toEqual([false, true]);
	});

	it('keeps each box’s steps apart', () => {
		const a = new SearchStep();
		const b = new SearchStep();
		a.replace();
		expect(b.replace()).toBe(false);
		expect(a.replace()).toBe(true);
	});

	it('works as a detached focus handler', () => {
		const step = new SearchStep();
		step.replace();
		const onfocus = step.focus;
		onfocus();
		expect(step.replace()).toBe(false);
	});
});
