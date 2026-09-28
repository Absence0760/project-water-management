// Last-seen member and team lists per project for the Project page's panels,
// so switching back to the tab renders the final layout on the first frame
// (then refreshes quietly) instead of a loading state that jumps once data
// arrives. (Series and runs come from the project page.) Module scope = one
// browser session; nothing is persisted.
import type { Member, Team } from '$lib/api/types';

export interface OverviewData {
	members?: Member[];
	teams?: Team[];
}

const byProject = new Map<string, OverviewData>();

export function cached(projectId: string): OverviewData {
	let d = byProject.get(projectId);
	if (!d) byProject.set(projectId, (d = {}));
	return d;
}
