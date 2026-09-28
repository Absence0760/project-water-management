// The decisions behind loading a farm page (docs/design/farmer-view.md §6.5,
// §9), apart from the fetching, so they can be tested: which farm to show,
// and what a failed request means for the page.
import type { FarmIndex } from '@water-management/engine';

/** Why a request failed, as the page words it. */
export type Failure = 'removed' | 'offline' | 'failed';

/**
 * 403 or 404: the farm (or the project) is no longer this user's, so the page
 * says so and the saved copy goes. Status 0: no signal. Anything else: the
 * server had a problem; the page offers Try again. Never the raw error text.
 */
export function classify(e: unknown): Failure {
	const status = e && typeof e === 'object' && 'status' in e ? (e as { status: unknown }).status : null;
	if (status === 403 || status === 404) return 'removed';
	if (status === 0) return 'offline';
	return 'failed';
}

/**
 * The farm to show: the one asked for (?node=) if the index lists it, else
 * the one shown last on this phone, else the first. null when the asked-for
 * farm isn't in the list (it's no longer this user's) or there are none.
 */
export function pickNode(index: Pick<FarmIndex, 'farms'>, asked: string | null, remembered: string | null = null): string | null {
	const ids = index.farms.map((f) => f.nodeId);
	if (asked) return ids.includes(asked) ? asked : null;
	if (remembered && ids.includes(remembered)) return remembered;
	return ids[0] ?? null;
}

/** "/farm/<project>" with ?node= only when the project has several farms (or the page was opened with one). */
export function farmHref(base: string, projectId: string, nodeId: string | null, several: boolean, page = ''): string {
	const q = nodeId && several ? `?node=${encodeURIComponent(nodeId)}` : '';
	return `${base}/farm/${encodeURIComponent(projectId)}${page ? `/${page}` : ''}${q}`;
}
