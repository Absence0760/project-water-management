import { describe, expect, it } from 'vitest';
import type { ProjectSummary, Team } from '$lib/api/types';
import {
	filterProjects,
	fold,
	groupProjects,
	matchesQuery,
	ownerKey,
	ownerOptions,
	parseOwner,
	parseSort,
	sortProjects
} from './grouping';

const proj = (over: Partial<ProjectSummary>): ProjectSummary => ({
	id: over.name ?? 'x',
	name: 'x',
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
const team = (id: string, name: string): Team => ({
	id,
	name,
	role: 'member',
	createdAt: '2026-01-01T00:00:00Z',
	memberCount: 1,
	projectCount: 0,
	settings: {},
	portfolioThresholds: { green: 5, amber: 20, source: 'default' }
});

const mine = proj({ name: 'Witklip', updatedAt: '2026-09-01T00:00:00Z' });
const sharedDirect = proj({ name: 'Sandspruit', role: 'viewer' });
const teamA = proj({ name: 'Droëvlei', team: { id: 'a', name: 'Alpha Hydro' }, description: 'Citrus and lucerne' });
const teamB = proj({ name: 'Kleinberg', team: { id: 'b', name: 'Beta' }, role: 'editor', updatedAt: '2026-10-01T00:00:00Z' });
const otherTeam = proj({ name: 'Outside', team: { id: 'z', name: null }, role: 'viewer' });
const all = [mine, sharedDirect, teamA, teamB, otherTeam];

describe('ownerKey', () => {
	it('classifies personal, team and shared projects', () => {
		expect(ownerKey(mine)).toBe('personal');
		expect(ownerKey(sharedDirect)).toBe('shared');
		expect(ownerKey(teamA)).toBe('team:a');
		// A team project you only reach by direct sharing (team name hidden).
		expect(ownerKey(otherTeam)).toBe('shared');
	});
});

describe('search', () => {
	it('folds accents and case', () => {
		expect(fold('Droëvlei')).toBe('droevlei');
		expect(matchesQuery(teamA, 'DROEVLEI')).toBe(true);
	});
	it('matches every term across name, description and team', () => {
		expect(matchesQuery(teamA, 'citrus alpha')).toBe(true);
		expect(matchesQuery(teamA, 'citrus beta')).toBe(false);
		expect(matchesQuery(teamA, '   ')).toBe(true);
	});
});

describe('filterProjects', () => {
	it('filters by owner and query together', () => {
		expect(filterProjects(all, { owner: 'personal' })).toEqual([mine]);
		expect(filterProjects(all, { owner: 'shared' })).toEqual([sharedDirect, otherTeam]);
		expect(filterProjects(all, { owner: 'team:b' })).toEqual([teamB]);
		expect(filterProjects(all, { query: 'witk' })).toEqual([mine]);
		expect(filterProjects(all, { owner: 'personal', query: 'klein' })).toEqual([]);
	});
});

describe('sortProjects', () => {
	it('sorts by most recently updated, then name', () => {
		expect(sortProjects(all, 'updated').map((p) => p.name)).toEqual([
			'Kleinberg',
			'Witklip',
			'Droëvlei',
			'Outside',
			'Sandspruit'
		]);
	});
	it('sorts by name, case- and accent-insensitive, without mutating', () => {
		const before = all.map((p) => p.name);
		expect(sortProjects(all, 'name').map((p) => p.name)).toEqual([
			'Droëvlei',
			'Kleinberg',
			'Outside',
			'Sandspruit',
			'Witklip'
		]);
		expect(all.map((p) => p.name)).toEqual(before);
	});
});

describe('groupProjects', () => {
	it('orders Personal, teams by name, then Shared with me, keeping project order', () => {
		const groups = groupProjects(all);
		expect(groups.map((g) => g.label)).toEqual(['Personal', 'Alpha Hydro', 'Beta', 'Shared with me']);
		expect(groups[1]!.teamId).toBe('a');
		expect(groups[3]!.projects).toEqual([sharedDirect, otherTeam]);
	});
	it('drops empty groups', () => {
		expect(groupProjects([teamB]).map((g) => g.key)).toEqual(['team:b']);
		expect(groupProjects([])).toEqual([]);
	});
});

describe('ownerOptions', () => {
	it('lists every team you are in with counts, and Shared only when non-empty', () => {
		const opts = ownerOptions([mine, teamA], [team('a', 'Alpha Hydro'), team('n', 'New team')]);
		expect(opts).toEqual([
			{ value: 'all', label: 'All projects', count: 2 },
			{ value: 'personal', label: 'Personal', count: 1 },
			{ value: 'team:a', label: 'Alpha Hydro', count: 1 },
			{ value: 'team:n', label: 'New team', count: 0 }
		]);
		expect(ownerOptions(all, []).at(-1)).toEqual({ value: 'shared', label: 'Shared with me', count: 2 });
	});
});

describe('URL params', () => {
	it('parses owner and sort with safe fallbacks', () => {
		expect(parseOwner('team:7d93e919-ef96')).toBe('team:7d93e919-ef96');
		expect(parseOwner('shared')).toBe('shared');
		expect(parseOwner('team:<script>')).toBe('all');
		expect(parseOwner(null)).toBe('all');
		expect(parseSort('name')).toBe('name');
		expect(parseSort('bogus')).toBe('updated');
	});
});
