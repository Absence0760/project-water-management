// Last-seen lists per project for the Overview tab, so switching back to the
// tab renders the final layout on the first frame (then refreshes quietly)
// instead of a loading state that jumps once data arrives. Module scope = one
// browser session; nothing is persisted.
import type { SeriesMeta } from '@water-management/engine';
import type { Member, RunMeta, Team } from '$lib/api/types';

export interface OverviewData {
	series?: SeriesMeta[];
	runs?: RunMeta[];
	members?: Member[];
	teams?: Team[];
}

const byProject = new Map<string, OverviewData>();

export function cached(projectId: string): OverviewData {
	let d = byProject.get(projectId);
	if (!d) byProject.set(projectId, (d = {}));
	return d;
}
