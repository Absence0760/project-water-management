// Settings → Evidence (issue #71, docs/design/evidence-report.md ER3 and G4):
// the pure part of the declared uncertainty rule's editor
// (EvidenceRuleFields.svelte). The engine's declaredRuleError is the one
// check, shared with the server.
import {
	declaredRuleError,
	ENSEMBLE_DEFAULTS,
	type CalibrationBounds,
	type DeclaredUncertaintyRule,
	type Wr2012FlagLevel
} from '@water-management/engine';

/** The rule a new declaration starts from: the ensemble's own defaults (300 members, typical bounds, pan ±0.1, KGE′ ≥ 0.5, WR2012 up to "query", low-flow bias ±50 %). */
export function defaultEvidenceRule(): DeclaredUncertaintyRule {
	return {
		members: ENSEMBLE_DEFAULTS.members,
		bounds: ENSEMBLE_DEFAULTS.bounds,
		panOffset: ENSEMBLE_DEFAULTS.panOffset,
		thresholds: { ...ENSEMBLE_DEFAULTS.thresholds }
	};
}

/**
 * The value switching the declaration off writes: null, so the save withdraws
 * a rule the project has (settings are merged, so an absent key would keep it),
 * but nothing when none was ever saved, so switching on and off again leaves
 * the form unchanged.
 */
export const withdrawnRule = (saved: DeclaredUncertaintyRule | null | undefined): null | undefined => (saved === undefined ? undefined : null);

export const RULE_BOUNDS_LABEL: Record<CalibrationBounds, string> = {
	wide: 'Wide (each parameter’s full range)',
	typical: 'Typical (Perrin et al. 80 %)'
};

/** The worst WR2012 flag a kept member may carry; 'unusable' switches the check off. */
export const RULE_WR2012_LABEL: Record<Wr2012FlagLevel, string> = {
	ok: 'OK only',
	note: 'Up to “note”',
	query: 'Up to “query”',
	unusable: 'No check'
};

/** Why the form's rule can't be saved, or null: the engine's own check, worded for the form. */
export function evidenceRuleFieldsError(r: DeclaredUncertaintyRule | null | undefined): string | null {
	if (r === null || r === undefined) return null;
	const err = declaredRuleError(r);
	return err ? `Evidence uncertainty rule: ${err}.` : null;
}

/**
 * The rule switched on or off. On brings back the rule switched off (`last`,
 * kept until the form is saved or discarded) rather than the defaults: an
 * untick and re-tick must never quietly change a declared licensing rule.
 * Off withdraws it (withdrawnRule).
 */
export function withEvidenceRule(
	on: boolean,
	saved: DeclaredUncertaintyRule | null | undefined,
	last: DeclaredUncertaintyRule | null | undefined
): DeclaredUncertaintyRule | null | undefined {
	if (!on) return withdrawnRule(saved);
	return last ? (JSON.parse(JSON.stringify(last)) as DeclaredUncertaintyRule) : defaultEvidenceRule();
}
