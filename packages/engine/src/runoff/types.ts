// The rain → natural-flow seam (issue #4). runModel asks the selected runoff
// model for the catchment's natural flow; everything downstream of it (flow
// shares, farms, dams, transfers, EWR) is the same whichever model made it.
//
// Two layers:
// - NaturalFlowGenerator: a whole run, rain in → natural flow (m³/day) out.
//   The legacy b023 recession model lives at this level (./legacy.ts), because
//   its day depends on the calendar (seasons) and it falls back to Pitman flow.
// - RunoffModel: one conceptual model stepped a day at a time in mm over the
//   catchment (./gr4j.ts), wrapped into a generator by ./simulate.ts. Its
//   stores are explicit, so the water balance can be checked every day.
import type { ModelInput, ProjectSettings, SeriesKind } from '../project';

/** Runoff models a project can select (settings.runoffModel). */
export const RUNOFF_MODELS = ['legacy'] as const;
export type RunoffModelId = (typeof RUNOFF_MODELS)[number];

/** Natural flow for the run window, plus any extra catchment series to report. */
export interface NaturalFlowInput {
	naturalFlowM3Day: ArrayLike<number>;
	series?: { key: string; label: string; unit: string; values: number[] }[];
	/** Problems found while producing the natural flow (added to the run's warnings). */
	warnings?: string[];
}

export interface RunContext {
	settings: ProjectSettings;
	startDate: string;
	days: number;
	/** A project series cut/padded to the run window (null where missing). */
	aligned(kind: SeriesKind): (number | null)[];
}

/** Produces a run's natural flow. */
export type NaturalFlowGenerator = (input: ModelInput, ctx: RunContext) => NaturalFlowInput;
