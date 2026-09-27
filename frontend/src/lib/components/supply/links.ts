// Links into Units & supply (issue #17, option A · Outcomes), apart from the
// page's own code (supply.ts) so the workspace page, the Summary and the
// portfolio can import them without pulling the page's helpers into their
// chunks. No imports.

/** The page's `?tab=` id. */
export const SUPPLY_TAB = 'supply';
/** The picked unit: `unit=<nodeId>` (the farm drawer is `farm=`, the Dams page's dam `dam=`). */
export const UNIT_PARAM = 'unit';

/**
 * The panels that moved here from Runs & results, by their anchors (kept on
 * this page): an old `?tab=runs…#res-curtailment` link, such as a bookmark of
 * the portfolio's "units short this week", lands on the same panel here.
 * `res-farms` is the unit results table, `res-farm` the unit detail.
 */
export const MOVED_PANELS: readonly string[] = ['res-curtailment', 'res-assurance', 'res-farm', 'res-farms'];

/** `?tab=supply&run=…` with the page's optional parameters, and a panel's anchor. */
export function supplyHref(runId: string | null, opts: { window?: string | null; unit?: string | null; hash?: string | null } = {}): string {
	const q = new URLSearchParams({ tab: SUPPLY_TAB });
	if (runId) q.set('run', runId);
	if (opts.window) q.set('window', opts.window);
	if (opts.unit) q.set(UNIT_PARAM, opts.unit);
	return `?${q}${opts.hash ? `#${opts.hash}` : ''}`;
}

/**
 * An old Runs & results link to a panel that moved here, as the same link on
 * this page (every other parameter, `run=` and `window=` among them, and the
 * anchor kept); null for any other URL.
 */
export function movedFromRuns(url: URL): string | null {
	const tab = url.searchParams.get('tab');
	if (tab !== 'runs' && tab !== 'results') return null;
	if (!MOVED_PANELS.includes(url.hash.slice(1))) return null;
	const q = new URLSearchParams(url.search);
	q.set('tab', SUPPLY_TAB);
	return `${url.pathname}?${q}${url.hash}`;
}
