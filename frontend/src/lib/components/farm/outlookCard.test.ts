import type { FarmView } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { outlookCard, outlookFine } from './outlookCard';

const sp = (s: string | null) => s?.replace(/[  ]/g, ' ') ?? null;
type O = NonNullable<FarmView['outlook']>;
const outlook = (over: Partial<O> = {}): Pick<FarmView, 'outlook'> => ({
	outlook: {
		decisionDate: '2025-10-01',
		seasonEnd: '2026-04-30',
		reviewDate: '2026-01-01',
		level: { id: '1', label: '85 %' },
		nYears: 24,
		demandYears: 24,
		demandMet: { p10: 0.62, p50: 0.81, p90: 0.97 },
		dam: { capacityM3: 120_000, seasonEndShare: { p10: 0.18, p50: 0.44, p90: 0.71 } },
		publishedAt: '2025-09-28T08:00:00.000Z',
		...over
	}
});

describe('outlookCard (This season, issue #53 R5, E3)', () => {
	it('is left out with no published outlook, and once its season has ended', () => {
		expect(outlookCard({ outlook: null }, '2025-11-01')).toBeNull();
		expect(outlookCard({}, '2025-11-01')).toBeNull();
		expect(outlookCard(outlook(), '2026-05-01')).toBeNull();
		// Positive control: the season's last day still shows it.
		expect(outlookCard(outlook(), '2026-04-30')).not.toBeNull();
	});

	it('names the WUA’s level and season, what it gave the farm in past years’ weather, the dam at the end and the review date', () => {
		const vm = outlookCard(outlook(), '2025-11-01')!;
		expect(vm.title).toBe('This season');
		expect(sp(vm.level)).toBe('Your WUA set irrigation at 85 % for 1 Oct to 30 Apr.');
		expect(sp(vm.got)).toBe('In 24 past years’ weather, at this level you got about 81 % of the water you needed, and between 62 % and 97 % in most of them.');
		expect(sp(vm.dam)).toBe('Your dam ended the season about 44 % full, and between 18 % and 71 % in most of those years.');
		expect(sp(vm.review)).toBe('Your WUA reviews the level on 1 Jan.');
		expect(vm.fine).toBe(outlookFine());
	});

	it('leaves out the dam and review lines when there are none, and says why there is no range', () => {
		const vm = outlookCard(outlook({ dam: null, reviewDate: null, demandMet: null, demandYears: 5 }), '2025-11-01')!;
		expect(vm.dam).toBeNull();
		expect(vm.review).toBeNull();
		expect(vm.got).toBe('There are too few past years to give a range for you.');
		expect(outlookCard(outlook({ demandMet: null, demandYears: 0 }), '2025-11-01')!.got).toBe('The model has no irrigation demand for you this season.');
		// A dam but too few years for its range: no dam line.
		expect(outlookCard(outlook({ dam: { capacityM3: 1, seasonEndShare: null } }), '2025-11-01')!.dam).toBeNull();
	});

	it('says whether the WUA also weighed the seasonal forecasts, never a chance (issue #620, method c3s)', () => {
		expect(outlookCard(outlook(), '2025-11-01')!.forecast).toBeNull();
		expect(outlookCard(outlook({ forecast: null }), '2025-11-01')!.forecast).toBeNull();
		const led = outlookCard(outlook({ forecast: { leads: 'forecast' } }), '2025-11-01')!;
		expect(led.forecast).toBe('Your WUA also looked at the seasonal rain forecasts of the Copernicus Climate Change Service. The figures above are still from past years’ weather.');
		const notBetter = outlookCard(outlook({ forecast: { leads: 'esp' } }), '2025-11-01')!;
		expect(notBetter.forecast).toBe('Your WUA also checked the seasonal rain forecasts of the Copernicus Climate Change Service, but this season they did no better than past weather.');
		for (const vm of [led, notBetter]) expect(Object.values(vm).join(' ')).not.toMatch(/%\s*chance|chance of|probab/i);
	});

	it('never words the season as certain, or the level as the app’s', () => {
		for (const forecast of [undefined, { leads: 'forecast' as const }, { leads: 'esp' as const }]) {
			const vm = outlookCard(outlook({ forecast }), '2025-11-01')!;
			expect(Object.values(vm).join(' ')).not.toMatch(/\bwill\b|guarantee|certain|recommend|should/i);
		}
	});
});
