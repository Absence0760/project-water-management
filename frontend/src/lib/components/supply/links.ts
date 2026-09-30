// Links into Units & supply (issue #17), kept apart from supply.ts so the
// Summary, Runs & results and the portfolio can link here without pulling the
// page's helpers into their chunks. The same shape as river/links.ts.

/** The page's `?tab=` id. */
export const SUPPLY_TAB = 'supply';
/** The picked unit: `unit=<nodeId>` (the farm drawer is `farm=`, the Dams page's dam `dam=`). */
export const UNIT_PARAM = 'unit';

/**
 * The panels' ids: they were Runs & results' Units & users group
 * (runs/sections.ts), and keep their anchors here, so an old
 * `?tab=runs…#res-curtailment` link (a bookmarked "units short this week")
 * lands on the same panel. `res-farms` is the unit results table, which was
 * in the run summary, and `res-farm` the unit detail. `res-other-uses` is the
 * land-cover, groundwater, demand-object and other-user tables, which were
 * under the run summary with no anchor (issue #137): the Summary links here.
 * `res-restrictions` is the drought restriction rule's tables (engine ≥ 1.54.0).
 */
export const SUPPLY_ANCHORS = ['res-farm', 'res-farms', 'res-curtailment', 'res-assurance', 'res-restrictions', 'res-other-uses'] as const;

/** True for a `#res-…` fragment that now lives on Units & supply (without the `#`). */
export function supplyAnchor(hash: string): boolean {
	return (SUPPLY_ANCHORS as readonly string[]).includes(hash);
}

/** `?tab=supply&run=…`, with the curtailment's reporting window, the picked unit and a panel's anchor when given. */
export function supplyHref(runId: string | null, opts: { window?: string | null; unit?: string | null; hash?: string | null } = {}): string {
	const q = new URLSearchParams({ tab: SUPPLY_TAB });
	if (runId) q.set('run', runId);
	if (opts.window) q.set('window', opts.window);
	if (opts.unit) q.set(UNIT_PARAM, opts.unit);
	return `?${q}${opts.hash ? `#${opts.hash}` : ''}`;
}
