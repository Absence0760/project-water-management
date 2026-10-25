// The workspace sidebar's links (routes/projects/[id]/+page.svelte): each tab
// as `?tab=<id>`, the Summary as the project's own path. The tabs that show
// a run keep the run the reader picked (issue #586): pick an older run on
// Runs & results, open Settings, come back, and it is still that run, and EWR
// opens on it too. Only a pick is carried, never the default: without
// `run=` each of those tabs shows its own default (the newest, or a viewer's
// published baseline), which a run made since must still win.
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';
import type { TabId } from './tabs';

/** The tabs that show one run, picked with `?run=`. */
export const RUN_TABS: readonly TabId[] = ['runs', 'river', 'supply', 'allocations'];

export const isRunTab = (id: string): boolean => (RUN_TABS as readonly string[]).includes(id);

/** The run a sidebar link carries: the one picked, while it is still a run of the project and isn't the default anyway. */
export function carriedRun(picked: string | null, runs: readonly { id: string; published?: boolean }[] | null, role: Role | null | undefined): string | null {
	if (!picked || !runs?.some((r) => r.id === picked)) return null;
	return picked === defaultRunId(runs, role) ? null : picked;
}

/** A sidebar link: the Summary is the project's path, a run tab carries `run` (carriedRun). */
export function tabHref(id: TabId, pathname: string, run: string | null): string {
	if (id === 'overview') return pathname;
	return isRunTab(id) && run ? `?tab=${id}&run=${encodeURIComponent(run)}` : `?tab=${id}`;
}
