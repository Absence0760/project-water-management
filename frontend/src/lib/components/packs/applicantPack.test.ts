import { describe, expect, it } from 'vitest';
import type { ApplicantPackOwnUnit } from '$lib/api';
import { applicantPackHref, bandText, otherUnitLines, othersSummary, ownUnitLines, rowChange, rowLabel, rowValue, siteLines, standingLine } from './applicantPack';

const own = (over: Partial<ApplicantPackOwnUnit> = {}): ApplicantPackOwnUnit => ({
	name: 'Kalkoenkrans',
	kind: 'farm',
	onlyIn: null,
	suppliedA: 0.8,
	suppliedB: 0.9,
	timeReliabilityA: null,
	timeReliabilityB: null,
	annualReliabilityA: null,
	annualReliabilityB: null,
	change: { run: 10, band: { n: 30, p5: 8, p50: 10, p95: 12 }, worse: null },
	...over
});

describe('applicantPackHref', () => {
	it('points at the applicant’s pack view, every part encoded', () => {
		expect(applicantPackHref('/b', 'p 1', 's/2', 'k?3')).toBe('/b/projects/p%201/scenarios/s%2F2/packs/k%3F3');
	});
});

describe('standingLine', () => {
	const at = '2026-09-30T10:00:00Z';
	it('says whether the pack stands, and why not', () => {
		expect(standingLine({ status: 'issued', version: 2, issuedAt: at, withdrawnReason: null })).toMatch(/^Version 2, issued 2026-09-30\. It stands/);
		expect(standingLine({ status: 'superseded', version: 1, issuedAt: at, withdrawnReason: null })).toMatch(/replaced by a newer version\. It no longer stands\.$/);
		expect(standingLine({ status: 'withdrawn', version: 1, issuedAt: at, withdrawnReason: 'An error in the rule table' })).toContain('was withdrawn: An error in the rule table. It no longer stands.');
	});
});

describe('the river rows', () => {
	it('words each row by its id, with its unit and a signed change', () => {
		expect(rowLabel({ id: 'reserve', subject: 'Sandspruit weir' })).toBe('Reserve months met at Sandspruit weir');
		expect(rowLabel({ id: 'reserve', subject: null })).toBe('Reserve months met at the catchment outlet');
		expect(rowValue('ewrDays', 12)).toBe('12 days');
		expect(rowValue('shortfall', null)).toBe('–');
		expect(rowChange('ewrDays', 2)).toBe('+2 days');
		expect(rowChange('ewrDays', -3)).toBe('−3 days');
		expect(rowChange('ewrDays', 0)).toBe('0 days');
		expect(rowChange('reserve', -5.25)).toBe('−5.3 points');
		expect(bandText({ n: 30, p5: 1, p50: 2, p95: 3 }, (v) => rowChange('ewrDays', v))).toBe('likely +1 days to +3 days (30 model sets)');
		expect(bandText({ n: 30, p5: null, p50: null, p95: null }, String)).toBeNull();
	});

	it('names a gauge’s site, never the outlet, and counts the months lost', () => {
		const lines = siteLines(
			[
				{ name: null, isOutlet: true, category: 'C', monthsA: 12, rateA: 0.9, rateB: 0.8, longestA: 1, longestB: 2, lost: 1, gained: 0 },
				{ name: 'Sandspruit weir', isOutlet: false, category: 'B', monthsA: 12, rateA: 1, rateB: 1, longestA: 0, longestB: 0, lost: 0, gained: 0 }
			],
			true
		);
		expect(lines).toEqual([
			{ place: 'Catchment outlet', base: 'met in 90.0% of 12 months', withApp: 'met in 80.0% of 12 months', change: '1 more month below the Reserve' },
			{ place: 'Sandspruit weir', base: 'met in 100.0% of 12 months', withApp: 'met in 100.0% of 12 months', change: 'no change in the months met' }
		]);
	});
});

describe('the units', () => {
	it('shows their own units in full, and an added one as added', () => {
		expect(ownUnitLines([own(), own({ name: 'My new dam', onlyIn: 'application', suppliedA: null, change: null })])).toEqual([
			{ name: 'Kalkoenkrans', kind: 'Farm', base: '80.0%', withApp: '90.0%', change: '+10 points', band: 'likely +8 points to +12 points (30 model sets)' },
			{ name: 'My new dam', kind: 'Farm, added by the application', base: 'not in the baseline', withApp: '90.0%', change: '–', band: null }
		]);
	});

	it('shows every other unit by kind and number only', () => {
		const others = [
			{ kind: 'farm' as const, n: 1, changePts: -4 },
			{ kind: 'farm' as const, n: 2, changePts: 0 },
			{ kind: 'user' as const, n: 1, changePts: 3 }
		];
		expect(otherUnitLines(others)).toEqual([
			{ name: 'Farm 1', change: '−4 points' },
			{ name: 'Farm 2', change: 'no change' },
			{ name: 'Water user 1', change: '+3 points' }
		]);
		expect(othersSummary(others)).toBe('Of 3 other units, 1 gets less of its demand and 1 more.');
		expect(othersSummary([{ kind: 'farm', n: 1, changePts: 0 }])).toBe('The one other unit doesn’t change by a whole point or more.');
		expect(othersSummary([{ kind: 'farm', n: 1, changePts: 0 }, { kind: 'user', n: 1, changePts: 0 }])).toBe('None of the 2 other units changes by a whole point or more.');
		expect(othersSummary([])).toBe('No other farm or water user is in both runs.');
	});
});
