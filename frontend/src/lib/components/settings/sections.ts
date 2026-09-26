// The Settings & calibration page's in-page menu, one link per group in page
// order, and the list of what blocks Save, each pointing at its group. The ids
// are set on the panels in SettingsTab.svelte (and around Wr2012Section and EwrRulesSection,
// and on DataFeedsPanel, which follows the form).

export const SETTINGS_SECTIONS = [
	{ id: 'set-demand', label: 'Demand' },
	{ id: 'set-flow', label: 'Flow calibration' },
	{ id: 'set-rain', label: 'Rain gaps' },
	{ id: 'set-record', label: 'Calibration record' },
	{ id: 'set-fit', label: 'Fit automatically' },
	{ id: 'set-wr2012', label: 'WR2012 check' },
	{ id: 'set-share', label: 'Flow share' },
	{ id: 'set-ewr', label: 'EWR' },
	{ id: 'set-reserve', label: 'Reserve rules' },
	{ id: 'set-period', label: 'Simulation period' },
	{ id: 'set-quality', label: 'Data quality' },
	// How the Runs tab's outcome matrix reads a demand sweep (issue #53 R4); changes no result.
	{ id: 'set-outcomes', label: 'Outcome matrix' },
	// When the project re-runs itself after new data (WP-2.11); last in the form: it changes no result.
	{ id: 'set-auto', label: 'Automatic runs' },
	// After the settings form, saved on its own (feeds/DataFeedsPanel.svelte).
	{ id: 'set-feeds', label: 'Data feeds' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export interface SaveBlocker {
	id: SettingsSectionId;
	label: string;
	message: string;
}

/**
 * What stops Save, one entry per group with a problem (its first message), in
 * page order, so the save bar can link to where each one is fixed. Empty or
 * null messages are not problems.
 */
export function saveBlockers(problems: { id: SettingsSectionId; message: string | null | undefined }[]): SaveBlocker[] {
	return SETTINGS_SECTIONS.flatMap((sec) => {
		const hit = problems.find((p) => p.id === sec.id && p.message);
		return hit ? [{ id: sec.id, label: sec.label, message: hit.message! }] : [];
	});
}
