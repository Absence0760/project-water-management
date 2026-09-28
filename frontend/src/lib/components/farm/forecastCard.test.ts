import { describe, expect, it } from 'vitest';
import { vaalbankFixture } from './fixture';
import { forecastCard, forecastFine } from './forecastCard';

const sp = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, ' ') ?? null;
const withForecast = (over: Partial<NonNullable<ReturnType<typeof vaalbankFixture>['farm']['forecast']>> = {}) => {
	const v = vaalbankFixture();
	v.farm.forecast = { from: '2024-01-11', to: '2024-01-24', days: 14, madeOn: '2024-01-11', minDamPct: 0.3812, minDamDate: '2024-01-20', deficitDays: 3, suppliedFraction: 0.8, ...over };
	return v.farm;
};

describe('forecastCard (Next 14 days, WP-2.12)', () => {
	it('is left out when the published run has no forecast', () => {
		expect(forecastCard(vaalbankFixture().farm, '2024-01-12')).toBeNull();
	});

	it('gives the lowest dam level expected and around when, the days that may be short, and the forecast’s own dates', () => {
		const vm = forecastCard(withForecast(), '2024-01-12')!;
		expect(sp(vm.title)).toBe('Next 14 days');
		expect(sp(vm.dam)).toBe('Lowest dam level expected: about 38 % around 20 Jan');
		expect(vm.short).toBe('You may be short on 3 of the 14 days.');
		expect(vm.fine).toBe(`From the rain forecast of 11 Jan, for 11 Jan to 24 Jan. ${forecastFine()}`);
		expect(vm.old).toBeNull();
	});

	it('says when no short day is expected, and leaves the dam line out for a farm with no dam', () => {
		const vm = forecastCard(withForecast({ deficitDays: 0, minDamPct: null, minDamDate: null }), '2024-01-12')!;
		expect(vm.dam).toBeNull();
		expect(vm.short).toBe('The model doesn’t expect you to be short on any of these 14 days.');
	});

	it('flags a forecast more than 3 days old (positive control: 3 days is not flagged)', () => {
		expect(forecastCard(withForecast(), '2024-01-14')!.old).toBeNull();
		expect(sp(forecastCard(withForecast(), '2024-01-15')!.old)).toBe('This forecast is 4 days old. Your WUA may publish a newer one.');
	});

	it('never words a forecast as certain', () => {
		const vm = forecastCard(withForecast(), '2024-01-20')!;
		expect(Object.values(vm).join(' ')).not.toMatch(/\bwill\b|guarantee|certain/i);
	});
});
