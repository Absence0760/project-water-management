import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { bearingWord, choiceText, confluenceOf, largerChannelOf, largerLine } from './largerChannel';

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
		expect(largerLine([21.465, -28.389], larger)).toBe('a much larger channel (620 km²) runs 504 m north: the river line may sit off the channel the elevation model sees');
	});

	it('words a channel offered for matching the mapped river (place.ts rules 3 and 4), which can be the smaller one', () => {
		const matching = { at: [28.0002, -26.3292] as [number, number], distanceM: 480, km2: 610.6, pointKm2: 2.04, reachKm2: 623 };
		expect(largerLine([28.0002, -26.3336], matching)).toBe(
			'the channel matching the mapped river (about 623 km² there) runs 480 m north, 611 km² here: the point stays on the channel it is on unless you move it'
		);
	});
});

describe('confluenceOf and choiceText', () => {
	const choices = [
		{ dataset: 'HydroRIVERS-v10', reachId: 11491355, upstreamKm2: 497.3, distanceM: 102, role: 'below' as const, label: 'the river below the junction' },
		{ dataset: 'HydroRIVERS-v10', reachId: 11491129, upstreamKm2: 66.9, distanceM: 32, role: 'above' as const, label: 'the tributary above the junction' }
	];
	it('reads the rivers (and the click) from a 422 confluence refusal, and nothing from any other error', () => {
		expect(confluenceOf(new ApiError(422, 'At a confluence', { reason: 'confluence', choices }))).toEqual({ choices, click: null });
		expect(confluenceOf(new ApiError(422, 'Click 2: …', { reason: 'confluence', click: 1, choices }))).toEqual({ choices, click: 1 });
		expect(confluenceOf(new ApiError(422, 'x', { reason: 'larger_channel' }))).toBeNull();
		expect(confluenceOf(new ApiError(422, 'x', { reason: 'confluence', choices: [] }))).toBeNull();
	});
	it('words each river’s button with its area', () => {
		expect(choiceText(choices[0]!)).toBe('The river below the junction, 497 km²');
		expect(choiceText(choices[1]!)).toBe('The tributary above the junction, 67 km²');
	});
});
