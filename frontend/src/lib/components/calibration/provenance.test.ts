import { describe, expect, it } from 'vitest';
import { apanDailyText, chirpsFactorsText, fitModelLabel, monthsText, paramLabel } from './provenance';

describe('paramLabel', () => {
	it('names GR4J’s parameters, and falls back to the key (a stored legacy fit’s, engine < 1.0.0)', () => {
		expect(paramLabel('gr4j', 'x1')).toMatch(/X1$/);
		expect(paramLabel('legacy', 'a')).toBe('a');
		expect(paramLabel('gr4j', 'a')).toBe('a');
		expect(paramLabel('nope', 'x1')).toBe('x1');
	});
});

describe('chirpsFactorsText', () => {
	it('shows recorded CHIRPS factors (calendar months) in water-year order, a month without one as a dash', () => {
		expect(chirpsFactorsText(Array(12).fill(1.5))).toBe('1.50 every month');
		const jan = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, null, 2.2];
		expect(chirpsFactorsText(jan)).toBe('Oct 2.00, Nov –, Dec 2.20, Jan 1.10, Feb 1.20, Mar 1.30, Apr 1.40, May 1.50, Jun 1.60, Jul 1.70, Aug 1.80, Sep 1.90');
	});
});

describe('monthsText', () => {
	it('shows a uniform monthly value once, and every month by name otherwise', () => {
		expect(monthsText(Array(12).fill(0.7))).toBe('0.70 every month');
		const varied = [0.65, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7];
		expect(monthsText(varied)).toBe('Oct 0.65, Nov 0.70, Dec 0.70, Jan 0.70, Feb 0.70, Mar 0.70, Apr 0.70, May 0.70, Jun 0.70, Jul 0.70, Aug 0.70, Sep 0.70');
		expect(monthsText([150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100], 0)).toMatch(/^Oct 150, Nov 180, .*Sep 100$/);
	});
});

describe('fitModelLabel', () => {
	it('marks a stored legacy fit as the removed model (issue #16)', () => {
		expect(fitModelLabel('gr4j')).toBe('GR4J');
		expect(fitModelLabel('legacy')).toBe('Legacy (removed in engine 1.0.0)');
	});
});

describe('apanDailyText (issue #45)', () => {
	it('says whether the fit ran on a daily A-pan series, and which', () => {
		expect(apanDailyText(undefined)).toBe('not recorded (fit made before this was tracked)');
		expect(apanDailyText(null)).toBe('none (monthly means only)');
		expect(apanDailyText({ startDate: '2020-10-01', length: 1461, valuesSha256: '0123456789abcdef'.repeat(4) })).toBe('from 2020-10-01, 1\u202f461 days (SHA-256 0123456789ab)');
	});
});
