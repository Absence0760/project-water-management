// The project list's loads, latest wins (docs/architecture.md § Stale
// responses): the list is read again on Try again and after an import, and a
// slower earlier read must not bring back the list as it was before (a
// project just imported missing from it).
import { api, type ProjectSummary, type Team } from '#lib/api/index.js';
import { latestCall, type Latest } from '#lib/api/latest.js';

/** The project list (the Compare page's picker), latest call only. */
export function projectsLoader(list: () => Promise<ProjectSummary[]> = () => api.projects.list()): () => Promise<Latest<ProjectSummary[]>> {
	return latestCall(list);
}

export type ListAndTeams = [PromiseSettledResult<ProjectSummary[]>, PromiseSettledResult<Team[]>];

/** The project list page's two reads, each settled (the list still works without teams), latest call only. */
export function projectListLoader(
	read: () => Promise<ListAndTeams> = () => Promise.allSettled([api.projects.list(), api.teams.list()])
): () => Promise<Latest<ListAndTeams>> {
	return latestCall(read);
}
