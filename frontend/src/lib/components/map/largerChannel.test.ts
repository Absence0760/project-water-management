import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { bearingWord, largerChannelOf, largerLine } from './largerChannel';

const larger = { at: [21.465, -28.3845] as [number, number], distanceM: 504, km2: 619.8, pointKm2: 0.18 };

describe('largerChannelOf', () => {
	it('reads the channel from a 422 larger_channel refusal, and nothing from any other error', () => {
		const err = new ApiError(422, 'A much larger channel runs 504 m north of your point…', { reason: 'larger_channel', larger });
		expect(largerChannelOf(err)).toEqual(larger);
		expect(largerChannelOf(new ApiError(422, 'too large', { reason: 'too_large' }))).toBeNull();
		expect(largerChannelOf(new Error('x'))).toBeNull();
	});
});

describe('bearingWord and largerLine', () => {
	it('says which way the channel lies, in eight points', () => {
		expect(bearingWord([21, -28], [21, -27.99])).toBe('north');
		expect(bearingWord([21, -28], [21.01, -28])).toBe('east');
		expect(bearingWord([21, -28], [20.99, -28.01])).toBe('south-west');
	});

	it('words the channel for a click’s line', () => {
		expect(largerLine([21.465, -28.389], larger)).toBe('a much larger terrain channel (620 km²) runs 504 m north: use it if that is the river you meant');
	});
});
