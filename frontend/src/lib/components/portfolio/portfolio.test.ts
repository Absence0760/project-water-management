import { describe, expect, it } from 'vitest';
import type { PortfolioProject } from '$lib/api/types';
import {
	ageText,
	alertsText,
	curtailmentHref,
	damText,
	DEFAULT_SORT,
	ewrText,
	ewrWindowLabel,
	farmsShortText,
	farmsUnknownText,
	portfolioTotals,
	feedsText,
	last30Text,
	nextSort,
	parseSort,
	restrictionText,
	sortPortfolio,
	sourceText,
	statusCounts,
	statusSummary,
	thresholdsError,
	thresholdsRule,
	thresholdsSource
} from './portfolio';

const row = (over: Partial<PortfolioProject> = {}): PortfolioProject => ({
	id: 'p',
	name: 'Alpha',
	role: 'viewer',
	timeZone: 'Africa/Johannesburg',
	today: '2026-09-25',
	dataUntil: '2026-09-24',
	lastRunAt: '2026-09-25T06:00:00.000Z',
	publishedAt: '2026-09-25T07:00:00.000Z',
	source: 'published',
	sourceRunId: 'r1',
	figuresUntil: '2026-09-24',
	figuresAgeDays: 2,
	stale: false,
	behindData: false,
	newerRun: false,
	ewr: { status: 'red', daysNotMet30: 9, days30: 30, fraction30: 0.3 },
	farmsShort7: 2,
	farmsShort30: 5,
	farmCount: 14,
	lowestDamPct: { nodeName: 'Kareebos', pct: 0.183 },
	damsKnown: true,
	feeds: { total: 0, ok: 0, failing: 0 },
	alertsFiring: 0,
	restriction: { level: 'advisory', pct: 12.5 },
	...over
});
const unknown = (reason: 'no-figures' | 'no-ewr' | 'no-series') => ({ status: 'unknown' as const, daysNotMet30: null, days30: null, fraction30: null, reason });

describe('alerts (WP-2.13)', () => {
	it('counts the firing alerts in words', () => {
		expect(alertsText(row())).toBe('None');
		expect(alertsText(row({ alertsFiring: 1 }))).toBe('1 firing');
		expect(alertsText(row({ alertsFiring: 1200 }))).toBe('1\u202f200 firing');
	});
});

describe('wording: every status is words, every unknown says why', () => {
	it('EWR', () => {
		expect(ewrText(row())).toBe('Red: EWR not met 9 of 30 days');
		expect(ewrText(row({ ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 } }))).toBe('Amber: EWR not met 3 of 30 days');
		expect(ewrText(row({ ewr: { status: 'green', daysNotMet30: 0, days30: 30, fraction30: 0 } }))).toBe('Green: EWR met all 30 days');
		expect(ewrText(row({ ewr: unknown('no-figures') }))).toBe('Unknown: no run yet');
		expect(ewrText(row({ ewr: unknown('no-ewr') }))).toBe('Unknown: no EWR set in the run');
		expect(ewrText(row({ ewr: unknown('no-series') }))).toBe('Unknown: the run has no EWR record; run it again');
	});
	it('source and age', () => {
		expect(sourceText(row())).toBe('Published run');
		expect(sourceText(row({ newerRun: true }))).toBe('Published run (a newer run is not published)');
		expect(sourceText(row({ source: 'run' }))).toBe('Latest run, not published');
		expect(sourceText(row({ source: null }))).toBe('Not run yet');
		// The one age wording ($lib/format/age): the date, then how long ago.
		expect(ageText(row())).toBe('to 24 Sep 2026 (2 days ago)');
		expect(ageText(row({ figuresAgeDays: 1 }))).toBe('to 24 Sep 2026 (yesterday)');
		expect(ageText(row({ figuresAgeDays: 0 }))).toBe('to 24 Sep 2026 (today)');
		expect(ageText(row({ figuresAgeDays: 1002 }))).toBe('to 24 Sep 2026 (2 years ago)');
		// A project zone ahead of the server's still reads today.
		expect(ageText(row({ figuresAgeDays: -1 }))).toBe('to 24 Sep 2026 (today)');
		expect(ageText(row({ figuresUntil: null, figuresAgeDays: null }))).toBeNull();
	});
	it('farms, dams, restriction, feeds', () => {
		expect(farmsShortText(row())).toBe('2 of 14 hydrological units short this week');
		expect(farmsShortText(row({ farmCount: 1, farmsShort7: 0 }))).toBe('0 of 1 hydrological unit short this week');
		expect(farmsShortText(row({ farmCount: 0, farmsShort7: 0 }))).toBe('No hydrological units');
		expect(farmsShortText(row({ farmsShort7: null }))).toBeNull();
		// Stale figures (over a week): the week is the figures' last one, by its date.
		expect(farmsShortText(row({ figuresUntil: '2024-12-31', figuresAgeDays: 637 }))).toBe('2 of 14 hydrological units short in the week to 31 Dec 2024');
		expect(farmsShortText(row({ figuresAgeDays: 7 }))).toBe('2 of 14 hydrological units short this week');
		expect(last30Text(row())).toBe('in the last 30 days');
		expect(last30Text(row({ figuresUntil: '2024-12-31', figuresAgeDays: 637 }))).toBe('in the 30 days to 31 Dec 2024');
		expect(farmsUnknownText(row({ source: 'run' }))).toBe('Unknown until a run is published');
		expect(farmsUnknownText(row())).toBe('Unknown: publish again to count them');
		expect(damText(row())).toBe('Kareebos 18 %');
		expect(damText(row({ lowestDamPct: null }))).toBe('No dams');
		expect(damText(row({ damsKnown: false, lowestDamPct: null }))).toBe('Unknown until a run is published');
		expect(restrictionText(row())).toBe('Advisory · 12.5 %');
		expect(restrictionText(row({ restriction: { level: 'restricted', pct: null } }))).toBe('Restricted');
		expect(restrictionText(row({ restriction: { level: 'none', pct: null } }))).toBe('None');
		expect(restrictionText(row({ restriction: null }))).toBe('Not published');
		expect(feedsText(row())).toBe('No feeds');
		expect(feedsText(row({ feeds: { total: 2, ok: 2, failing: 0 } }))).toBe('2 feeds OK');
		expect(feedsText(row({ feeds: { total: 3, ok: 1, failing: 1 } }))).toBe('1 of 3 feeds failing or stale');
		expect(feedsText(row({ feeds: { total: 2, ok: 1, failing: 0 } }))).toBe('1 of 2 feeds OK, the rest waiting or off');
	});
});

describe('sorting', () => {
	const red = row({ id: 'red', name: 'Delta' });
	const redWorse = row({ id: 'red2', name: 'Echo', ewr: { status: 'red', daysNotMet30: 20, days30: 30, fraction30: 0.667 } });
	const amber = row({ id: 'amber', name: 'Charlie', ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 }, farmsShort7: 7, figuresAgeDays: 40, lowestDamPct: { nodeName: 'X', pct: 0.05 } });
	const green = row({ id: 'green', name: 'Bravo', ewr: { status: 'green', daysNotMet30: 0, days30: 30, fraction30: 0 }, farmsShort7: 0 });
	const unk = row({ id: 'unk', name: 'Alpha', ewr: unknown('no-figures'), farmsShort7: null, figuresAgeDays: null, lowestDamPct: null, damsKnown: false });
	const all = [green, unk, amber, red, redWorse];
	const ids = (rs: PortfolioProject[]) => rs.map((r) => r.id);

	it('by status, worst first: red (most days first), amber, unknown, green', () => {
		expect(ids(sortPortfolio(all, DEFAULT_SORT))).toEqual(['red2', 'red', 'amber', 'unk', 'green']);
		expect(ids(sortPortfolio(all, { key: 'status', dir: 'desc' }))).toEqual(['green', 'unk', 'amber', 'red', 'red2']);
	});
	it('unknowns go last either way on the numeric keys', () => {
		expect(ids(sortPortfolio(all, { key: 'farms', dir: 'asc' }))).toEqual(['amber', 'red', 'red2', 'green', 'unk']);
		expect(ids(sortPortfolio(all, { key: 'farms', dir: 'desc' })).at(-1)).toBe('unk');
		expect(ids(sortPortfolio(all, { key: 'dam', dir: 'asc' }))[0]).toBe('amber');
		expect(ids(sortPortfolio(all, { key: 'dam', dir: 'asc' })).at(-1)).toBe('unk');
		expect(ids(sortPortfolio(all, { key: 'age', dir: 'asc' }))[0]).toBe('amber');
	});
	it('by name, both ways', () => {
		expect(ids(sortPortfolio(all, { key: 'name', dir: 'asc' }))).toEqual(['unk', 'green', 'amber', 'red', 'red2']);
		expect(ids(sortPortfolio(all, { key: 'name', dir: 'desc' }))).toEqual(['red2', 'red', 'amber', 'green', 'unk']);
	});
	it('doesn’t change its input', () => {
		const copy = [...all];
		sortPortfolio(all, DEFAULT_SORT);
		expect(all).toEqual(copy);
	});
	it('a heading click flips the same key and starts a new one worst first; the URL falls back to the default', () => {
		expect(nextSort(DEFAULT_SORT, 'status')).toEqual({ key: 'status', dir: 'desc' });
		expect(nextSort({ key: 'status', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
		expect(parseSort(null, null)).toEqual(DEFAULT_SORT);
		expect(parseSort('farms', 'desc')).toEqual({ key: 'farms', dir: 'desc' });
		expect(parseSort('toString', 'sideways')).toEqual(DEFAULT_SORT);
	});
	it('counts statuses for the summary line', () => {
		expect(statusCounts(all)).toEqual({ red: 2, amber: 1, green: 1, unknown: 1 });
	});
});

describe('curtailmentHref', () => {
	it('opens the run on the Runs tab with the last 7 days as its reporting window', () => {
		expect(curtailmentHref({ id: 'p1', sourceRunId: 'r1' }, '/app')).toBe('/app/projects/p1?tab=supply&run=r1&window=last7#res-curtailment');
	});
});

describe('the thresholds (D11)', () => {
	it('writes the rule the statuses were judged by, decimals trimmed', () => {
		expect(thresholdsRule({ green: 5, amber: 20 })).toBe('green when it was not met on under 5 % of them, amber under 20 %, red otherwise');
		expect(thresholdsRule({ green: 2.5, amber: 12.75 })).toBe('green when it was not met on under 2.5 % of them, amber under 12.75 %, red otherwise');
	});
	it('says whose they are, and that the defaults still wait for the hydrologist', () => {
		expect(thresholdsSource({ source: 'team' })).toBe('These are the team’s own thresholds.');
		expect(thresholdsSource({ source: 'default' })).toBe('These are the default thresholds, still to be confirmed by the hydrologist.');
	});
	it('checks the team page form as the API does: numbers, 0–100 %, green below amber', () => {
		expect(thresholdsError(5, 20)).toBeNull();
		expect(thresholdsError(0, 100)).toBeNull();
		expect(thresholdsError(2.5, 2.6)).toBeNull();
		expect(thresholdsError(Number.NaN, 20)).toBe('Enter both cut-offs as numbers.');
		expect(thresholdsError(null as unknown as number, 20)).toBe('Enter both cut-offs as numbers.');
		expect(thresholdsError(-1, 20)).toBe('Each cut-off is a percentage from 0 to 100.');
		expect(thresholdsError(5, 101)).toBe('Each cut-off is a percentage from 0 to 100.');
		expect(thresholdsError(20, 20)).toBe('The green cut-off must be below the amber one.');
		expect(thresholdsError(30, 20)).toBe('The green cut-off must be below the amber one.');
	});
});

describe('the EWR label over several catchments', () => {
	const stale = { figuresUntil: '2024-12-31', figuresAgeDays: 637 };
	it('says "last 30 days" only while every catchment’s figures are current', () => {
		expect(ewrWindowLabel([row(), row({ figuresUntil: null, figuresAgeDays: null })])).toBe('EWR, last 30 days');
		expect(ewrWindowLabel([])).toBe('EWR, last 30 days');
	});
	it('names the day when every catchment’s figures end on the same stale one', () => {
		expect(ewrWindowLabel([row(stale), row(stale)])).toBe('EWR, 30 days to 31 Dec 2024');
	});
	it('stays neutral when the catchments’ figures end on different days, one of them stale', () => {
		expect(ewrWindowLabel([row(stale), row()])).toBe('EWR, last 30 days of figures');
	});
});

describe('totals (the teams list, the team page and the portfolio header)', () => {
	it('lists the statuses worst first, leaving out the empty ones', () => {
		expect(statusSummary({ red: 1, amber: 0, unknown: 2, green: 4 })).toBe('1 red, 2 unknown, 4 green');
		expect(statusSummary({ red: 0, amber: 0, unknown: 0, green: 0 })).toBe('');
	});

	it('counts the statuses, the alerts firing and the stale catchments', () => {
		const t = portfolioTotals([
			row({ id: 'a', alertsFiring: 1, stale: true }),
			row({ id: 'b', ewr: { status: 'green', daysNotMet30: 0, days30: 30, fraction30: 0 } }),
			row({ id: 'c', alertsFiring: 2, ewr: unknown('no-figures') })
		]);
		expect(t).toEqual({ catchments: 3, counts: { red: 1, amber: 0, green: 1, unknown: 1 }, alertsFiring: 3, stale: 1 });
		expect(portfolioTotals([])).toEqual({ catchments: 0, counts: { red: 0, amber: 0, green: 0, unknown: 0 }, alertsFiring: 0, stale: 0 });
	});
});
