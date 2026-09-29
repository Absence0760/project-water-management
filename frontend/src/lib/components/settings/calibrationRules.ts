// Settings → Fit automatically → Calibration rules (issue #153): the pure part
// of the rules editor (CalibrationRulesFields.svelte). The engine's
// calibrationRulesError is the one check, shared with the server.
import { calibrationRulesError, type CalibrationRules } from '@water-management/engine';

/**
 * `list` with `id` in or out, in the order of `all` (so the saved list, and
 * the fits it runs, never depend on the order boxes were ticked).
 */
export function toggled<T extends string>(all: readonly T[], list: readonly T[], id: T, on: boolean): T[] {
	const set = new Set(list);
	if (on) set.add(id);
	else set.delete(id);
	return all.filter((x) => set.has(x));
}

/** The flagged-day share as the form shows it (a percentage), and back. */
export const shareToPct = (share: number | null) => (share === null ? null : Math.round(share * 1000) / 10);
export const pctToShare = (pct: number | null) => (pct === null ? null : pct / 100);

/** Why the form's rules can't be saved, or null: the engine's own check, worded for the form. */
export function rulesFieldsError(r: CalibrationRules): string | null {
	const err = calibrationRulesError(r);
	return err ? `Calibration rules: ${err}.` : null;
}

/** "Draft, not signed off" or "Signed off by A. Hydrologist on 2026-09-29", with the revision. */
export const rulesStatusText = (r: CalibrationRules) =>
	`Revision ${r.revision} · ${r.signedOff ? `signed off by ${r.signedOff.by} on ${r.signedOff.on}` : 'draft, not signed off by the hydrologist'}`;
