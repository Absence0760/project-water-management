// The outcome matrix's project settings (issue #53 R4; docs/api.md
// § Projects, docs/data-model.md § Projects, docs/ui.md § Outcome matrix):
// how water years are split into classes, the risk cut-offs each cell's
// colour comes from, and the Reserve site the matrix reads (the outlet, or a
// gauge with a Reserve rule table). Stored in project.settings.outcomes. Like autoRun
// (runs/autoRun.ts) it is **no model input**: it says how a run's results are
// read, not how the model runs, so runs don't record it (runs/execute.ts)
// and saving it alone leaves updated_at alone (projects/routes.ts).
//
// The cut-offs' defaults are the engine's DEFAULT_OUTCOME_RISK_CUTOFFS,
// placeholders pending the hydrologist (question O1, plan.md
// § Decision-support outputs: the client agreed to them, issue #90; the
// hydrologist's confirmation is open). A metric whose cut-offs are null uses them,
// and a surface says they are pending; a project that sets its own has
// chosen, so the badge goes. The method's default, `auto`, is the engine's
// (O2, confirmed by the client, issue #90).
import { DEFAULT_OUTCOME_RISK_CUTOFFS, validateOutcomeCutoffs, type OutcomeRiskCutoffs, type YearClassMethod } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export const YEAR_CLASS_METHODS = ['auto', 'terciles', 'quintiles'] as const satisfies readonly YearClassMethod[];

/** One metric's cut-offs; null = the engine's defaults (pending the hydrologist). */
export type CutoffPair = { lower: number; increasing: number };

export interface OutcomeSettings {
	yearClassMethod: YearClassMethod;
	riskCutoffs: { reserveMonthsMet: CutoffPair | null; daysBelowEwr: CutoffPair | null };
	/**
	 * The Reserve site whose rule table the matrix reads (the engine's
	 * outcomeMatrix siteNodeId): null = the outlet, else a gauge that had a
	 * rule table when it was chosen (checkOutcomeSite). Days below the
	 * pragmatic EWR are always at the outlet, so a gauge is only ever read
	 * for Reserve months met.
	 */
	siteNodeId: string | null;
}

export const OUTCOME_DEFAULTS: Readonly<OutcomeSettings> = Object.freeze({
	yearClassMethod: 'auto',
	riskCutoffs: Object.freeze({ reserveMonthsMet: null, daysBelowEwr: null }),
	siteNodeId: null
});

/** Each metric's cut-offs with the defaults filled in, the shape the engine's outcomeMatrix takes. */
export function effectiveCutoffs(c: OutcomeSettings['riskCutoffs']): OutcomeRiskCutoffs {
	return {
		reserveMonthsMet: c.reserveMonthsMet ?? { ...DEFAULT_OUTCOME_RISK_CUTOFFS.reserveMonthsMet },
		daysBelowEwr: c.daysBelowEwr ?? { ...DEFAULT_OUTCOME_RISK_CUTOFFS.daysBelowEwr }
	};
}

/** Why the cut-offs aren't valid (the engine's validateOutcomeCutoffs), or null. */
export function cutoffsError(c: OutcomeSettings['riskCutoffs']): string | null {
	try {
		validateOutcomeCutoffs(effectiveCutoffs(c));
		return null;
	} catch (err) {
		return (err as Error).message;
	}
}

const share = z.number().finite().min(0).max(1);
const Pair = z.object({ lower: share, increasing: share }).strict();

/**
 * The settings patch's shape for `outcomes` (projects/settings.ts): any
 * field; `riskCutoffs` is replaced whole (both metrics, each a pair or null),
 * and checked by the engine's own validateOutcomeCutoffs. `siteNodeId` is a
 * UUID or null here; that it names an eligible gauge needs the project, so
 * the PATCH route checks it (checkOutcomeSite).
 */
export const OutcomesPatch = z
	.object({
		yearClassMethod: z.enum(YEAR_CLASS_METHODS),
		riskCutoffs: z
			.object({ reserveMonthsMet: Pair.nullable(), daysBelowEwr: Pair.nullable() })
			.strict()
			.superRefine((c, ctx) => {
				const e = cutoffsError(c);
				if (e) ctx.addIssue({ code: 'custom', message: e });
			}),
		siteNodeId: z.string().uuid().nullable()
	})
	.partial()
	.strict();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.outcomes over the defaults; a stored field that isn't valid falls back to its default (as resolveAutoRun). */
export function resolveOutcomes(settings: unknown): OutcomeSettings {
	const raw = isObj(settings) && isObj(settings.outcomes) ? settings.outcomes : {};
	const method = (YEAR_CLASS_METHODS as readonly unknown[]).includes(raw.yearClassMethod) ? (raw.yearClassMethod as YearClassMethod) : OUTCOME_DEFAULTS.yearClassMethod;
	const rc = isObj(raw.riskCutoffs) ? raw.riskCutoffs : {};
	// Each metric on its own: one bad pair doesn't reset the other.
	const pair = (metric: keyof OutcomeSettings['riskCutoffs']): CutoffPair | null => {
		const p = Pair.safeParse(rc[metric]);
		if (!p.success) return null;
		return cutoffsError({ ...OUTCOME_DEFAULTS.riskCutoffs, [metric]: p.data }) ? null : p.data;
	};
	const site = z.string().uuid().safeParse(raw.siteNodeId);
	return {
		yearClassMethod: method,
		riskCutoffs: { reserveMonthsMet: pair('reserveMonthsMet'), daysBelowEwr: pair('daysBelowEwr') },
		siteNodeId: site.success ? site.data : null
	};
}

/**
 * A new outcomes.siteNodeId (not null) must name a gauge of the project's
 * network that isn't the outlet (the outlet is null) and that has a Reserve
 * rule table in the settings as they'd be saved (`ewrRules`): the only
 * sites the engine's outcomeMatrix reads a rule table at (run.ts
 * assessEwrRules). 400 otherwise. Checked only when the patch changes the
 * site, so a stored site whose table or gauge later goes doesn't block
 * saving anything else; the Runs tab falls back to the outlet and says so.
 */
export async function checkOutcomeSite(db: Db, projectId: string, siteNodeId: string, ewrRules: unknown): Promise<void> {
	const { rows } = await db.query<{ kind: string; downstream_node_id: string | null }>(
		'SELECT kind, downstream_node_id FROM node WHERE project_id = $1 AND id = $2',
		[projectId, siteNodeId]
	);
	const n = rows[0];
	if (!n) throw new ApiError(400, 'outcomes.siteNodeId: no such hydrological unit in this project');
	if (n.kind !== 'gauge' || n.downstream_node_id === null) throw new ApiError(400, 'outcomes.siteNodeId: the site is the outlet (null) or a gauge above it');
	const tables = Array.isArray(ewrRules) ? (ewrRules as unknown[]) : [];
	if (!tables.some((t) => isObj(t) && t.siteNodeId === siteNodeId)) throw new ApiError(400, 'outcomes.siteNodeId: that gauge has no Reserve rule table');
}
