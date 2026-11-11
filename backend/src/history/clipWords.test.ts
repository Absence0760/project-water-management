import { describe, expect, it } from 'vitest';
import { clipWords, fitNotedReason, fitReason } from './record.js';

describe('clipWords', () => {
	it('keeps text that fits whole', () => {
		expect(clipWords('two words', 9)).toBe('two words');
		expect(clipWords('', 0)).toBe('');
	});
	it('cuts on a word boundary, with an ellipsis, never past the limit', () => {
		expect(clipWords('the quick brown fox', 12)).toBe('the quick…');
		// The cut lands just before a space: the last word is whole.
		expect(clipWords('the quick brown fox', 10)).toBe('the quick…');
		// Punctuation the cut would leave hanging goes with it.
		expect(clipWords('alpha, beta; gamma delta', 14)).toBe('alpha, beta…');
		for (let max = 1; max < 30; max++) {
			const out = clipWords('Planted area of lucerne on the upper unit, from land cover', max);
			expect(out.length).toBeLessThanOrEqual(max);
			expect(out.endsWith('…')).toBe(true);
		}
	});
	it('cuts a single over-long word where it must, within the limit', () => {
		expect(clipWords('x'.repeat(20), 8)).toBe(`${'x'.repeat(7)}…`);
		expect(clipWords(`ab ${'x'.repeat(20)}`, 2)).toBe('a…');
		// A run longer than a word is cut in place rather than dropped whole.
		expect(clipWords(`name “${'x'.repeat(60)}” here`, 40)).toBe(`name “${'x'.repeat(33)}…`);
		expect(clipWords('word', 0)).toBe('');
	});
});

describe('fitReason on a word boundary', () => {
	it('shortens the head on a whole word and keeps the citation whole', () => {
		expect(fitReason('a long head here', '; tail', 16)).toBe('a long…; tail');
		const out = fitReason('word '.repeat(200), '; cite.', 500);
		expect(out.length).toBeLessThanOrEqual(500);
		expect(out.endsWith('word…; cite.')).toBe(true);
	});
	it('never passes the limit when the citation fills it', () => {
		expect(fitReason('head', 'c'.repeat(20), 20)).toBe('c'.repeat(20));
	});
});

describe('fitNotedReason', () => {
	it('adds the whole note when it fits', () => {
		expect(fitNotedReason('Head', '; cite.', '; ref.', 'The method.', 50)).toBe('Head; cite. The method.');
	});
	it('cuts the note on a word, after a whole citation', () => {
		const out = fitNotedReason('Head', '; cite.', '; ref.', 'Cells weighted by their overlap with each parcel', 40);
		expect(out).toBe('Head; cite. Cells weighted by their…');
		expect(out.length).toBeLessThanOrEqual(40);
	});
	it('drops the note when not even a word of it fits', () => {
		expect(fitNotedReason('Head', '; cite.', '; ref.', 'Cells weighted', 13)).toBe('Head; cite.');
	});
	it('falls back to the reference when the full citation would crowd out the head', () => {
		const out = fitNotedReason('Head of the reason', `; ${'s'.repeat(30)}.`, '; ref.', 'note', 40);
		expect(out).toBe('Head of the reason; ref. note');
	});
});
