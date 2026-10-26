// The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
// parameters and judging the fit, brought together from Settings &
// calibration and Runs & results. Round 2 gives the page its row, its header
// and its two parts; the panels move in with Round 3. Until then each part
// links to the panels where they are today, by their headings word for word,
// so the page is never a dead end. Pure helpers, so the links and the
// forwarding are unit-tested without the page.
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import { SETTINGS_SECTIONS, type SettingsSectionId } from '#lib/components/settings/sections.js';
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';
import { hashId } from '#lib/help/anchor.js';

/** The page's two parts, by their headings' anchors (CalibrationTab.svelte sets them). */
export const CAL_PARTS = [
	{ id: 'cal-setup', label: 'Set up the fit' },
	{ id: 'cal-fit', label: 'How the shown run fits' }
] as const;

export type CalPartId = (typeof CAL_PARTS)[number]['id'];

/** The side index: one group, a link per part, each its heading. */
export function calibrationNavGroups(): NavGroup[] {
	return [{ label: null, sections: CAL_PARTS.map((p) => ({ id: p.id, label: p.label })) }];
}

export const isCalPart = (id: string): id is CalPartId => CAL_PARTS.some((p) => p.id === id);

export interface PanelLink {
	/** The panel's anchor on its page today. */
	id: string;
	/** The panel's heading there, word for word. */
	label: string;
	/** What it holds, in a few words. */
	hint: string;
}

const SETUP_HINTS: Partial<Record<SettingsSectionId, string>> = {
	'set-flow': 'the GR4J parameters, the catchment area and the warm-up',
	'set-record': 'the window, the gauge it is scored at, exclusions and quality flags',
	'set-fit': 'fit automatically, the fit record and the calibration rules',
	'set-wr2012': 'the WR2012 naturalised flow a run is compared with'
};

/**
 * "Set up the fit": the four panels on Settings & calibration, in its page order, named from its own
 * section list (settings/sections.ts), so a renamed heading renames the link.
 */
export const SETUP_LINKS: readonly PanelLink[] = SETTINGS_SECTIONS.filter((s) => s.id in SETUP_HINTS).map((s) => ({
	id: s.id,
	label: s.label,
	hint: SETUP_HINTS[s.id]!
}));

/**
 * "How the shown run fits": the Model quality panels every run has on Runs & results, by their headings
 * there (runs/sections.ts resultGroups; page.test.ts checks they agree). The ones only some runs have
 * (Runoff model, Rain for each unit, WR2012 check, Plausibility checks) follow them on that page.
 */
export const RESULT_LINKS: readonly PanelLink[] = [
	{ id: 'res-hydrograph', label: 'Hydrograph', hint: 'modelled against observed flow, day by day' },
	{ id: 'res-fdc', label: 'Flow-duration curve', hint: 'how often each flow is reached, and flow at the gauges that are checks only' },
	{ id: 'res-calibration', label: 'Calibration against observed flow', hint: 'the fit’s scores and the calibration check' },
	{ id: 'res-ewr-agreement', label: 'EWR test: model against observed flow', hint: 'whether the model meets the EWR on the days the record does' }
];

/** A link to a Settings & calibration panel. */
export const settingsHref = (id: string): string => `?tab=settings#${id}`;

/** A link to a Runs & results panel, keeping the run picked (`run=`), so the panel opens on that run. */
export function runsHref(id: string, run: string | null): string {
	return run ? `?tab=runs&run=${encodeURIComponent(run)}#${id}` : `?tab=runs#${id}`;
}

/**
 * The run Runs & results shows: the one in the URL while it is still a run of the project, else its
 * default (the newest; a viewer's published baseline). Null with no runs, or before they load.
 */
export function shownRun<T extends { id: string; published?: boolean }>(runs: readonly T[] | null, picked: string | null, role: Role | null | undefined): T | null {
	if (!runs?.length) return null;
	const id = picked && runs.some((r) => r.id === picked) ? picked : defaultRunId(runs, role);
	return runs.find((r) => r.id === id) ?? null;
}

/**
 * Where a Calibration URL goes on, or null. `?tab=calibration` opened Settings & calibration until this
 * page had its own (issue #586), so an old `?tab=calibration#set-ewr` (a bookmark, a note's link) goes
 * to that panel on Settings, every other parameter kept; Settings sends a moved one (`#set-feeds`) on
 * again. Round 3 moves the calibration panels here; their anchors then stay (issue #586 R3-C). The caller replaces the history entry, so Back skips it.
 */
export function calibrationForward(url: Pick<URL, 'pathname' | 'search' | 'hash'>): string | null {
	const hash = hashId(url.hash);
	if (!hash.startsWith('set-')) return null;
	const params = new URLSearchParams(url.search);
	params.set('tab', 'settings');
	return `${url.pathname}?${params}#${hash}`;
}
