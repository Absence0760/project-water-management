import { afterEach, describe, expect, it } from 'vitest';
import type { SharedCatchmentView } from '$lib/api/types';
import { setLocale } from '$lib/i18n/locale.svelte';
import { addMonths, type FlowMonth } from './chart';
import { DEFAULT_WINDOW, printedLine, SUMMARY_MIN_MONTHS, SUMMARY_WINDOWS, summaryMonths, summaryRows, windowDates, windowLine, windowName, windowSpan } from './summary';

/** Intl joins dates and our figures with no-break spaces; compare with plain ones. */
const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

const CV: SharedCatchmentView = {
	runStart: '2021-10-01',
	dataUntil: '2024-01-10',
	season: { from: '2023-10-01', to: '2024-01-10', days: 102 },
	last30: { from: '2023-12-12', to: '2024-01-10', days: 30 },
	runDays: 832,
	farmCount: 6,
	sites: [
		{ name: null, isOutlet: true, daysNotMet: { run: 40, season: 12, last30: 3 } },
		{ name: 'Middle weir', isOutlet: false, daysNotMet: { run: 0, season: 0, last30: 0 } },
		{ name: 'Top weir', isOutlet: false, daysNotMet: { run: 832, season: 102, last30: 30 } }
	]
};

/** Every month of the run, Oct 2021 to Jan 2024 (28 months). */
const MONTHS: FlowMonth[] = Array.from({ length: 28 }, (_, i) => ({ month: addMonths('2021-10', i), flow: i, ewr: 5 }));

describe('the periods', () => {
	it('are the three the publication counts the reserve over, the season first on offer', () => {
		expect(SUMMARY_WINDOWS).toEqual(['last30', 'season', 'run']);
		expect(DEFAULT_WINDOW).toBe('season');
	});

	it('span the publication’s own days', () => {
		expect(windowSpan(CV, 'last30')).toEqual(CV.last30);
		expect(windowSpan(CV, 'season')).toEqual(CV.season);
		expect(windowSpan(CV, 'run')).toEqual({ from: '2021-10-01', to: '2024-01-10', days: 832 });
	});

	it('are named with their dates', () => {
		expect(windowName('run')).toBe('The whole model run');
		expect(sp(windowDates(CV, 'season'))).toBe('1 Oct 2023 to 10 Jan 2024');
		expect(sp(windowLine(CV, 'last30'))).toBe('The last 30 days: 12 Dec 2023 to 10 Jan 2024');
		expect(sp(printedLine('2024-01-12'))).toBe('Printed on 12 Jan 2024.');
	});
});

describe('summaryRows', () => {
	it('counts each site over the chosen period, always with its dates, the outlet unnamed', () => {
		const rows = summaryRows(CV, 'season').map((r) => ({ ...r, line: sp(r.line) }));
		expect(rows).toEqual([
			{ place: 'At the catchment outlet', state: 'partly', line: 'Below its reserve on 12 of the 102 days from 1 Oct 2023 to 10 Jan 2024.' },
			{ place: 'At Middle weir', state: 'met', line: 'Kept its reserve on every one of the 102 days from 1 Oct 2023 to 10 Jan 2024.' },
			{ place: 'At Top weir', state: 'missed', line: 'Below its reserve on all of the 102 days from 1 Oct 2023 to 10 Jan 2024.' }
		]);
	});

	it('reads the count of the period chosen', () => {
		expect(sp(summaryRows(CV, 'last30')[0]!.line)).toBe('Below its reserve on 3 of the 30 days from 12 Dec 2023 to 10 Jan 2024.');
		expect(sp(summaryRows(CV, 'run')[0]!.line)).toBe('Below its reserve on 40 of the 832 days from 1 Oct 2021 to 10 Jan 2024.');
		expect(summaryRows(CV, 'run')[2]!.state).toBe('missed');
	});
});

describe('the dates in a skewed time zone', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('prints the publication’s calendar days whatever the reader’s zone', () => {
		for (const zone of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
			process.env.TZ = zone;
			expect(sp(windowDates(CV, 'run')), zone).toBe('1 Oct 2021 to 10 Jan 2024');
			expect(sp(printedLine('2024-01-12')), zone).toBe('Printed on 12 Jan 2024.');
			expect(sp(summaryRows(CV, 'last30')[1]!.line), zone).toBe('Kept its reserve on every one of the 30 days from 12 Dec 2023 to 10 Jan 2024.');
		}
	});
});

describe('summaryMonths', () => {
	it('draws the whole run for the whole run', () => {
		expect(summaryMonths(MONTHS, CV, 'run')).toEqual(MONTHS);
	});

	it('never draws fewer than a year, counting back from the period’s last month', () => {
		const season = summaryMonths(MONTHS, CV, 'season');
		expect(season).toHaveLength(SUMMARY_MIN_MONTHS);
		expect(season.at(-1)!.month).toBe('2024-01');
		expect(season[0]!.month).toBe('2023-02');
		expect(summaryMonths(MONTHS, CV, 'last30')).toEqual(season);
	});

	it('draws a long season whole, and nothing past the period’s end', () => {
		const long = { ...CV, season: { from: '2022-10-01', to: '2023-12-31', days: 457 } };
		const months = summaryMonths(MONTHS, long, 'season');
		expect(months[0]!.month).toBe('2022-10');
		expect(months.at(-1)!.month).toBe('2023-12');
		expect(months).toHaveLength(15);
	});

	it('draws what there is of a short run', () => {
		expect(summaryMonths(MONTHS.slice(0, 5), CV, 'season')).toHaveLength(5);
	});
});

describe('in Afrikaans', () => {
	afterEach(() => setLocale('en'));

	it('words the paper in the reader’s language', async () => {
		await setLocale('af');
		expect(windowName('run')).toBe('Die hele modellopie');
		expect(sp(summaryRows(CV, 'season')[0]!.line)).toMatch(/^Onder sy reserwe op 12 van die 102 dae van 1 Okt\.? 2023 tot 10 Jan\.? 2024\.$/);
	});
});
