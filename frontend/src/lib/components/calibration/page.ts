// The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
// parameters and judging the fit, brought together from Settings (now Model
// settings) and Runs & results. Round 2 gave the page its row, its header and
// its two parts; round 3 moved the settings panels into "Set up the fit"
// (settings/CalibrationSettings.svelte). Until Model quality moves in, "How
// the shown run fits" links to its panels on Runs & results, by their headings
// word for word, so the page is never a dead end. Pure helpers, so the links
// and the forwarding are unit-tested without the page.
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';

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


/**
 * The run Runs & results shows, and so How the shown run fits (CalibrationResults.svelte): the one in the URL
 * while it is still a run of the project, else its default (the newest; a viewer's published baseline). Null
 * with no runs, or before they load.
 */
export function shownRun<T extends { id: string; published?: boolean }>(runs: readonly T[] | null, picked: string | null, role: Role | null | undefined): T | null {
	if (!runs?.length) return null;
	const id = picked && runs.some((r) => r.id === picked) ? picked : defaultRunId(runs, role);
	return runs.find((r) => r.id === id) ?? null;
}
