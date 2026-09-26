// The outcome matrix's project settings (issue #53 R4; docs/api.md
// § Projects, docs/data-model.md § Projects, docs/ui.md § Outcome matrix):
// how water years are split into classes, and the risk cut-offs each cell's
// colour comes from. Stored in project.settings.outcomes. Like autoRun
// (runs/autoRun.ts) it is **no model input**: it says how a run's results are
// read, not how the model runs, so runs don't record it (runs/execute.ts)
// and saving it alone leaves updated_at alone (projects/routes.ts).
//
// The cut-offs' defaults are the engine's DEFAULT_OUTCOME_RISK_CUTOFFS,
// placeholders pending the hydrologist (client question O1, plan.md
// § Decision-support outputs). A metric whose cut-offs are null uses them,
// and a surface says they are pending; a project that sets its own has
// chosen, so the badge goes. The method's default, `auto`, is the engine's
// (O2).
import { DEFAULT_OUTCOME_RISK_CUTOFFS, validateOutcomeCutoffs, type OutcomeRiskCutoffs, type YearClassMethod } from '@water-management/engine';
import { z } from 'zod';

export const YEAR_CLASS_METHODS = ['auto', 'terciles', 'quintiles'] as const satisfies readonly YearClassMethod[];

/** One metric's cut-offs; null = the engine's defaults (pending the hydrologist). */
export type CutoffPair = { lower: number; increasing: number };

export interface OutcomeSettings {
	yearClassMethod: YearClassMethod;
	riskCutoffs: { reserveMonthsMet: CutoffPair | null; daysBelowEwr: CutoffPair | null };
}

export const OUTCOME_DEFAULTS: Readonly<OutcomeSettings> = Object.freeze({
	yearClassMethod: 'auto',
	riskCutoffs: Object.freeze({ reserveMonthsMet: null, daysBelowEwr: null })
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
 * The settings patch's shape for `outcomes` (projects/settings.ts): either
 * field; `riskCutoffs` is replaced whole (both metrics, each a pair or null),
 * and checked by the engine's own validateOutcomeCutoffs.
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
			})
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
	return { yearClassMethod: method, riskCutoffs: { reserveMonthsMet: pair('reserveMonthsMet'), daysBelowEwr: pair('daysBelowEwr') } };
}
