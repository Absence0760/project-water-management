import { describe, expect, it } from 'vitest';
import type { EwrAssuranceSite, EwrCompliance, RunSummary } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { RIVER_ANCHORS, riverAnchor, riverHref } from './links';
import { ewrRuleText, perYear, pickRiverRun, riverKpis, riverNavGroups, worstMonth, type RiverKpi } from './river';

const meta = (id: string, createdAt: string): RunMeta => ({
	id,
	label: id,
	engineVersion: '0.40.0',
	startDate: '2020-10-01',
	endDate: '2022-09-30',
	createdAt,
	createdBy: null,
	legacy: false
});

/** A two-water-year grid: `notMet[m]` days not met in month m of each year, 30 days a month. */
const grid = (notMet: number[]): EwrCompliance => ({
	waterYears: [2020, 2021],
	days: [Array(12).fill(30), Array(12).fill(30)],
	outlet: { nodeId: null, name: 'Outflow gauge', daysNotMet: [notMet, notMet], shortfallM3: [notMet, notMet] },
	farms: []
});

const summary = (over: Partial<RunSummary['catchment']> = {}, rest: Partial<RunSummary> = {}): RunSummary =>
	({
		farms: [],
		catchment: { meanNaturalFlowM3Day: 86_400, meanSimulatedOutflowM3Day: 43_200, ewrDaysNotMet: 73, ewrFractionDaysNotMet: 0.1, ...over },
		calibration: null,
		warnings: [],
		...rest
	}) as RunSummary;

const site = (nodeId: string | null, name: string, met: number, months: number): EwrAssuranceSite =>
	({
		nodeId,
		name,
		isOutlet: nodeId === null,
		overall: { months, met, rate: months ? met / months : null, deficitM3: 0, longestNotMetRun: 1, meanShortfallPct: null }
	}) as EwrAssuranceSite;

const tile = (ks: RiverKpi[], id: RiverKpi['id']) => ks.find((k) => k.id === id)!;

describe('riverHref and riverAnchor', () => {
	it('builds ?tab=river with the run and a panel', () => {
		expect(riverHref()).toBe('?tab=river');
		expect(riverHref('r 1')).toBe('?tab=river&run=r%201');
		expect(riverHref('r1', 'res-reserve')).toBe('?tab=river&run=r1#res-reserve');
		expect(riverHref(null, 'res-ewr')).toBe('?tab=river#res-ewr');
	});
	it('knows the panels that moved from Runs & results, and no others', () => {
		for (const id of ['res-reserve', 'res-ewr', 'res-ewr-grid', 'res-uncertainty', 'res-outcomes', 'res-outlook', 'res-water-account']) expect(riverAnchor(id)).toBe(true);
		for (const id of ['res-curtailment', 'res-ewr-agreement', 'res-summary', '']) expect(riverAnchor(id)).toBe(false);
	});
});

describe('riverNavGroups', () => {
	const ids = (hasReserve: boolean) => riverNavGroups(hasReserve).flatMap((g) => g.sections.map((s) => s.id));
	it('links every panel in page order, and only panels the page anchors', () => {
		expect(ids(true)).toEqual([...RIVER_ANCHORS]);
		for (const id of ids(true)) expect(riverAnchor(id)).toBe(true);
	});
	it('leaves out Reserve compliance when the run has none (the page has no such panel then)', () => {
		expect(ids(false)).toEqual(RIVER_ANCHORS.filter((id) => id !== 'res-reserve'));
	});
});

describe('pickRiverRun', () => {
	const a = meta('a', '2026-09-01T10:00:00Z');
	const b = meta('b', '2026-09-03T10:00:00Z');
	const c = meta('c', '2026-09-02T10:00:00Z');
	it('is null without runs', () => {
		expect(pickRiverRun(null, null)).toBeNull();
		expect(pickRiverRun([], 'a')).toBeNull();
	});
	it('defaults to the newest run by createdAt, compared with the one before', () => {
		expect(pickRiverRun([a, b, c], null)).toEqual({ run: b, previous: c });
	});
	it('shows the run the URL names, compared with the run made before it', () => {
		expect(pickRiverRun([a, b, c], 'c')).toEqual({ run: c, previous: a });
		expect(pickRiverRun([a, b, c], 'a')).toEqual({ run: a, previous: null });
	});
	it('falls back to the newest run when the URL names a run that is gone', () => {
		expect(pickRiverRun([a, b, c], 'deleted')).toEqual({ run: b, previous: c });
	});
});

describe('worstMonth', () => {
	it('is null for a run made before the monthly grid', () => {
		expect(worstMonth(summary())).toBeNull();
	});
	it('is the month of the water year with the largest share of days not met, the first on a tie', () => {
		const notMet = Array(12).fill(0);
		notMet[10] = 15; // August: half its days
		notMet[11] = 15; // September, tied: August wins
		notMet[0] = 3;
		expect(worstMonth(summary({}, { ewrCompliance: grid(notMet) }))).toEqual({ month: 10, pct: 50 });
	});
	it('says 0 when the EWR was met every day', () => {
		expect(worstMonth(summary({}, { ewrCompliance: grid(Array(12).fill(0)) }))).toEqual({ month: 0, pct: 0 });
	});
});

describe('riverKpis', () => {
	const days = 730;
	it('gives EWR not met, days below (and per year), the mean outflow and the worst month', () => {
		const notMet = Array(12).fill(0);
		notMet[10] = 12;
		const ks = riverKpis(summary({}, { ewrCompliance: grid(notMet) }), days, null);
		expect(ks.map((k) => k.id)).toEqual(['ewr', 'below', 'outflow', 'worst']);
		// Framed as the Summary's card is (issue #162): the share not met, and the days not met of the record.
		expect(tile(ks, 'ewr')).toMatchObject({ term: 'EWR not met', value: '10.0%', unit: 'of days', flagged: true, delta: null });
		expect(tile(ks, 'ewr').sub).toEqual(['73 of 730 days at the outflow gauge']);
		expect(tile(ks, 'below')).toMatchObject({ value: '73', unit: 'days', sub: ['37 in an average year'] });
		expect(tile(ks, 'outflow')).toMatchObject({ value: '0.500', unit: 'm³/s', sub: ['50% of natural'] });
		expect(tile(ks, 'worst')).toMatchObject({ value: 'August', sub: ['EWR not met on 40% of its days'], flagged: true, delta: null });
	});
	it('adds the rule-table months to the reserve tile when the project has one', () => {
		const ks = riverKpis(summary({}, { ewrAssurance: [site(null, 'Outflow gauge', 33, 36)] }), days, null);
		expect(tile(ks, 'ewr').sub).toEqual(['73 of 730 days at the outflow gauge', 'Reserve rules: 91.7% of months']);
	});
	it('compares with the previous run: the share not met, days below per year (runs differ in length), outflow, and the same month', () => {
		const cur = Array(12).fill(0);
		cur[10] = 12;
		const prev = Array(12).fill(0);
		prev[10] = 6;
		const ks = riverKpis(
			summary({ ewrDaysNotMet: 73, ewrFractionDaysNotMet: 0.1 }, { ewrCompliance: grid(cur) }),
			days,
			// A one-year run with 73 days below: 73 a year, against this run's 36.5 (73 in 730 days).
			{ summary: summary({ ewrDaysNotMet: 73, ewrFractionDaysNotMet: 0.2, meanSimulatedOutflowM3Day: 86_400 }, { ewrCompliance: grid(prev) }), days: 365.25 }
		);
		// 20% not met before, 10% now: down 10 points, which is better.
		expect(tile(ks, 'ewr').delta?.delta).toBeCloseTo(-0.1);
		expect(tile(ks, 'ewr').spec.better).toBe('lower');
		expect(tile(ks, 'below').delta?.delta).toBeCloseTo(73 * 365.25 / 730 - 73);
		expect(tile(ks, 'outflow').delta?.delta).toBeCloseTo(-0.5);
		expect(tile(ks, 'worst').delta?.delta).toBeCloseTo(0.2);
	});
	it('says so when the EWR was met every day, and when the run has no grid', () => {
		expect(tile(riverKpis(summary({ ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 }, { ewrCompliance: grid(Array(12).fill(0)) }), days, null), 'worst')).toMatchObject({
			value: 'None',
			sub: ['the EWR was met in every month'],
			flagged: false
		});
		expect(tile(riverKpis(summary(), days, null), 'worst')).toMatchObject({ value: '–', sub: ['run made before the monthly EWR grid'] });
	});
});

describe('perYear', () => {
	it('scales the days below to an average year', () => {
		expect(perYear(73, 730.5)).toBeCloseTo(36.5);
		expect(perYear(5, 0)).toBe(0);
	});
});

describe('ewrRuleText', () => {
	it('names the pragmatic EWR, and the Reserve rule sites when there are any', () => {
		expect(ewrRuleText({})).toBe('EWR: pragmatic, by month');
		expect(ewrRuleText({ ewrAssurance: [site(null, 'Outflow gauge', 1, 1)] })).toBe('EWR: pragmatic, by month · Reserve rules at the outlet');
		expect(ewrRuleText({ ewrAssurance: [site(null, 'O', 1, 1), site('g', 'Gauge B', 1, 1), site('h', 'Gauge C', 1, 1)] })).toBe(
			'EWR: pragmatic, by month · Reserve rules at the outlet, Gauge B and Gauge C'
		);
	});
});
