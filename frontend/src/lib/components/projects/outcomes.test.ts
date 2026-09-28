import { describe, expect, it } from 'vitest';
import type { PortfolioProject, ProjectSummary } from '$lib/api/types';
import { parseSort, sortProjects } from './grouping';
import { attention, needsAttention, sortByOutcome } from './outcomes';

const summary = (id: string, name: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
	id,
	name,
	description: null,
	role: 'owner',
	team: null,
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
	dataUntil: null,
	lastRunAt: null,
	publishedAt: null,
	...over
});

const outcome = (id: string, over: Partial<PortfolioProject> = {}): PortfolioProject => ({
	id,
	name: id,
	role: 'owner',
	timeZone: 'Africa/Johannesburg',
	today: '2026-09-27',
	dataUntil: '2026-09-25',
	lastRunAt: '2026-09-26T06:00:00Z',
	publishedAt: null,
	source: 'run',
	sourceRunId: 'run-1',
	figuresUntil: '2026-09-25',
	figuresAgeDays: 2,
	stale: false,
	behindData: false,
	newerRun: false,
	ewr: { status: 'green', daysNotMet30: 0, days30: 30, fraction30: 0 },
	farmsShort7: null,
	farmsShort30: null,
	farmCount: 4,
	lowestDamPct: null,
	damsKnown: false,
	feeds: { total: 0, ok: 0, failing: 0 },
	alertsFiring: 0,
	restriction: null,
	...over
});

describe('attention', () => {
	it('needs nothing for a green catchment with fresh figures, or with no figures at all', () => {
		expect(attention(outcome('a'))).toEqual({ score: 0, reasons: [] });
		expect(attention(undefined)).toEqual({ score: 0, reasons: [] });
		// Not run yet: unknown is not an alarm.
		expect(attention(outcome('a', { source: null, sourceRunId: null, ewr: { status: 'unknown', daysNotMet30: null, days30: null, fraction30: null, reason: 'no-figures' } })).score).toBe(0);
	});

	it('says every reason in words, worst first, and links hydrological units short to the curtailment', () => {
		const a = attention(
			outcome('p1', {
				ewr: { status: 'red', daysNotMet30: 9, days30: 30, fraction30: 0.3 },
				farmsShort7: 2,
				alertsFiring: 1,
				feeds: { total: 3, ok: 2, failing: 1 },
				behindData: true,
				stale: true,
				figuresAgeDays: 12
			}),
			'/base'
		);
		expect(a.reasons).toEqual([
			{ text: 'Red: EWR not met 9 of 30 days', tone: 'danger' },
			{ text: '2 of 4 hydrological units short this week', tone: 'danger', href: '/base/projects/p1?tab=supply&run=run-1&window=last7#res-curtailment' },
			{ text: '1 alert firing', tone: 'warn' },
			{ text: '1 of 3 feeds failing or stale', tone: 'warn' },
			{ text: 'Newer rain not in the figures', tone: 'warn' },
			{ text: 'Figures 12 days old', tone: 'warn' }
		]);
	});

	it('ranks red above hydrological units short above alerts above amber above stale', () => {
		const red = attention(outcome('r', { ewr: { status: 'red', daysNotMet30: 7, days30: 30, fraction30: 0.23 } })).score;
		const short = attention(outcome('s', { farmsShort7: 1 })).score;
		const alerts = attention(outcome('al', { alertsFiring: 3 })).score;
		const amber = attention(outcome('am', { ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 } })).score;
		const stale = attention(outcome('st', { stale: true, figuresAgeDays: 40 })).score;
		expect(red).toBeGreaterThan(short);
		expect(short).toBeGreaterThan(alerts);
		expect(alerts).toBeGreaterThan(amber);
		expect(amber).toBeGreaterThan(stale);
		expect(stale).toBeGreaterThan(0);
		expect(attention(outcome('am', { ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 } })).reasons).toEqual([
			{ text: 'Amber: EWR not met 3 of 30 days', tone: 'warn' }
		]);
	});
});

describe('needsAttention', () => {
	it('lists only flagged catchments, most urgent first, ties by name', () => {
		const projects = [summary('g', 'Green'), summary('b', 'Bravo stale'), summary('r', 'Red one'), summary('a', 'Alpha stale'), summary('x', 'No figures')];
		const outcomes = new Map([
			['g', outcome('g')],
			['b', outcome('b', { stale: true, figuresAgeDays: 9 })],
			['a', outcome('a', { stale: true, figuresAgeDays: 9 })],
			['r', outcome('r', { ewr: { status: 'red', daysNotMet30: 20, days30: 30, fraction30: 0.67 } })]
		]);
		expect(needsAttention(projects, outcomes).map((f) => f.project.name)).toEqual(['Red one', 'Alpha stale', 'Bravo stale']);
	});
});

describe('sorting by an outcome', () => {
	const projects = [
		summary('a', 'Alpha', { lastRunAt: '2026-09-01T00:00:00Z' }),
		summary('b', 'Bravo', { lastRunAt: '2026-09-20T00:00:00Z' }),
		summary('c', 'Charlie'),
		summary('d', 'Delta', { lastRunAt: '2026-09-10T00:00:00Z' })
	];
	const outcomes = new Map([
		['a', outcome('a', { ewr: { status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 }, farmsShort7: 1, lowestDamPct: { nodeName: 'X', pct: 0.5 } })],
		['b', outcome('b', { ewr: { status: 'red', daysNotMet30: 12, days30: 30, fraction30: 0.4 }, farmsShort7: 0, lowestDamPct: { nodeName: 'Y', pct: 0.2 } })],
		['d', outcome('d', { farmsShort7: 3 })]
	]);
	const names = (rows: ProjectSummary[]) => rows.map((p) => p.name);

	it('by EWR status, hydrological units short and lowest dam: worst first, the portfolio’s rule; rows without figures last', () => {
		expect(names(sortByOutcome(projects, 'status', outcomes))).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
		expect(names(sortByOutcome(projects, 'farms', outcomes))).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie']);
		// Delta has no dam figure: unknowns sort after the known ones, before a row with no figures at all.
		expect(names(sortByOutcome(projects, 'dam', outcomes))).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
	});

	it('by last run, newest first, never-run last; by attention, most urgent first', () => {
		expect(names(sortByOutcome(projects, 'run', outcomes))).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
		// Alpha: amber and one unit short outranks Delta's three units short alone.
		expect(names(sortByOutcome(projects, 'attention', outcomes))).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
	});

	it('goes through sortProjects, and the URL keeps every key', () => {
		expect(names(sortProjects(projects, 'status', outcomes))).toEqual(['Bravo', 'Alpha', 'Delta', 'Charlie']);
		// Without outcomes yet, an outcome sort falls back to names.
		expect(names(sortProjects(projects, 'status'))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
		for (const k of ['updated', 'name', 'attention', 'status', 'farms', 'dam', 'run']) expect(parseSort(k)).toBe(k);
		expect(parseSort('toString')).toBe('updated');
	});
});
