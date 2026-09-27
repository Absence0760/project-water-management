// The catchment page's own first requests (the project, its model and its
// series and runs lists), started by the root layout beside GET /auth/me on a
// full page load of /projects/<id> instead of after it: the page mounts only
// once /auth/me has answered, and waiting for that before asking for the
// project cost one round trip on every load (docs/architecture.md § First
// load). The page takes the requests over when it mounts; the layout drops
// them when /auth/me fails. Nothing renders from them before auth resolves:
// the page that reads them mounts only for a signed-in user, and a signed-out
// visitor's requests just answer 401 into a promise nobody reads.
import type { ProjectModel, SeriesMeta } from '@water-management/engine';
import { api, type Project, type RunMeta } from '$lib/api';

export type ProjectPageData = [Project, ProjectModel, SeriesMeta[] | null, RunMeta[] | null];

/**
 * Everything the page's first render needs, behind one gate. The lists are
 * best-effort (null on failure): a failure there shouldn't hide the project.
 */
export function fetchProjectPage(id: string): Promise<ProjectPageData> {
	return Promise.all([api.projects.get(id), api.model.get(id), api.series.list(id).catch(() => null), api.runs.list(id).catch(() => null)]);
}

let pending: { id: string; data: Promise<ProjectPageData> } | null = null;

/** The catchment id when `pathname` is the catchment page itself (not its report pages), else null. */
export function projectPageId(pathname: string, base = ''): string | null {
	const p = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
	const m = /^\/projects\/([^/]+)\/?$/.exec(p);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return null;
	}
}

/** Start the catchment page's requests now, when `pathname` is that page (the root layout, before /auth/me). */
export function startProjectPage(pathname: string, base = '', fetch: (id: string) => Promise<ProjectPageData> = fetchProjectPage): void {
	const id = projectPageId(pathname, base);
	if (!id) return;
	const data = fetch(id);
	// Handled here so a request nobody takes (a signed-out visitor's 401) is no unhandled rejection;
	// the page that takes it still sees the rejection.
	data.catch(() => {});
	pending = { id, data };
}

/** The started requests for catchment `id`, once: a second call, or another catchment, gets null. */
export function takeProjectPage(id: string): Promise<ProjectPageData> | null {
	const hit = pending;
	pending = null;
	return hit?.id === id ? hit.data : null;
}

/** Forget any started requests (/auth/me failed: nothing may be shown from them). */
export function dropProjectPage(): void {
	pending = null;
}
