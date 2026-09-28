import { describe, expect, it } from 'vitest';
import { explanationPrompt, normaliseNotes, notesDirty, notesPreview } from './notes';

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

describe('notesPreview', () => {
	it('shows a short note whole, and marks a longer or multi-line one as cut', () => {
		expect(notesPreview('  Calibrated on the weir record.  ')).toBe('Calibrated on the weir record.');
		expect(notesPreview('First line.\nMore detail below.')).toBe('First line. …');
		const long = 'The quaternary includes an irrigated tributary outside the model, so natural flow runs above the WR2012 figure and the difference stands.';
		const p = notesPreview(long, 60)!;
		expect(p.endsWith(' …')).toBe(true);
		expect(p.length).toBeLessThanOrEqual(62);
		expect(long.startsWith(p.slice(0, -2))).toBe(true);
	});

	it('is null without a note', () => {
		expect(notesPreview(undefined)).toBeNull();
		expect(notesPreview('   ')).toBeNull();
	});
});
