// Project-list organisation: who a project belongs to (personal / a team /
// shared with you), text search, sorting and grouping. Pure functions so the
// list page stays thin and this stays unit-tested.
import type { ProjectSummary, Team } from '$lib/api/types';
import type { SortDir } from '$lib/components/portfolio/portfolio';
import { sortByOutcome, type OutcomeSortKey, type Outcomes } from './outcomes';

/** `personal`, `shared`, or `team:<id>`. */
export type OwnerKey = 'personal' | 'shared' | `team:${string}`;
export type OwnerFilter = 'all' | OwnerKey;
export type SortKey = 'updated' | 'name' | OutcomeSortKey;

/** The sort choices, in the order the Sort menu offers them. */
export const SORT_LABELS: Record<SortKey, string> = {
	updated: 'Recently edited',
	attention: 'Needs attention first',
	status: 'EWR status (worst first)',
	farms: 'Hydrological units short (most first)',
	dam: 'Lowest dam (lowest first)',
	age: 'Figures age (oldest first)',
	run: 'Last run (newest first)',
	name: 'Name (A–Z)'
};

export interface ProjectGroup {
	key: OwnerKey;
	label: string;
	/** Set for team groups, so the heading can link to the team page. */
	teamId?: string;
	projects: ProjectSummary[];
}

/**
 * Where a project sits in *your* list:
 * - in a team you belong to (the API only tells you the team's name if you're
 *   in it) → that team;
 * - reached through direct sharing (someone else's team or project, where you
 *   aren't an owner) → shared;
 * - otherwise your own personal project.
 */
export function ownerKey(p: ProjectSummary): OwnerKey {
	if (p.team) return p.team.name !== null ? `team:${p.team.id}` : 'shared';
	return p.role === 'owner' ? 'personal' : 'shared';
}

/** Lower-case and strip accents, so "droevlei" finds "Droëvlei". */
export function fold(s: string): string {
	return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Every whitespace-separated term must appear in the name, description or team name. */
export function matchesQuery(p: ProjectSummary, query: string): boolean {
	const terms = fold(query).split(/\s+/).filter(Boolean);
	if (!terms.length) return true;
	const hay = fold(`${p.name} ${p.description ?? ''} ${p.team?.name ?? ''}`);
	return terms.every((t) => hay.includes(t));
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Sort the list; an outcome sort needs the outcomes (rows without them go
 * last). `dir` turns the key's own order round (`desc`: best or oldest first,
 * Z–A), the way a second click on a column heading does.
 */
export function sortProjects(projects: ProjectSummary[], sort: SortKey, outcomes: Outcomes = new Map(), dir: SortDir = 'asc'): ProjectSummary[] {
	if (sort !== 'updated' && sort !== 'name') return sortByOutcome(projects, sort, outcomes, dir);
	const sign = dir === 'asc' ? 1 : -1;
	const out = [...projects];
	if (sort === 'name') out.sort((a, b) => sign * collator.compare(a.name, b.name));
	else
		out.sort(
			(a, b) => sign * (Date.parse(b.updatedAt) - Date.parse(a.updatedAt)) || collator.compare(a.name, b.name)
		);
	return out;
}

export function filterProjects(
	projects: ProjectSummary[],
	{ query = '', owner = 'all' }: { query?: string; owner?: OwnerFilter }
): ProjectSummary[] {
	return projects.filter((p) => (owner === 'all' || ownerKey(p) === owner) && matchesQuery(p, query));
}

/**
 * Groups in a fixed order: Personal, then each team by name, then Shared with
 * me. Empty groups are dropped. Team names come from the project (you're a
 * member) or, failing that, the teams list.
 */
export function groupProjects(projects: ProjectSummary[], teams: Team[] = []): ProjectGroup[] {
	const byKey = new Map<OwnerKey, ProjectGroup>();
	const teamName = new Map(teams.map((t) => [t.id, t.name]));
	for (const p of projects) {
		const key = ownerKey(p);
		let g = byKey.get(key);
		if (!g) {
			if (key === 'personal') g = { key, label: 'Personal', projects: [] };
			else if (key === 'shared') g = { key, label: 'Shared with me', projects: [] };
			else {
				const id = key.slice(5);
				g = { key, label: p.team?.name ?? teamName.get(id) ?? 'Team', teamId: id, projects: [] };
			}
			byKey.set(key, g);
		}
		g.projects.push(p);
	}
	const rank = (g: ProjectGroup) => (g.key === 'personal' ? 0 : g.key === 'shared' ? 2 : 1);
	return [...byKey.values()].sort((a, b) => rank(a) - rank(b) || collator.compare(a.label, b.label));
}

export interface OwnerOption {
	value: OwnerFilter;
	label: string;
	count: number;
}

/**
 * Filter choices with counts. Every team you're in is offered (even with no
 * projects yet), so a new team is reachable from the list.
 */
export function ownerOptions(projects: ProjectSummary[], teams: Team[]): OwnerOption[] {
	const counts = new Map<OwnerKey, number>();
	for (const p of projects) counts.set(ownerKey(p), (counts.get(ownerKey(p)) ?? 0) + 1);
	const teamOpts = new Map<string, string>();
	for (const t of teams) teamOpts.set(t.id, t.name);
	for (const p of projects) if (p.team?.name) teamOpts.set(p.team.id, p.team.name);
	const opts: OwnerOption[] = [
		{ value: 'all', label: 'All projects', count: projects.length },
		{ value: 'personal', label: 'Personal', count: counts.get('personal') ?? 0 }
	];
	for (const [id, name] of [...teamOpts].sort((a, b) => collator.compare(a[1], b[1])))
		opts.push({ value: `team:${id}`, label: name, count: counts.get(`team:${id}`) ?? 0 });
	const shared = counts.get('shared') ?? 0;
	if (shared) opts.push({ value: 'shared', label: 'Shared with me', count: shared });
	return opts;
}

/** Parse the `?owner=` / `?sort=` query values, falling back to defaults. */
export function parseOwner(v: string | null): OwnerFilter {
	if (v === 'personal' || v === 'shared') return v;
	if (v && /^team:[\w-]+$/.test(v)) return v as OwnerFilter;
	return 'all';
}
export function parseSort(v: string | null): SortKey {
	return v && Object.hasOwn(SORT_LABELS, v) ? (v as SortKey) : 'updated';
}
/** `?dir=desc` turns the sort round; anything else is the key's own order. */
export function parseDir(v: string | null): SortDir {
	return v === 'desc' ? 'desc' : 'asc';
}

/**
 * The old team portfolio's address (`/teams/:id/portfolio?sort=…&dir=…`) as
 * the project list filtered to that team (issue #176). Its default order,
 * worst EWR first, comes along; its sort keys are the list's.
 */
export function portfolioListHref(teamId: string, sort: string | null = null, dir: string | null = null): string {
	const key = sort && Object.hasOwn(SORT_LABELS, sort) && sort !== 'updated' ? sort : 'status';
	const q = new URLSearchParams({ owner: `team:${teamId}`, sort: key });
	if (dir === 'desc') q.set('dir', 'desc');
	return `?${q.toString()}`;
}
