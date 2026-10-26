// The Calibration page (`?tab=calibration`, issue #586): fitting the runoff
// parameters and judging the fit, brought together from Settings &
// calibration and Runs & results. Round 2 gave the page its row, its header
// and its two parts; Round 3 moved the panels in. Its side index lists them
// under the two parts, each by its heading word for word. Pure helpers, so
// the index, the links and the forwarding are unit-tested without the page.
import type { NavGroup, NavSection } from '#lib/components/common/sectionNav.js';
import { modelQualitySections } from '#lib/components/runs/modelQuality.js';
import { CALIBRATION_SETTINGS_SECTIONS, type SettingsSectionId } from '#lib/components/settings/sections.js';
import { defaultRunId } from '#lib/components/runs/runList.js';
import type { Role } from '#lib/api/types.js';

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

/**
 * The side index (issue #586 round 3): a group for each part, named by its heading, listing its panels by
 * theirs. Set up the fit: the four settings panels. How the shown run fits: Model quality's panels for the run
 * shown (runs/modelQuality.ts; none until a run is shown), with a line under Calibration against observed flow
 * for each sub-heading the page draws (`shown`).
 */
export function calibrationNavGroups(
	summary: Parameters<typeof modelQualitySections>[0] | null = null,
	shown: { check?: boolean; provenance?: boolean } = {}
): NavGroup[] {
	const subs: NavSection[] = [...(shown.check ? [CAL_SUBSECTIONS.check] : []), ...(shown.provenance ? [CAL_SUBSECTIONS.provenance] : [])].map((s) => ({ id: s.id, label: s.label }));
	const results = summary ? modelQualitySections(summary).flatMap((s) => (s.id === 'res-calibration' ? [s, ...subs] : [s])) : [];
	return [
		{ label: CAL_PARTS[0].label, sections: CALIBRATION_SETTINGS_SECTIONS.map((s) => ({ id: s.id, label: s.label })) },
		{ label: CAL_PARTS[1].label, sections: results }
	];
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
 * "Set up the fit": the four settings panels, in their page order, named from their section list
 * (settings/sections.ts), so a renamed heading renames the link. Round 2's stand-in for the panels.
 */
export const SETUP_LINKS: readonly PanelLink[] = CALIBRATION_SETTINGS_SECTIONS.filter((s) => s.id in SETUP_HINTS).map((s) => ({
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
