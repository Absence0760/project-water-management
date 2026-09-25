import { describe, expect, it } from 'vitest';
import { explanationPrompt, normaliseNotes, notesDirty } from './notes';

describe('run notes helpers', () => {
	it('compares the draft with the stored note as the server would store it', () => {
		expect(normaliseNotes('  why \n')).toBe('why');
		expect(notesDirty(' why ', 'why')).toBe(false);
		expect(notesDirty('why not', 'why')).toBe(true);
		expect(notesDirty('', undefined)).toBe(false);
		expect(notesDirty('x', undefined)).toBe(true);
	});

	it('asks for an explanation only for a query or not-usable flag without one', () => {
		expect(explanationPrompt('query', '')).toMatch(/queries this run/);
		expect(explanationPrompt('unusable', '   ')).toMatch(/not usable for EWR findings/);
		expect(explanationPrompt('unusable', undefined)).not.toBeNull();
		expect(explanationPrompt('query', 'Tributary outside the model')).toBeNull();
		expect(explanationPrompt('note', '')).toBeNull();
		expect(explanationPrompt('ok', '')).toBeNull();
		expect(explanationPrompt(null, '')).toBeNull();
	});
});
