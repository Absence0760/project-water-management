// Links into Allocations (issue #444), kept apart from allocations.ts so the
// Summary and Hydrological units can link here without pulling the page's
// helpers into their chunks. The same shape as supply/links.ts.

/** The page's `?tab=` id. */
export const ALLOCATIONS_TAB = 'allocations';

/**
 * `?tab=allocations`, with the run compared (`run=`) and the picked unit
 * (`unit=<nodeId>`) when given. No anchor: the comparison ("Modelled use vs
 * registered volume") is the page's first panel, so the page opens on it.
 */
export function allocationsHref(runId?: string | null, opts: { unit?: string | null } = {}): string {
	const q = new URLSearchParams({ tab: ALLOCATIONS_TAB });
	if (runId) q.set('run', runId);
	if (opts.unit) q.set('unit', opts.unit);
	return `?${q}`;
}
