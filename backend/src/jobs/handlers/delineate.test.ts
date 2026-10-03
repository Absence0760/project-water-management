import { describe, expect, it } from 'vitest';
import { parseAim } from './delineate.js';

describe('parseAim (the request’s stored aim, delineation_request.aim)', () => {
	it('takes a well-formed aim', () => {
		const aim = { zoom: 11, box: [10, 20, 30, 40], cut: [false, true, false, false] };
		expect(parseAim(aim)).toEqual(aim);
	});

	it('takes anything else as no aim, so the job’s first window is centred again', () => {
		expect(parseAim(null)).toBeNull();
		expect(parseAim({ zoom: 11, box: [30, 20, 10, 40], cut: [false, false, false, false] })).toBeNull();
		expect(parseAim({ zoom: 11, box: [1, 2, 3], cut: [false, false, false, false] })).toBeNull();
		expect(parseAim({ zoom: 11, box: [1, 2, 3, 4], cut: [false, false, false, false], extra: 1 })).toBeNull();
		expect(parseAim({ zoom: 1.5, box: [1, 2, 3, 4], cut: [false, false, false, false] })).toBeNull();
	});
});
