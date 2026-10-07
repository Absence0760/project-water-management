// Which EWR test a project's results are judged by (issue #444; docs/api.md
// § Projects, docs/data-model.md § Projects, docs/ui.md § Settings → Judge
// results by): the Summary's headline card, the run sentence, River &
// reserve's tiles and the "days below" wording. Stored in
// project.settings.ewrHeadline. Like settings.outcomes it is **no model
// input**: it says how a run's results are read, not how the model runs, so
// runs don't record it (runs/execute.ts), saving it alone leaves updated_at
// alone (projects/routes.ts), and every run is read by the project's current
// choice. It never sets settings.ewrChargeSource (the daily charge and
// curtailment), which is a model input; Settings says when the two differ.
//
//   auto       the outlet's Reserve rule table, else the first site's, else
//              the pragmatic EWR: what every project did before the choice
//   pragmatic  the pragmatic EWR at the outflow gauge
//   ruleTable  one site's rule table: siteNodeId null = the outlet, else a
//              gauge above it that had a table when it was chosen
//
// The portfolio's traffic light (portfolio/status.ts) doesn't follow it: it
// judges the last 30 days, and a rule table is judged by whole months over a
// run, so the light stays the pragmatic EWR's days.
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { checkOutcomeSite } from './outcomeSettings.js';

export type EwrHeadline = { source: 'auto' } | { source: 'pragmatic' } | { source: 'ruleTable'; siteNodeId: string | null };

export const EWR_HEADLINE_DEFAULT: Readonly<EwrHeadline> = Object.freeze({ source: 'auto' });

/** The settings patch's shape for `ewrHeadline` (projects/settings.ts): one whole choice, replaced whole. */
export const EwrHeadlinePatch = z.discriminatedUnion('source', [
	z.object({ source: z.literal('auto') }).strict(),
	z.object({ source: z.literal('pragmatic') }).strict(),
	z.object({ source: z.literal('ruleTable'), siteNodeId: z.string().uuid().nullable() }).strict()
]);

/** settings.ewrHeadline, or `auto` when absent or not a valid choice (as resolveOutcomes). */
export function resolveEwrHeadline(settings: unknown): EwrHeadline {
	const raw = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>).ewrHeadline : undefined;
	const p = EwrHeadlinePatch.safeParse(raw);
	return p.success ? p.data : { ...EWR_HEADLINE_DEFAULT };
}

const sameChoice = (a: EwrHeadline, b: EwrHeadline) =>
	a.source === b.source && (a.source !== 'ruleTable' || a.siteNodeId === (b as { siteNodeId: string | null }).siteNodeId);

/**
 * A new rule-table choice must name a site with a Reserve rule table in the
 * settings as they'd be saved (`ewrRules`): the outlet (null; a table keyed
 * null or by the outlet's own id), or a gauge above it (checkOutcomeSite's
 * rules). 400 otherwise. Checked only when the patch changes the choice, so a
 * stored choice whose table later goes doesn't block saving anything else:
 * the results fall back to `auto` and say so.
 */
export async function checkEwrHeadline(db: Db, projectId: string, next: EwrHeadline, stored: unknown, ewrRules: unknown): Promise<void> {
	if (next.source !== 'ruleTable' || sameChoice(next, resolveEwrHeadline(stored))) return;
	if (next.siteNodeId !== null) return checkOutcomeSite(db, projectId, next.siteNodeId, ewrRules, 'ewrHeadline.siteNodeId');
	const { rows } = await db.query<{ id: string }>('SELECT id FROM node WHERE project_id = $1 AND downstream_node_id IS NULL', [projectId]);
	const outletIds = new Set(rows.map((r) => r.id));
	const tables = Array.isArray(ewrRules) ? (ewrRules as unknown[]) : [];
	const hasOutlet = tables.some((t) => {
		if (typeof t !== 'object' || t === null) return false;
		const site = (t as { siteNodeId?: unknown }).siteNodeId;
		return site === null || site === undefined || (typeof site === 'string' && outletIds.has(site));
	});
	if (!hasOutlet) throw new ApiError(400, 'ewrHeadline.siteNodeId: the outlet has no Reserve rule table');
}
