import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, type QualityFlagSettings } from '@water-management/engine';
import { qualityFlagsAtDefaults, qualityFlagsSummary } from './qualityFlagsLine';

const base = (): QualityFlagSettings => defaultProjectSettings().qualityFlags;

describe('qualityFlagsSummary (the Calibration record’s folded line)', () => {
	const gauge = ['flow_observed_m3s'] as const;
	it('reads the defaults in words', () => {
		expect(qualityFlagsSummary(base(), defaultProjectSettings().flowGapFill, gauge)).toBe(
			'gauged range not known · above-range days censored · below-range, suspect and infilled days left out · no river-stop months · flow gaps not filled'
		);
	});
	it('names the records with a range, each treatment once, the months and the filled records', () => {
		const q: QualityFlagSettings = {
			...base(),
			ratings: { flow_observed_m3s: { gaugedMaxM3s: 0.3, gaugedMinM3s: null, source: 's' }, flow_logger_m3s: { gaugedMaxM3s: null, gaugedMinM3s: 0.01, source: 's' } },
			aboveRating: 'exclude',
			suspect: 'include',
			zeroFlowMonths: [2, 3, 4]
		};
		const fill = { flow_observed_m3s: { interpolateMaxDays: 5, donor: null, donorMaxDays: 30, donorMinOverlapDays: 60 }, flow_logger_m3s: null };
		expect(qualityFlagsSummary(q, fill, ['flow_observed_m3s', 'flow_logger_m3s'])).toBe(
			'gauged range set for the gauge record and logger record · above-range, below-range and infilled days left out · suspect days scored as recorded · river stops Feb, Mar, Apr · gaps filled in the observed gauge flow'
		);
		// A range for a record not offered (its series is gone) isn't named.
		expect(qualityFlagsSummary(q, null, gauge)).toMatch(/^gauged range set for the gauge record · /);
	});
});

describe('qualityFlagsAtDefaults (the fold starts closed only then)', () => {
	it('is true for the defaults and false once any rule, range, month or gap fill differs', () => {
		const fill = defaultProjectSettings().flowGapFill;
		expect(qualityFlagsAtDefaults(base(), fill)).toBe(true);
		expect(qualityFlagsAtDefaults({ ...base(), suspect: 'include' }, fill)).toBe(false);
		expect(qualityFlagsAtDefaults({ ...base(), zeroFlowMonths: [2] }, fill)).toBe(false);
		expect(qualityFlagsAtDefaults({ ...base(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 1, gaugedMinM3s: null, source: 's' } } }, fill)).toBe(false);
		expect(qualityFlagsAtDefaults(base(), { flow_observed_m3s: { interpolateMaxDays: 5, donor: null, donorMaxDays: 30, donorMinOverlapDays: 60 }, flow_logger_m3s: null })).toBe(false);
	});
});
