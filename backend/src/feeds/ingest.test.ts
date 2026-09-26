import { describe, expect, it } from 'vitest';
import { latestDay } from './ingest.js';

describe('latestDay (the newest day an answer may hold; feeds.db.test.ts covers the refusal)', () => {
	it('is today for the observed sources and the 16th forecast day for CHIRPS-GEFS, across month and year ends', () => {
		expect(latestDay('chirps', '2026-09-25')).toBe('2026-09-25');
		expect(latestDay('dws', '2026-09-25')).toBe('2026-09-25');
		expect(latestDay('chirps_gefs', '2026-09-25')).toBe('2026-10-10');
		expect(latestDay('chirps_gefs', '2026-12-20')).toBe('2027-01-04');
		expect(latestDay('chirps_gefs', '2028-02-20')).toBe('2028-03-06');
	});
});
