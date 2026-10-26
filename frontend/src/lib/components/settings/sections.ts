// The Model settings page's in-page menu, one link per panel in page order,
// grouped by task (issue #468), and the list of what blocks Save, each
// pointing at its panel. The ids are set on the panels in SettingsTab.svelte
// (and around EwrRulesSection). Each label is its panel's heading, word for
// word. The four panels that set up a fit (Flow calibration, Calibration
// record, Fit the parameters, WR2012 check) moved to the Calibration page
// (issue #586 round 3, CalibrationSettings.svelte): CALIBRATION_SETTINGS_SECTIONS
// lists them, and they share the one draft and its Save blockers. Data feeds, API keys and Scheduled reports, which
// followed the form and saved on their own, moved to Data and Project (issue
// #586 round 1): SETTINGS_ELSEWHERE finds them there, and their old anchors
// are sent on by nav/anchorMoves.ts.

export const SETTINGS_SECTIONS = [
	// Data & rain: what the model runs on.
	{ id: 'set-period', label: 'Simulation period', group: 'Data & rain' },
	{ id: 'set-rain', label: 'Rain gaps', group: 'Data & rain' },
	// Its zero-rain and low-vs-CHIRPS limits change results (issue #66), so it is a model input (issue #173).
	{ id: 'set-quality', label: 'Data quality', group: 'Data & rain' },
	// Demand & supply: what the units need and get.
	{ id: 'set-demand', label: 'Demand', group: 'Demand & supply' },
	// The drought restriction rule (engine ≥ 1.54.0, WP-3.8): a model input, off by default.
	{ id: 'set-restrict', label: 'Drought restrictions', group: 'Demand & supply' },
	// The reporting window and the annual assurance threshold (issue #521, moved from EWR): how supply results are read.
	{ id: 'set-reporting', label: 'Reporting', group: 'Demand & supply' },
	// Runoff & calibration: rain to natural flow. How its parameters are fitted and checked moved to Calibration (below).
	// How natural flow is made, Fragmentation or Per unit (issue #553 round 3); the id is the Flow share panel's, so its links still land.
	{ id: 'set-share', label: 'Flow generation', group: 'Runoff & calibration' },
	// EWR & Reserve: what must stay in the river. Judge results by (#set-judge) heads the page, above the menu's first panel.
	{ id: 'set-ewr', label: 'EWR', group: 'EWR & Reserve' },
	{ id: 'set-reserve', label: 'Reserve rule tables', group: 'EWR & Reserve' },
	// How the Runs tab's outcome matrix reads a demand sweep (issue #53 R4); changes no result.
	{ id: 'set-outcomes', label: 'Outcome matrix', group: 'Reading results' },
	// The season and planning share of the Runs tab's seasonal outlook (issue #53 R5); changes no result.
	{ id: 'set-outlook', label: 'Seasonal outlook', group: 'Reading results' },
	// The uncertainty rule an evidence report's cited ensemble must follow (issue #71 ER3); changes no result.
	{ id: 'set-evidence', label: 'Evidence', group: 'Reading results' },
	// When the project re-runs itself after new data (WP-2.11); last in the form: it changes no result. The group is
	// its one panel, named as its heading (issue #586, C9): the panels that shared it moved to Data and Project.
	{ id: 'set-auto', label: 'Automatic runs', group: 'Automatic runs' }
] as const;

/**
 * The settings panels on the Calibration page (`?tab=calibration`, CalibrationSettings.svelte), in its order: the
 * same draft as Model settings', saved by the same save bar (issue #586 round 3).
 */
export const CALIBRATION_SETTINGS_SECTIONS = [
	{ id: 'set-flow', label: 'Flow calibration' },
	{ id: 'set-record', label: 'Calibration record' },
	{ id: 'set-fit', label: 'Fit the parameters' },
	{ id: 'set-wr2012', label: 'WR2012 check' }
] as const;

export type CalibrationSettingsId = (typeof CALIBRATION_SETTINGS_SECTIONS)[number]['id'];
/** Any settings panel's id, on either page. */
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'] | CalibrationSettingsId;

/** True for a settings panel on the Calibration page (not Model settings). */
export const isCalibrationSetting = (id: string): id is CalibrationSettingsId => CALIBRATION_SETTINGS_SECTIONS.some((s) => s.id === id);

/**
 * Every settings anchor on the Calibration page: its four panels, and Evaporation from the map inside Flow
 * calibration (EvaporationProposal.svelte's `#set-evaporation`), so a link to any of them lands there.
 */
export const CALIBRATION_SETTINGS_ANCHORS: readonly string[] = [...CALIBRATION_SETTINGS_SECTIONS.map((s) => s.id), 'set-evaporation'];
export const isCalibrationAnchor = (id: string): boolean => CALIBRATION_SETTINGS_ANCHORS.includes(id);

/** The page a settings panel is on: `settings` (Model settings) or `calibration`. */
export const settingsPageOf = (id: string): 'settings' | 'calibration' => (isCalibrationSetting(id) ? 'calibration' : 'settings');

/**
 * Settings that moved to another page, for Find a setting (issue #521): the registered-volumes
 * comparison band went to Allocations in round 1, so a search for it, or its other names, offers
 * a link to that card (`#alloc-band`, which AllocationsTab lands on). Data feeds went to Data, and
 * API keys and Scheduled reports to Project (issue #586 round 1); a search finds them at their new
 * homes. API keys is an owner's panel, so `settingsElsewhere` leaves it out for anyone else: Project
 * shows them no such panel, and a link to it would land nowhere.
 */
export const SETTINGS_ELSEWHERE = [
	{ text: 'Comparison band', words: 'registered volumes allocation tolerance licence WARMS modelled use', href: '?tab=allocations#alloc-band', page: 'Allocations' },
	{ text: 'Data feeds', words: 'CHIRPS forecast DWS gauging station fetch automatically', href: '?tab=series#data-feeds', page: 'Data' },
	{ text: 'API keys', words: 'ingest logger token integration', href: '?tab=project#project-api-keys', page: 'Project' },
	{ text: 'Scheduled reports', words: 'schedule email PDF monthly weekly', href: '?tab=project#project-report-schedules', page: 'Project' },
	// The panels that set up a fit (issue #586 round 3), found on Calibration with what they hold.
	{ text: 'Flow calibration', words: 'GR4J parameters X1 X2 X3 X4 catchment area warm-up runoff model pan coefficient potential evaporation PE areal rainfall evaporation from the map', href: '?tab=calibration#set-flow', page: 'Calibration' },
	{ text: 'Calibration record', words: 'calibration window observed flow gauge logger compare with exclusions low flows quality flags gauged range flow gaps infilled', href: '?tab=calibration#set-record', page: 'Calibration' },
	{ text: 'Fit the parameters', words: 'fit automatically objective KGE NSE validation fit record calibration rules MAR penalty', href: '?tab=calibration#set-fit', page: 'Calibration' },
	{ text: 'WR2012 check', words: 'WR2012 naturalised flow quaternary MAR reference', href: '?tab=calibration#set-wr2012', page: 'Calibration' }
] as const;

/** The moved settings this reader can follow: API keys only for an owner (issue #586 round 1). */
export function settingsElsewhere(owner: boolean) {
	return owner ? SETTINGS_ELSEWHERE : SETTINGS_ELSEWHERE.filter((e) => e.text !== 'API keys');
}

/**
 * The menu's groups, by task (issue #468), in page order: every panel has its link, on the bar and
 * in the side index alike, each one its panel's heading.
 */
export function settingsNavGroups(): { label: string; sections: { id: string; label: string }[] }[] {
	const groups: { label: string; sections: { id: string; label: string }[] }[] = [];
	for (const sec of SETTINGS_SECTIONS) {
		let g = groups.find((x) => x.label === sec.group);
		if (!g) groups.push((g = { label: sec.group, sections: [] }));
		g.sections.push({ id: sec.id, label: sec.label });
	}
	return groups;
}

export interface SaveBlocker {
	id: SettingsSectionId;
	label: string;
	message: string;
}

/**
 * What stops Save, one entry per panel with a problem (its first message), in
 * page order (Model settings' panels, then Calibration's), so the save bar can
 * link to where each one is fixed, on either page. Empty or null messages are
 * not problems.
 */
export function saveBlockers(problems: { id: SettingsSectionId; message: string | null | undefined }[]): SaveBlocker[] {
	return [...SETTINGS_SECTIONS, ...CALIBRATION_SETTINGS_SECTIONS].flatMap((sec) => {
		const hit = problems.find((p) => p.id === sec.id && p.message);
		return hit ? [{ id: sec.id, label: sec.label, message: hit.message! }] : [];
	});
}
