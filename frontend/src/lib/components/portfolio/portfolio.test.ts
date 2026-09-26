import { describe, expect, it } from 'vitest';
import type { PortfolioProject } from '$lib/api/types';
import {
	ageText,
	damText,
	DEFAULT_SORT,
	ewrText,
	farmsShortText,
	farmsUnknownText,
	feedsText,
	nextSort,
	parseSort,
	restrictionText,
	sortPortfolio,
	sourceText,
	statusCounts
} from './portfolio';

const row = (over: Partial<PortfolioProject> = {}): PortfolioProject => ({
	id: 'p',
	name: 'Alpha',
	role: 'viewer',
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
	farmCount: 12,
	lowestDamPct: { nodeName: 'Kareebos', pct: 0.183 },
	damsKnown: true,
	feeds: { total: 0, ok: 0, failing: 0 },
	alertsFiring: null,
	restriction: { level: 'advisory', pct: 12.5 },
	...over
});
const unknown = (reason: 'no-figures' | 'no-ewr' | 'no-series') => ({ status: 'unknown' as const, daysNotMet30: null, days30: null, fraction30: null, reason });

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
		expect(ageText(row())).toBe('to 24 Sep 2026, 2 days ago');
		expect(ageText(row({ figuresAgeDays: 1 }))).toBe('to 24 Sep 2026, yesterday');
		expect(ageText(row({ figuresAgeDays: 0 }))).toBe('to 24 Sep 2026, today');
		expect(ageText(row({ figuresAgeDays: 1002 }))).toBe('to 24 Sep 2026, 1,002 days ago');
		expect(ageText(row({ figuresUntil: null, figuresAgeDays: null }))).toBeNull();
	});
	it('farms, dams, restriction, feeds', () => {
		expect(farmsShortText(row())).toBe('2 of 12 farms short this week');
		expect(farmsShortText(row({ farmCount: 1, farmsShort7: 0 }))).toBe('0 of 1 farm short this week');
		expect(farmsShortText(row({ farmCount: 0, farmsShort7: 0 }))).toBe('No farms');
		expect(farmsShortText(row({ farmsShort7: null }))).toBeNull();
		expect(farmsUnknownText(row({ source: 'run' }))).toBe('Unknown until a run is published');
		expect(farmsUnknownText(row())).toBe('Unknown: publish again to count them');
		expect(damText(row())).toBe('Kareebos 18 %');
		expect(damText(row({ lowestDamPct: null }))).toBe('No farm dams');
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
