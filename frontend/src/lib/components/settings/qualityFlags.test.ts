import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, type QualityFlagSettings } from '@water-management/engine';
import { qualityFlagsError, ratedKinds, ratingField, withRating } from './qualityFlags';

const base = (): QualityFlagSettings => defaultProjectSettings().qualityFlags;

describe('the quality-flag fields (Settings → Calibration record)', () => {
	it('offers a gauged range for each calibration record the project has, or both when not known', () => {
		expect(ratedKinds(null)).toEqual(['flow_observed_m3s', 'flow_logger_m3s']);
		expect(ratedKinds(['rain_catchment_mm', 'flow_logger_m3s', 'flow_reference_m3s'])).toEqual(['flow_logger_m3s']);
		expect(ratedKinds([])).toEqual([]);
	});

	it('edits one record’s range, and drops a range emptied of every field', () => {
		const q = base();
		const one = withRating(q.ratings, 'flow_observed_m3s', { gaugedMaxM3s: 12 });
		expect(one).toEqual({ flow_observed_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: null, source: '' } });
		expect(q.ratings).toEqual({}); // not mutated
		const two = withRating(one, 'flow_observed_m3s', { source: 'DWS gaugings' });
		expect(ratingField({ ...q, ratings: two }, 'flow_observed_m3s')).toEqual({ gaugedMaxM3s: 12, gaugedMinM3s: null, source: 'DWS gaugings' });
		expect(withRating(two, 'flow_observed_m3s', { gaugedMaxM3s: null, source: '  ' })).toEqual({});
		expect(ratingField(q, 'flow_logger_m3s')).toEqual({ gaugedMaxM3s: null, gaugedMinM3s: null, source: '' });
	});

	it('blocks Save on what the API refuses: a range without its source, or the lowest gauging not below the highest', () => {
		expect(qualityFlagsError(base())).toBeNull();
		const noSource = { ...base(), ratings: { flow_logger_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: null, source: '' } } };
		expect(qualityFlagsError(noSource)).toBe('Logger record gauged range: A gauged range needs its source.');
		const inverted = { ...base(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 1, gaugedMinM3s: 2, source: 's' } } };
		expect(qualityFlagsError(inverted)).toMatch(/^Gauge record gauged range: The lowest gauging must be below the highest\.$/);
		// Positive control: a complete range is fine.
		expect(qualityFlagsError({ ...base(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: 0.05, source: 's' } } })).toBeNull();
	});
});
