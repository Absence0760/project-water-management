// The assessors' Applications list (ApplicationsTab.svelte, WP-3.3): its sort.
// Pure, so it is unit-tested without a component.
import type { Scenario } from '$lib/api/types';

export type ApplicationSort = 'date' | 'status';

/** Awaiting a decision first: it is the assessor's queue. Then withdrawn, then decided. */
const STATUS_ORDER: Record<Scenario['status'], number> = { submitted: 0, withdrawn: 1, decided: 2, draft: 3 };

const when = (a: Scenario) => a.submittedAt ?? a.updatedAt;

/**
 * `date`: newest submission first. `status`: awaiting a decision first, then
 * withdrawn, then decided, the oldest submission first within each (the one
 * waiting longest on top). Ties by name, then id, so the order is stable.
 */
export function sortApplications(items: readonly Scenario[], sort: ApplicationSort): Scenario[] {
	const byName = (a: Scenario, b: Scenario) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
	return [...items].sort((a, b) => {
		if (sort === 'status') return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || when(a).localeCompare(when(b)) || byName(a, b);
		return when(b).localeCompare(when(a)) || byName(a, b);
	});
}
