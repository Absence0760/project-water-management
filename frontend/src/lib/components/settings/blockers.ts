// What blocks the settings' Save, one entry per panel (sections.ts
// saveBlockers), computed from the draft itself (settingsDraft.svelte.ts), not
// by the page that shows the panels: the settings are on two pages, Model
// settings and Calibration (issue #586 round 3), and the one save bar lists
// every problem, linked to its panel on whichever page it is, while either
// page or any other tab is shown. The form-level checks are pure functions of
// the settings; the child sections' own checks (calibration window,
// exclusions, rules…) arrive through `errors` (their `bind:error`, kept in the
// draft so they outlive the tab that drew them).
import type { ArealRain, ProjectSettings } from '@water-management/engine';
import { autoRunError } from '#lib/components/autorun/autoRun.js';
import { outcomesError } from '#lib/components/outcomes/outcomeSettings.js';
import { outlookError } from '#lib/components/outlook/settings.js';
import { arealRainFormError } from './arealRain';
import { dataQualityError } from './dataQuality';
import { peFormError, peOf } from './peInput';
import { saveBlockers, settingsPageOf, type SaveBlocker } from './sections';
import { unitRainFormError } from './unitRain';
import type { ChildError, EditableSettings } from './settingsDraft.svelte';

/** The simulation window's own check (Simulation period). */
export const periodError = (s: Pick<ProjectSettings, 'simulationStart' | 'simulationEnd'>): string | null =>
	s.simulationStart && s.simulationEnd && s.simulationStart > s.simulationEnd ? 'Simulation start must be before the end.' : null;

/** The curtailment reporting window's own check (Reporting). */
export const reportingError = (s: Pick<ProjectSettings, 'reportStart' | 'reportEnd'>): string | null =>
	s.reportStart && s.reportEnd && s.reportStart > s.reportEnd ? 'The reporting window must start before it ends.' : null;

/** Every problem that blocks Save, by panel, in page order (Model settings', then Calibration's). */
export function settingsBlockers(s: EditableSettings, errors: Readonly<Record<ChildError, string | null>>): SaveBlocker[] {
	return saveBlockers([
		{ id: 'set-period', message: periodError(s) },
		{ id: 'set-rain', message: errors.fitPeriod },
		{ id: 'set-rain', message: errors.zeroRain },
		{ id: 'set-rain', message: errors.rainSource },
		{ id: 'set-rain', message: errors.rainUnreliable },
		{ id: 'set-quality', message: dataQualityError(s.dataQuality) },
		{ id: 'set-restrict', message: errors.restrict },
		{ id: 'set-reporting', message: reportingError(s) },
		{ id: 'set-share', message: unitRainFormError(s.unitRain) },
		{ id: 'set-ewr', message: errors.ewrSource },
		{ id: 'set-reserve', message: errors.reserve },
		{ id: 'set-outcomes', message: outcomesError(s.outcomes) },
		{ id: 'set-outlook', message: outlookError(s.outlook) },
		{ id: 'set-evidence', message: errors.evidence },
		{ id: 'set-auto', message: autoRunError(s.autoRun) },
		// Calibration's panels (CalibrationSettings.svelte).
		{ id: 'set-flow', message: peFormError(peOf(s)) },
		{ id: 'set-flow', message: arealRainFormError((s.arealRain ?? null) as ArealRain | null) },
		{ id: 'set-record', message: errors.calWindow },
		{ id: 'set-record', message: errors.exclusions },
		{ id: 'set-record', message: errors.flowMissing },
		{ id: 'set-record', message: errors.lowFlow },
		{ id: 'set-record', message: errors.qualityFlags },
		{ id: 'set-fit', message: errors.rules },
		{ id: 'set-wr2012', message: errors.wr2012 }
	]);
}

/**
 * The save bar's link to a blocker's panel, from the tab `tab` shown now: in place on the panel's own page (Model
 * settings or Calibration), and through it from any other, so a Calibration panel's problem listed on Model settings
 * goes to `?tab=calibration#set-…` and the other way round.
 */
export function blockerHref(id: string, tab: string): string {
	const page = settingsPageOf(id);
	return `${tab === page ? '' : `?tab=${page}`}#${id}`;
}
