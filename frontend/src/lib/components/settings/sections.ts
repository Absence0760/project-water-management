// The Settings & calibration page's in-page menu, one link per group in page
// order, and the list of what blocks Save, each pointing at its group. The ids
// are set on the panels in SettingsTab.svelte (and around Wr2012Section and EwrRulesSection,
// on DataFeedsPanel's wrapper (the panel is lazy), and on ApiKeysPanel and ReportSchedulesPanel, which follow the form).

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
	// The drought restriction rule (engine ≥ 1.52.0, WP-3.8): a model input, off by default.
	{ id: 'set-restrict', label: 'Drought restrictions' },
	{ id: 'set-period', label: 'Simulation period' },
	// Its zero-rain and low-vs-CHIRPS limits change results (issue #66), so it is a model input (issue #173).
	{ id: 'set-quality', label: 'Data quality' },
	// How the Runs tab's outcome matrix reads a demand sweep (issue #53 R4); changes no result.
	{ id: 'set-outcomes', label: 'Outcome matrix' },
	// The season and planning share of the Runs tab's seasonal outlook (issue #53 R5); changes no result.
	{ id: 'set-outlook', label: 'Seasonal outlook' },
	// The uncertainty rule an evidence report's cited ensemble must follow (issue #71 ER3); changes no result.
	{ id: 'set-evidence', label: 'Evidence' },
	// When the project re-runs itself after new data (WP-2.11); last in the form: it changes no result.
	{ id: 'set-auto', label: 'Automatic runs' },
	// After the settings form, saved on its own (feeds/DataFeedsPanel.svelte).
	{ id: 'set-feeds', label: 'Data feeds' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * The menu's groups (issue #17): the model's inputs (Data quality among them:
 * some of its limits change results, issue #173); the settings that only
 * decide how results are read (they change no result); and what runs or
 * connects by itself. The last group also links the panels after Data feeds,
 * which save on their own: API keys (owners only) and Scheduled reports.
 */
export function settingsNavGroups(isOwner: boolean): { label: string; ids: string[] }[] {
	const ids = SETTINGS_SECTIONS.map((s) => s.id as string);
	const read = ids.indexOf('set-outcomes');
	const auto = ids.indexOf('set-auto');
	return [
		{ label: 'Model inputs', ids: ids.slice(0, read) },
		{ label: 'How results are read', ids: ids.slice(read, auto) },
		{ label: 'Runs, feeds and reports', ids: [...ids.slice(auto), ...(isOwner ? ['set-api-keys'] : []), 'set-report-schedules'] }
	];
}

/** Menu labels of the panels after Data feeds, which aren't Save blockers. */
export const AFTER_FORM_LABELS: Record<string, string> = { 'set-api-keys': 'API keys', 'set-report-schedules': 'Scheduled reports' };

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
