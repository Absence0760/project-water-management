import { describe, expect, it } from 'vitest';
import type { RecordRepresentativeness } from '@water-management/engine';
import { ordinal, representativenessGist, representativenessKey, representativenessRows } from './representativeness';

const NNBSP = ' ';

const base: RecordRepresentativeness = {
	scoredDays: 1096,
	waterYears: 3,
	years: [
		{ waterYear: 2015, scoredDays: 366, rainMm: 1234.4, percentile: 12.5, class: 'dry' },
		{ waterYear: 2016, scoredDays: 365, rainMm: 700, percentile: 51, class: 'normal' },
		{ waterYear: 2017, scoredDays: 365, rainMm: null, percentile: null, class: null }
	],
	longTerm: { years: 30, firstYear: 1990, lastYear: 2019, meanMm: 800, medianMm: 790 },
	calibrationMeanMm: 967.2,
	meanRatio: 0.8249,
	thresholds: { dry: 33, wet: 67 },
	summary: 'The calibration record has 1096 scored days over 3 water years.',
	notes: []
};

describe('ordinal', () => {
	it('names 1st, 2nd, 3rd, 11th–13th, 21st, 33rd, 67th', () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 33, 67, 100, 111].map(ordinal)).toEqual([
			'1st',
			'2nd',
			'3rd',
			'4th',
			'11th',
			'12th',
			'13th',
			'21st',
			'22nd',
			'33rd',
			'67th',
			'100th',
			'111th'
		]);
	});
});

describe('representativenessRows', () => {
	it('shows each scored year with its rain, percentile and class, and an incomplete year as such', () => {
		expect(representativenessRows(base)).toEqual([
			{ year: 'WY 2015/16', scoredDays: '366', rain: `1${NNBSP}234 mm`, percentile: '13th', klass: 'Dry', cls: 'dry' },
			{ year: 'WY 2016/17', scoredDays: '365', rain: '700 mm', percentile: '51st', klass: 'Near normal', cls: 'normal' },
			{ year: 'WY 2017/18', scoredDays: '365', rain: 'incomplete', percentile: '–', klass: '–', cls: null }
		]);
	});
});

describe('representativenessKey and representativenessGist', () => {
	it('names the long-term reference and the thresholds', () => {
		expect(representativenessKey(base)).toBe(
			"Percentile: where the year's rain sits among the 30 complete water years of the run's rain (WY 1990/91–2019/20, CHIRPS-filled days included); 50th is the median. Dry is below the 33rd, wet above the 67th."
		);
		expect(representativenessKey({ ...base, longTerm: null })).toMatch(/^Percentile: where the year's rain sits among the run's rain, which has no complete water year;/);
	});
	it('gives the length and the mean-rain ratio in one line', () => {
		expect(representativenessGist(base)).toBe('3 water years · mean rain 82 % of the long-term mean');
		expect(representativenessGist({ ...base, waterYears: 1, meanRatio: null })).toBe('1 water year');
	});
});
