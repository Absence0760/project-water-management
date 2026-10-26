// The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
// parameters and judging the fit, brought together from Settings &
// calibration and Runs & results. Round 2 gave the page its row, its header
// and its two parts; Round 3 moved the panels in. Its side index lists them
// under the two parts, each by its heading word for word. Pure helpers, so
// the index, the links and the forwarding are unit-tested without the page.
import type { NavGroup, NavSection } from '#lib/components/common/sectionNav.js';
import { modelQualitySections } from '#lib/components/runs/modelQuality.js';
import { CALIBRATION_SETTINGS_SECTIONS } from '#lib/components/settings/sections.js';
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';
import { checkGauges } from './calibrationCheck';

/** The page's two parts, by their headings' anchors (CalibrationTab.svelte sets them). */
export const CAL_PARTS = [
	{ id: 'cal-setup', label: 'Set up the fit' },
	{ id: 'cal-fit', label: 'How the shown run fits' }
] as const;

export type CalPartId = (typeof CAL_PARTS)[number]['id'];

/**
 * The sub-headings of Calibration against observed flow with an index line of their own (issue #586, D4), each
 * its heading's id and words: the flow-against-use check per gauge (CalibrationCheck.svelte sets the id) and
 * where the run's parameters came from (FitProvenance.svelte, given `headingId`). Each is drawn only on some
 * runs, so the page says which it shows.
 */
export const CAL_SUBSECTIONS = {
	check: { id: 'res-calibration-check', label: 'Calibration check: flow against use, per gauge' },
	provenance: { id: 'res-fit-provenance', label: 'Where the parameters came from' }
} as const;

/** Every anchor How the shown run fits lands on beyond Model quality's panels: the sub-headings above. */
export const isCalSubsection = (id: string): boolean => Object.values(CAL_SUBSECTIONS).some((s) => s.id === id);

/** Which of the sub-headings above a run's Model quality draws, for the side index (`calibrationNavGroups`' `shown`). */
export interface CalShown {
	check: boolean;
	provenance: boolean;
}

/**
 * The sub-headings Model quality draws for a run, as ModelQuality.svelte decides them: the calibration check when
 * the run stored an observed record it can chart (CalibrationCheck.svelte: the outlet's always, an inner gauge's
 * only with the run's network), and where the parameters came from when the run kept its settings.
 */
export function calShown(run: { settings?: unknown; model?: { nodes?: readonly unknown[] } | null }, refs: readonly { key: string; nodeId: string | null }[]): CalShown {
	const known = (run.model?.nodes?.length ?? 0) > 0;
	return { check: checkGauges(refs).some((g) => known || g === null), provenance: !!run.settings };
}

/**
 * The side index (issue #586 round 3): a group for each part, named by its heading, listing its panels by
 * theirs. Set up the fit: the four settings panels. How the shown run fits: Model quality's panels for the run
 * shown (runs/modelQuality.ts), with a line under Calibration against observed flow for each sub-heading the page
 * draws (`shown`); until a run is shown, one line to the part itself, where its empty or loading state is.
 */
export function calibrationNavGroups(
	summary: Parameters<typeof modelQualitySections>[0] | null = null,
	shown: Partial<CalShown> = {}
): NavGroup[] {
	const subs: NavSection[] = [...(shown.check ? [CAL_SUBSECTIONS.check] : []), ...(shown.provenance ? [CAL_SUBSECTIONS.provenance] : [])].map((s) => ({ id: s.id, label: s.label, sub: true }));
	const results = summary ? modelQualitySections(summary).flatMap((s) => (s.id === 'res-calibration' ? [s, ...subs] : [s])) : [];
	return [
		{ label: CAL_PARTS[0].label, sections: CALIBRATION_SETTINGS_SECTIONS.map((s) => ({ id: s.id, label: s.label })) },
		// No run shown yet (none, or still loading): the part itself, so the index still reaches its empty state.
		summary ? { label: CAL_PARTS[1].label, sections: results } : { label: null, sections: [{ id: CAL_PARTS[1].id, label: CAL_PARTS[1].label }] }
	];
}

export const isCalPart = (id: string): id is CalPartId => CAL_PARTS.some((p) => p.id === id);

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
