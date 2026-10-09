// The Settings & calibration page's in-page menu, one link per panel in page
// order, grouped by task (issue #468), and the list of what blocks Save, each
// pointing at its panel. The ids are set on the panels in SettingsTab.svelte
// (and around Wr2012Section and EwrRulesSection, on DataFeedsPanel's wrapper
// (the panel is lazy), and on ApiKeysPanel and ReportSchedulesPanel, which
// follow the form). Each label is its panel's heading, word for word.

export const SETTINGS_SECTIONS = [
	// Data & rain: what the model runs on.
	{ id: 'set-period', label: 'Simulation period', group: 'Data & rain' },
	{ id: 'set-rain', label: 'Rain gaps', group: 'Data & rain' },
	// Its zero-rain and low-vs-CHIRPS limits change results (issue #66), so it is a model input (issue #173).
	{ id: 'set-quality', label: 'Data quality', group: 'Data & rain' },
	// Demand & supply: what the units need and get.
	{ id: 'set-demand', label: 'Demand', group: 'Demand & supply' },
	{ id: 'set-share', label: 'Flow share', group: 'Demand & supply' },
	// The drought restriction rule (engine ≥ 1.54.0, WP-3.8): a model input, off by default.
	{ id: 'set-restrict', label: 'Drought restrictions', group: 'Demand & supply' },
	// Runoff & calibration: rain to natural flow, and how its parameters are fitted and checked.
	{ id: 'set-flow', label: 'Flow calibration', group: 'Runoff & calibration' },
	{ id: 'set-record', label: 'Calibration record', group: 'Runoff & calibration' },
	{ id: 'set-fit', label: 'Fit the parameters', group: 'Runoff & calibration' },
	{ id: 'set-wr2012', label: 'WR2012 check', group: 'Runoff & calibration' },
	// EWR & Reserve: what must stay in the river. Judge results by (#set-judge) heads the page, above the menu's first panel.
	{ id: 'set-ewr', label: 'EWR', group: 'EWR & Reserve' },
	{ id: 'set-reserve', label: 'Reserve rule tables', group: 'EWR & Reserve' },
	// How the Runs tab's outcome matrix reads a demand sweep (issue #53 R4); changes no result.
	{ id: 'set-outcomes', label: 'Outcome matrix', group: 'Reading results' },
	// The season and planning share of the Runs tab's seasonal outlook (issue #53 R5); changes no result.
	{ id: 'set-outlook', label: 'Seasonal outlook', group: 'Reading results' },
	// The uncertainty rule an evidence report's cited ensemble must follow (issue #71 ER3); changes no result.
	{ id: 'set-evidence', label: 'Evidence', group: 'Reading results' },
	// When the project re-runs itself after new data (WP-2.11); last in the form: it changes no result.
	{ id: 'set-auto', label: 'Automatic runs', group: 'Automation & access' },
	// After the settings form, saved on its own (feeds/DataFeedsPanel.svelte).
	{ id: 'set-feeds', label: 'Data feeds', group: 'Automation & access' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/** The menu's one link (on the bar) for the panels that run or connect by themselves. */
export const AUTOMATION_LABEL = 'Automation & access';

/** The panels after the form that save on their own, for the menu (API keys: owners only). */
const AFTER_FORM = (isOwner: boolean) => [
	{ id: 'set-feeds', label: 'Data feeds' },
	...(isOwner ? [{ id: 'set-api-keys', label: 'API keys' }] : []),
	{ id: 'set-report-schedules', label: 'Scheduled reports' }
];

/**
 * The menu's groups, by task (issue #468), in page order. In the side rail
 * every panel has its link, Automation & access listing Automatic runs, Data
 * feeds, API keys (owners) and Scheduled reports. On the bar (narrower than
 * the rail needs) that group is one link, "Automation & access", landing on
 * Automatic runs and standing for the four (`covers`), or the bar's links no
 * longer fit two rows at 1280 px (section-nav.spec.ts).
 */
export function settingsNavGroups(isOwner: boolean, rail = false): { label: string; sections: { id: string; label: string; covers?: string[] }[] }[] {
	const groups: { label: string; sections: { id: string; label: string; covers?: string[] }[] }[] = [];
	for (const sec of SETTINGS_SECTIONS) {
		if (sec.id === 'set-feeds') continue;
		let g = groups.find((x) => x.label === sec.group);
		if (!g) groups.push((g = { label: sec.group, sections: [] }));
		g.sections.push({ id: sec.id, label: sec.label });
	}
	const auto = groups.at(-1)!;
	if (rail) auto.sections.push(...AFTER_FORM(isOwner));
	else auto.sections = [{ id: 'set-auto', label: AUTOMATION_LABEL, covers: AFTER_FORM(isOwner).map((s) => s.id) }];
	return groups;
}

export interface SaveBlocker {
	id: SettingsSectionId;
	label: string;
	message: string;
}

/**
 * What stops Save, one entry per panel with a problem (its first message), in
 * page order, so the save bar can link to where each one is fixed. Empty or
 * null messages are not problems.
 */
export function saveBlockers(problems: { id: SettingsSectionId; message: string | null | undefined }[]): SaveBlocker[] {
	return SETTINGS_SECTIONS.flatMap((sec) => {
		const hit = problems.find((p) => p.id === sec.id && p.message);
		return hit ? [{ id: sec.id, label: sec.label, message: hit.message! }] : [];
	});
}
