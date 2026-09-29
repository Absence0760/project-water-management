import { describe, expect, it } from 'vitest';
import { dayQuality, defaultQualityFlags, FLAG_USE_TEXT, FLOW_DAY_FLAGS, FLOW_FLAG_CODE, scoringDays, type DayQuality } from '@water-management/engine';
import { dayQualityGist, FLOW_ROWS, flowRows, rainRows, ratingLine, shareText, USE_TEXT } from './dayQuality';

/** A summary built by the engine, so the panel is tested against the real shape. */
function summary(over: Partial<DayQuality> = {}): DayQuality {
	const c = FLOW_FLAG_CODE;
	const flags = Uint8Array.from([c.inRange, c.inRange, c.inRange, c.suspect, c.missing, c.aboveRating]);
	const settings = { ...defaultQualityFlags(), ratings: { flow_observed_m3s: { gaugedMaxM3s: 12, gaugedMinM3s: 0.05, source: 'DWS gaugings' } } };
	const windowIdx = [0, 1, 2, 3, 4, 5];
	const q = dayQuality({
		flowKind: 'flow_observed_m3s',
		settings,
		windowIdx,
		flags,
		scoring: scoringDays(windowIdx, flags, settings, settings.ratings.flow_observed_m3s, 6),
		observed: Float64Array.from([1, 2, 3, 0, NaN, 20]),
		rainFlags: Uint8Array.from([0, 1, 0, 0, 0, 0]),
		zeroRunMask: Uint8Array.from([0, 1, 0, 0, 0, 0])
	});
	return { ...q, ...over };
}

describe('the data-quality panel (CR-22)', () => {
	it('mirrors the engine’s classes and treatment words (it doesn’t import them at run time)', () => {
		expect(FLOW_ROWS.map((r) => r.flag).sort()).toEqual([...FLOW_DAY_FLAGS].sort());
		expect(USE_TEXT).toEqual(FLAG_USE_TEXT);
	});

	it('lists each flow class with its days, share of the window and what the fit did', () => {
		expect(flowRows(summary())).toEqual([
			{ label: 'In the gauged range', days: '3', share: '50.0 %', treatment: 'scored' },
			{ label: 'Above the highest gauging', days: '1', share: '16.7 %', treatment: 'censored at the highest gauging' },
			{ label: 'Below the lowest gauging', days: '0', share: '0.0 %', treatment: 'left out' },
			{ label: 'Suspect (outlier or flat stretch)', days: '1', share: '16.7 %', treatment: 'left out' },
			{ label: 'Missing', days: '1', share: '16.7 %', treatment: 'no reading' }
		]);
	});

	it('says "Not flagged" instead of "in the gauged range" when no gauged range is recorded', () => {
		expect(flowRows(summary({ rating: null }))[0]!.label).toBe('Not flagged (no gauged range recorded)');
		expect(ratingLine(summary({ rating: null }))).toBe('No gauged range recorded for this record.');
		expect(ratingLine(summary())).toBe('Gauged range 0.050–12.00 m³/s (DWS gaugings).');
	});

	it('shows the scored days’ rain by source, zero runs set aside among them', () => {
		expect(rainRows(summary())).toEqual([
			{ label: 'Catchment gauge reading', days: '3', share: '75.0 %' },
			{ label: 'Infilled (CHIRPS, forecast or another gauge)', days: '1', share: '25.0 %' },
			{ label: 'of which zero-rain runs set aside as missing', days: '1', share: '25.0 %' }
		]);
		expect(rainRows(summary({ rain: null }))).toBeNull();
	});

	it('gist: days scored of the observed days, left out and censored', () => {
		expect(dayQualityGist(summary())).toBe('4 of 5 observed days scored · 1 left out · 1 censored');
	});

	it('shareText never shows a sliver as nothing', () => {
		expect(shareText(1, 10_000)).toBe('<0.1 %');
		expect(shareText(0, 10)).toBe('0.0 %');
		expect(shareText(1, 0)).toBe('–');
	});
});
