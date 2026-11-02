// CLAUDE.md rule 7: this workspace's tests run under a skewed time zone, set by
// vitest.config.ts's test.env.TZ from scripts/test-tz.mjs. This checks the zone
// a test worker actually sees, so removing the setting (or a UTC shell winning
// over it) fails here (docs/testing.md § Time zone).
import { describe, expect, it } from 'vitest';
import { TEST_TIME_ZONES } from '../../../scripts/test-tz.mjs';

describe('test time zone', () => {
	it('is one of the skewed zones, never UTC', () => {
		expect(TEST_TIME_ZONES).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(TEST_TIME_ZONES).toContain(process.env.TZ);
	});

	it('moves local midnight off the UTC day boundary, by a non-whole hour', () => {
		const offset = new Date(2026, 0, 15).getTimezoneOffset();
		expect(offset).not.toBe(0);
		expect(offset % 60).not.toBe(0);
	});
});
