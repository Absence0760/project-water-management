// The Copernicus credit has one definition, the engine's leaf module
// (packages/engine/src/evidence/sentinelCredit.ts): the dam views' credit
// (upstream.ts) and the evidence report's § 7 are the same text.
import { SENTINEL_CITATION, sentinelCitation } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { isSentinel, SENTINEL_ATTRIBUTION, sentinelCredit } from './upstream.js';

describe('the Sentinel credit', () => {
	it('is the evidence report’s, not a copy of it', () => {
		expect(SENTINEL_ATTRIBUTION).toBe(SENTINEL_CITATION);
		expect(sentinelCredit).toBe(sentinelCitation);
	});

	it('names the years of the views, and nothing without one', () => {
		expect(sentinelCredit(['2024-03-01'])).toBe('Contains modified Copernicus Sentinel data 2024, processed by Digital Earth Africa');
		expect(sentinelCredit(['2023-12-31', '2021-01-01', '2022-06-01'])).toBe('Contains modified Copernicus Sentinel data 2021–2023, processed by Digital Earth Africa');
		expect(sentinelCredit([])).toBeNull();
	});

	it('is for Sentinel-2 and Sentinel-1 values only', () => {
		expect(['s2', 's1', 'wofs', 'waterbodies'].map(isSentinel)).toEqual([true, true, false, false]);
	});
});
