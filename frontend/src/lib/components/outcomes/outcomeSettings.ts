// The outcome matrix's project settings (settings.outcomes, issue #53 R4;
// backend projects/outcomeSettings.ts, docs/ui.md § Outcome matrix): the
// year-class method and the risk cut-offs per metric. Small on purpose: the
// Settings tab imports it to block Save, and its section is a lazy chunk.
import { DEFAULT_OUTCOME_RISK_CUTOFFS, validateOutcomeCutoffs, type OutcomeRiskCutoffs } from '@water-management/engine';
import type { OutcomeSettings } from '$lib/api/types';

/** The backend's defaults (outcomeSettings.ts OUTCOME_DEFAULTS): `auto`, and the engine's cut-offs (null). */
export const OUTCOME_DEFAULTS: Readonly<OutcomeSettings> = Object.freeze({
	yearClassMethod: 'auto',
	riskCutoffs: Object.freeze({ reserveMonthsMet: null, daysBelowEwr: null })
});

/**
 * settings.outcomes over the defaults (an older API sends none). A fresh
 * object: the form edits it. Without the Reserve site (siteNodeId): the
 * Settings form doesn't edit it, so it doesn't send it and a save there keeps
 * the stored site (the patch merges one level deep); the Outcome matrix panel
 * reads and saves it itself.
 */
export function resolveOutcomes(settings: { outcomes?: Partial<OutcomeSettings> } | null | undefined): OutcomeSettings {
	const o = settings?.outcomes;
	return {
		yearClassMethod: o?.yearClassMethod ?? OUTCOME_DEFAULTS.yearClassMethod,
		riskCutoffs: {
			reserveMonthsMet: o?.riskCutoffs?.reserveMonthsMet ? { ...o.riskCutoffs.reserveMonthsMet } : null,
			daysBelowEwr: o?.riskCutoffs?.daysBelowEwr ? { ...o.riskCutoffs.daysBelowEwr } : null
		}
	};
}

/** Each metric's cut-offs with the engine's defaults filled in, for outcomeMatrix. */
export function effectiveCutoffs(c: OutcomeSettings['riskCutoffs']): OutcomeRiskCutoffs {
	return {
		reserveMonthsMet: c.reserveMonthsMet ?? { ...DEFAULT_OUTCOME_RISK_CUTOFFS.reserveMonthsMet },
		daysBelowEwr: c.daysBelowEwr ?? { ...DEFAULT_OUTCOME_RISK_CUTOFFS.daysBelowEwr }
	};
}

/** Why the Settings group can't be saved (the engine's validateOutcomeCutoffs, as the API checks it), or null. */
export function outcomesError(o: OutcomeSettings): string | null {
	try {
		validateOutcomeCutoffs(effectiveCutoffs(o.riskCutoffs));
		return null;
	} catch {
		const r = o.riskCutoffs.reserveMonthsMet;
		const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
		if (r && (!ok(r.lower) || !ok(r.increasing) || r.lower < r.increasing)) {
			return 'Reserve months met: each cut-off is 0–100 %, and “lower risk” must be at least “increasing risk”.';
		}
		return 'Days below the EWR: each cut-off is 0–100 %, and “lower risk” must be at most “increasing risk”.';
	}
}
