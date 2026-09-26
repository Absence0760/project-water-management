// The digest clock (WP-2.13): 06:00 in Africa/Johannesburg, computed from the
// instant, whatever the machine's time zone (CLAUDE.md rule 7).
import { afterEach, describe, expect, it } from 'vitest';
import { digestWindow } from './digest.js';

const zone = process.env.TZ;
afterEach(() => {
	process.env.TZ = zone;
});

describe.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg'])('digestWindow (TZ %s)', (tz) => {
	it('starts the day at 06:00 SAST (04:00 UTC)', () => {
		process.env.TZ = tz;
		expect(digestWindow(new Date('2026-09-26T10:00:00Z'))).toEqual({
			start: new Date('2026-09-26T04:00:00Z'),
			next: new Date('2026-09-27T04:00:00Z')
		});
	});

	it('before 06:00 SAST belongs to the day before', () => {
		process.env.TZ = tz;
		expect(digestWindow(new Date('2026-09-26T03:59:59Z')).start).toEqual(new Date('2026-09-25T04:00:00Z'));
		expect(digestWindow(new Date('2026-09-26T04:00:00Z')).start).toEqual(new Date('2026-09-26T04:00:00Z'));
	});

	it('crosses a month and a year end', () => {
		process.env.TZ = tz;
		expect(digestWindow(new Date('2027-01-01T01:00:00Z'))).toEqual({
			start: new Date('2026-12-31T04:00:00Z'),
			next: new Date('2027-01-01T04:00:00Z')
		});
		// 23:30 SAST on the 31st is 21:30 UTC.
		expect(digestWindow(new Date('2026-10-31T21:30:00Z')).next).toEqual(new Date('2026-11-01T04:00:00Z'));
	});
});
