// The words for a Start or Divide plan the background worker routes (#646
// item 3, 272_plan_request; docs/ui.md § Map): pure, so they are tested
// without a browser. The poll itself is planWait.svelte.ts.
import type { PlanRequest } from '#lib/api/types.js';

/** A plan the worker still has (queued or running). */
export const isPlanWaiting = (r: PlanRequest | null | undefined): r is PlanRequest => !!r && (r.status === 'queued' || r.status === 'running');

/** What the sheet says while the worker has it: a Start's proposal without the order is already there to look at. */
export function planWaitingText(r: PlanRequest): string {
	const how = r.status === 'running' ? `Routing it in the background${r.progress ? ` (${Math.round(r.progress)} % through)` : ''}` : 'Queued for the background';
	return r.kind === 'start'
		? `${how}: the catchment is too large to route within a request. The proposal below has each unit’s boundary and area but no order yet; the routed one, with the order and the checks, replaces it when it is done (a minute or two), unless you apply or discard it first. With no background worker running, this one is what you get.`
		: `${how}: the catchment is too large to route within a request. The division is proposed when it is done, a minute or two.`;
}

/** What the sheet says once the worker is done with it (null when there is nothing to say: superseded, or proposed and shown). */
export function planOutcomeText(r: PlanRequest): string | null {
	if (r.status === 'refused' && r.refusal) return r.kind === 'start' ? `The background routing couldn’t order the units: ${r.refusal.message} The proposal without the order stands.` : r.refusal.message;
	if (r.status === 'failed') {
		const why = r.error && r.error !== 'cancelled' ? `: ${r.error.replace(/\.$/, '')}` : '';
		return r.kind === 'start' ? `The background routing failed${why}. The proposal without the order stands; propose again to try once more.` : `The background routing failed${why}. Propose again to try once more.`;
	}
	return null;
}
