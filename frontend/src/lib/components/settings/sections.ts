// The Settings & calibration page's in-page menu, one link per panel in page
// order, grouped by task (issue #468), and the list of what blocks Save, each
// pointing at its panel. The ids are set on the panels in SettingsTab.svelte
// (and around Wr2012Section and EwrRulesSection). Each label is its panel's
// heading, word for word. Data feeds, API keys and Scheduled reports, which
// followed the form and saved on their own, moved to Data and Project (issue
// #586 round 1): SETTINGS_ELSEWHERE finds them there, and settingsForward
// sends their old anchors on.

import { hashId } from '#lib/help/anchor.js';

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
	// Runoff & calibration: rain to natural flow, and how its parameters are fitted and checked.
	// How natural flow is made, Fragmentation or Per unit (issue #553 round 3); the id is the Flow share panel's, so its links still land.
	{ id: 'set-share', label: 'Flow generation', group: 'Runoff & calibration' },
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
	// When the project re-runs itself after new data (WP-2.11); last in the form: it changes no result. The group is
	// its one panel, named as its heading (issue #586, C9): the panels that shared it moved to Data and Project.
	{ id: 'set-auto', label: 'Automatic runs', group: 'Automatic runs' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * Settings that moved to another page, for Find a setting (issue #521): the registered-volumes
 * comparison band went to Allocations in round 1, so a search for it, or its other names, offers
 * a link to that card (`#alloc-band`, which AllocationsTab lands on). Data feeds went to Data, and
 * API keys and Scheduled reports to Project (issue #586 round 1); a search finds them at their new
 * homes. API keys is listed for every role: Project says to a non-owner that only owners make keys.
 */
export const SETTINGS_ELSEWHERE = [
	{ text: 'Comparison band', words: 'registered volumes allocation tolerance licence WARMS modelled use', href: '?tab=allocations#alloc-band', page: 'Allocations' },
	{ text: 'Data feeds', words: 'CHIRPS forecast DWS gauging station fetch automatically', href: '?tab=series#data-feeds', page: 'Data' },
	{ text: 'API keys', words: 'ingest logger token integration', href: '?tab=project#project-api-keys', page: 'Project' },
	{ text: 'Scheduled reports', words: 'schedule email PDF monthly weekly', href: '?tab=project#project-report-schedules', page: 'Project' }
] as const;

/**
 * Where each Settings anchor that moved away now lives (issue #586 round 1): `?tab=settings#set-feeds`
 * in an old email, a bookmark or a note goes to Data feeds on Data, and the other two to Project.
 */
export const SETTINGS_MOVED: Readonly<Record<string, { tab: string; hash: string }>> = {
	'set-feeds': { tab: 'series', hash: 'data-feeds' },
	'set-api-keys': { tab: 'project', hash: 'project-api-keys' },
	'set-report-schedules': { tab: 'project', hash: 'project-report-schedules' }
};

/**
 * The link a Settings URL forwards to when its #anchor names a panel that moved, or null: the same URL
 * on the panel's new page and anchor, every other query parameter kept (`rain=boundary`, `run=`), so
 * the panel opens as the old link meant. The caller replaces the history entry, so Back skips it.
 */
export function settingsForward(url: Pick<URL, 'pathname' | 'search' | 'hash'>): string | null {
	const params = new URLSearchParams(url.search);
	// `?rain=boundary` or `?rain=units` asks Data feeds for a map proposal, so such a link goes there even without its #.
	const hash = hashId(url.hash) || (/^(boundary|units)$/.test(params.get('rain') ?? '') ? 'set-feeds' : '');
	const moved = Object.hasOwn(SETTINGS_MOVED, hash) ? SETTINGS_MOVED[hash]! : null;
	if (!moved) return null;
	params.set('tab', moved.tab);
	return `${url.pathname}?${params}#${moved.hash}`;
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
 * page order, so the save bar can link to where each one is fixed. Empty or
 * null messages are not problems.
 */
export function saveBlockers(problems: { id: SettingsSectionId; message: string | null | undefined }[]): SaveBlocker[] {
	return SETTINGS_SECTIONS.flatMap((sec) => {
		const hit = problems.find((p) => p.id === sec.id && p.message);
		return hit ? [{ id: sec.id, label: sec.label, message: hit.message! }] : [];
	});
}
