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

/**
 * A farm page's own address (path and ?node=, without the app's base) that
 * /farm/words may send its back link to: one farm page, its Why?, dam or
 * who-decides page, nothing else. Anything else (another site, another app
 * page, a path with dots or slashes doubled) is null, so `?from=` can never
 * be an open redirect.
 */
const FARM_RETURN = /^\/farm\/(?!words(?:[/?]|$))[\w-]+(?:\/(?:why|dam|who-decides))?(?:\?node=[\w-]+)?$/;
export function farmReturn(raw: string | null | undefined): string | null {
	return raw && FARM_RETURN.test(raw) ? raw : null;
}

/**
 * "/farm/words" (with `#anchor`), carrying the farm page it is opened from as
 * `?from=`, so its back link returns there rather than to the list of farms.
 * `here` is the current URL; a page that isn't a farm page adds nothing, and
 * the words page passes on its own `from`.
 */
export function wordsHref(base: string, here: Pick<URL, 'pathname' | 'search'>, anchor = ''): string {
	const path = base && here.pathname.startsWith(base) ? here.pathname.slice(base.length) : here.pathname;
	// On the words page itself, keep the farm page it came from.
	const from = path === '/farm/words' ? farmReturn(new URLSearchParams(here.search).get('from')) : farmReturn(path + here.search);
	return `${base}/farm/words${from ? `?from=${encodeURIComponent(from)}` : ''}${anchor ? `#${anchor}` : ''}`;
}

/** How much a notice asks of the farmer, worst first: a restriction, an advisory, none, nothing published. */
const SEVERITY: Record<string, number> = { restricted: 0, advisory: 1, none: 2 };

/**
 * The farms list's order (/farm): the worst notice first, so a restriction is
 * never under a screen of unrestricted farms; ties keep the order given.
 */
export function worstFirst<T extends { publication: { restriction: { level: string } } | null }>(rows: readonly T[]): T[] {
	const rank = (r: T) => (r.publication ? (SEVERITY[r.publication.restriction.level] ?? 2) : 3);
	return rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
		.map((x) => x.r);
}
