// The Model settings page's in-page menu, one link per panel in page order,
// grouped by task (issue #468), and the list of what blocks Save, each
// pointing at its panel. The ids are set on the panels in SettingsTab.svelte
// (and around EwrRulesSection). Each label is its panel's heading, word for
// word. Data feeds, API keys and Scheduled reports, which followed the form and
// saved on their own, moved to Data and Project (issue #586 round 1), and Flow
// calibration, Calibration record, Fit the parameters and WR2012 check to
// Calibration (round 3), sharing this page's draft and save bar:
// SETTINGS_ELSEWHERE finds them all there, and their old anchors are sent on
// by nav/anchorMoves.ts.
import { calibrationHref } from '#lib/components/calibration/links.js';

/**
 * The heading of the page's second panel (#set-judge, EwrHeadlineField.svelte, issue #444), right under the model
 * selection: which EWR the results are judged by. "Judge results by" until issue #586 E14 (R4-B), which read as
 * jargon: judged by what?
 */
export const JUDGE_HEADING = 'EWR the results are judged by';

/** The heading of the page's first panel, its lead card (#set-share): how natural flow is made (issue #614). */
export const FLOW_GENERATION_HEADING = 'Model selection for flow generation';

export const SETTINGS_SECTIONS = [
	// The lead group, with no name, above the first task's (issue #614). First the model selection: how rain becomes
	// natural flow, Fragmentation or Per unit (issue #553 round 3; "Flow generation" until issue #614, in a "Runoff"
	// group of its own). The id is the old Flow share panel's, so its links still land. The runoff parameters and
	// their fit moved to Calibration (issue #586 round 3).
	{ id: 'set-share', label: FLOW_GENERATION_HEADING, group: null },
	// Then the EWR the results are judged by (issue #444): it reads results and changes none, so it comes after the
	// model input (issue #614; it headed the page before). Its own link, so the index lists every panel and Find a
	// setting finds it (issue #586 R4-B: it had no link, and a search for "judged" found nothing).
	{ id: 'set-judge', label: JUDGE_HEADING, group: null },
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
	// EWR & Reserve: what must stay in the river.
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
 * Every settings anchor on the Calibration page: its four panels, Evaporation from the map and Evaporation stations
 * inside Flow calibration (EvaporationProposal.svelte's `#set-evaporation`, EvaporationStationProposal.svelte's
 * `#set-evaporation-station`, issue #646) and the Regional prior inside Fit the parameters (RegionalPriorPanel.svelte's
 * `#set-prior`, issue #622), so a link to any of them lands there: one missing here was a Model settings anchor to
 * nav/anchorMoves.ts, which sent its link to Model settings. page.test.ts holds every `#set-…` the page draws to it.
 */
export const CALIBRATION_SETTINGS_ANCHORS: readonly string[] = [
	...CALIBRATION_SETTINGS_SECTIONS.map((s) => s.id),
	'set-evaporation',
	'set-evaporation-station',
	'set-prior'
];
export const isCalibrationAnchor = (id: string): boolean => CALIBRATION_SETTINGS_ANCHORS.includes(id);

/** The page a settings panel is on: `settings` (Model settings) or `calibration`. */
export const settingsPageOf = (id: string): 'settings' | 'calibration' => (isCalibrationSetting(id) ? 'calibration' : 'settings');

/**
 * Settings that moved to another page, for Find a setting (issue #521): the registered-volumes
 * comparison band went to Allocations in round 1, so a search for it, or its other names, offers
 * a link to that card (`#alloc-band`, which AllocationsTab lands on). Data feeds went to Data, and
 * API keys and Scheduled reports to Project (issue #586 round 1), and the calibration panels to
 * Calibration (round 3); a search finds them at their new homes. API keys is an owner's panel, so
 * `settingsElsewhere` leaves it out for anyone else: Project shows them no such panel, and a link to
 * it would land nowhere.
 */
export const SETTINGS_ELSEWHERE = [
	{ text: 'Comparison band', words: 'registered volumes allocation tolerance licence WARMS modelled use', href: '?tab=allocations#alloc-band', page: 'Allocations' },
	{ text: 'Data feeds', words: 'CHIRPS forecast DWS gauging station fetch automatically', href: '?tab=series#data-feeds', page: 'Data' },
	{ text: 'API keys', words: 'ingest logger token integration', href: '?tab=project#project-api-keys', page: 'Project' },
	{ text: 'Scheduled reports', words: 'schedule email PDF monthly weekly', href: '?tab=project#project-report-schedules', page: 'Project' },
	// The runoff parameters and their fit (issue #586 round 3), each by its heading and the settings it holds.
	{ text: 'Flow calibration', words: 'GR4J parameters X1 X2 X3 X4 catchment area warm-up areal rainfall correction potential evaporation pan coefficient runoff model PE from the map', href: calibrationHref(null, 'set-flow'), page: 'Calibration' },
	{ text: 'Calibration record', words: 'calibration window gauge site observed flow record exclusions quality flags low flow compare with flow gaps logger flows gauged range infilled', href: calibrationHref(null, 'set-record'), page: 'Calibration' },
	{ text: 'Fit the parameters', words: 'fit automatically auto calibration rules fit record objective NSE KGE MAR penalty validation', href: calibrationHref(null, 'set-fit'), page: 'Calibration' },
	{ text: 'WR2012 check', words: 'WR2012 quaternary naturalised flow MAR reference', href: calibrationHref(null, 'set-wr2012'), page: 'Calibration' },
	{ text: 'Evaporation from the map', words: 'ET0 dPET potential evaporation map proposal', href: calibrationHref(null, 'set-evaporation'), page: 'Calibration' },
	{ text: 'Evaporation stations', words: 'DWS evaporation station A-pan Class-A Symons pan record monthly means S-pan conversion', href: calibrationHref(null, 'set-evaporation-station'), page: 'Calibration' },
	{ text: 'Regional prior', words: 'regional prior donors donor basins ungauged GRDC Caravan HydroATLAS soil water capacity start from the prior p10 p90', href: calibrationHref(null, 'set-prior'), page: 'Calibration' }
] as const;

/** The moved settings this reader can follow: API keys only for an owner (issue #586 round 1). */
export function settingsElsewhere(owner: boolean) {
	return owner ? SETTINGS_ELSEWHERE : SETTINGS_ELSEWHERE.filter((e) => e.text !== 'API keys');
}

/**
 * The menu's groups, by task (issue #468), in page order: every panel has its link, on the bar and
 * in the side index alike, each one its panel's heading.
 */
export function settingsNavGroups(): { label: string | null; sections: { id: string; label: string }[] }[] {
	const groups: { label: string | null; sections: { id: string; label: string }[] }[] = [];
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
