// The Outputs page (docs/ui.md § Outputs): the five planning outputs of issue
// #53 on one page, for one run (docs/design/planning-outputs.md). The outputs
// themselves are their own components, kept where they were too (EWR, Hydrological
// units, the impact report); this module is the page's own logic: its index,
// whether Share the pain has figures for the run, and which baseline the
// licence impact board compares the run with.
import type { CurtailmentSummary } from '@water-management/engine';
import type { NavGroup } from '#lib/components/common/sectionNav.js';
import { IRRIGATION_SUPPORT_HEADING } from '#lib/components/outcomes/irrigationSupport.js';
import { isScenarioRun, type ScenarioRunFields } from '#lib/components/runs/scenarioRun.js';

/** Each output's anchor on the page, in the page's order. */
export const OUTPUT_ANCHORS = {
	irrigation: 'out-irrigation',
	share: 'out-share',
	matrix: 'out-matrix',
	outlook: 'out-outlook',
	licence: 'out-licence'
} as const;

/** The board's own heading (report/LicenceImpactBoard.svelte), which the section keeps when the board can't show. */
export const LICENCE_IMPACT_HEADING = 'Impact by year class';

/** True for one of the page's anchors (a `#out-…` link to land on). */
export function isOutputAnchor(id: string): boolean {
	return (Object.values(OUTPUT_ANCHORS) as string[]).includes(id);
}

/** The in-page index: each section by its heading, word for word (ui-playbook § An index names each panel as the page does). */
export function outputNavGroups(): NavGroup[] {
	return [
		{
			label: 'Planning outputs',
			sections: [
				{ id: OUTPUT_ANCHORS.irrigation, label: IRRIGATION_SUPPORT_HEADING },
				{ id: OUTPUT_ANCHORS.share, label: 'Share the pain' },
				{ id: OUTPUT_ANCHORS.matrix, label: 'Outcome matrix' },
				{ id: OUTPUT_ANCHORS.outlook, label: 'Seasonal outlook' },
				{ id: OUTPUT_ANCHORS.licence, label: LICENCE_IMPACT_HEADING }
			]
		}
	];
}

/**
 * Whether the run's curtailment report can draw the share-the-pain board:
 * `none` for a run from before curtailment targets (engine < 0.3.0), `noUnits`
 * for a network without hydrological units, else `ok`.
 */
export function shareState(c: CurtailmentSummary | null | undefined): 'none' | 'noUnits' | 'ok' {
	if (!c) return 'none';
	return c.farms.length ? 'ok' : 'noUnits';
}

/** The scenario fields the pairing reads (api Scenario). */
export interface PairScenario {
	id: string;
	name: string;
	baseRunId: string;
	lastRun: { id: string; label: string; createdAt: string } | null;
}

/**
 * The baseline the licence impact board compares the run with, never invented:
 *
 * - `pair`: the run is a scenario's run, and its baseline is the base run that
 *   scenario names (the Scenarios page's *Scenario against its base*, which then
 *   follows the base the run recorded when the scenario was rebased since;
 *   the page does the same through GET /compare/runs).
 * - `base`: the run is a run of the model. The board needs a proposal, so the
 *   page offers the newest run of each scenario based on this run (`proposals`,
 *   possibly none) rather than choose one.
 * - `unknown`: a scenario's run whose scenario was deleted, or that the reader
 *   can't see: its base isn't known here (the evidence report still has it).
 */
export type LicencePair =
	| { kind: 'pair'; baseRunId: string; scenarioName: string }
	| { kind: 'base'; proposals: { runId: string; scenarioName: string }[] }
	| { kind: 'unknown' };

export function licencePair(run: { id: string } & ScenarioRunFields, scenarios: readonly PairScenario[]): LicencePair {
	if (isScenarioRun(run)) {
		// Classified by isScenarioRun above; the id only finds the scenario (null once it is deleted).
		const { scenarioId } = run;
		const s = scenarioId ? scenarios.find((x) => x.id === scenarioId) : undefined;
		return s ? { kind: 'pair', baseRunId: s.baseRunId, scenarioName: s.name } : { kind: 'unknown' };
	}
	const proposals = scenarios
		.filter((s) => s.baseRunId === run.id && s.lastRun)
		.sort((a, b) => Date.parse(b.lastRun!.createdAt) - Date.parse(a.lastRun!.createdAt) || a.name.localeCompare(b.name))
		.map((s) => ({ runId: s.lastRun!.id, scenarioName: s.name }));
	return { kind: 'base', proposals };
}
