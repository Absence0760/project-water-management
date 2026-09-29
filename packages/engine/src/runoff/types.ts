// The rain → natural-flow seam (issue #4). runModel asks the selected runoff
// model for the catchment's natural flow; everything downstream of it (flow
// shares, farms, dams, transfers, EWR) is the same whichever model made it.
//
// Two layers:
// - NaturalFlowGenerator: a whole run, rain in → natural flow (m³/day) out.
// - RunoffModel: one conceptual model stepped a day at a time in mm over the
//   catchment (./gr4j.ts), wrapped into a generator by ./simulate.ts. Its
//   stores are explicit, so the water balance can be checked every day.
import type { ModelInput, ProjectSettings, RunoffBalance, SeriesKind } from '../project';

/**
 * Runoff models a run can use (settings.runoffModel). GR4J only since engine
 * 1.0.0, which removed the legacy b023 recession model (issue #16).
 */
export const RUNOFF_MODELS = ['gr4j'] as const;
export type RunoffModelId = (typeof RUNOFF_MODELS)[number];
/**
 * The runoff model a stored run records: a run saved before engine 1.0.0 may
 * have used the legacy b023 recession model ('legacy'), and a run whose
 * settings don't name one predates the setting and ran it too. Such runs stay
 * readable, never re-run (docs/engine-audit.md H1).
 */
export type StoredRunoffModelId = RunoffModelId | 'legacy';

/** One parameter of a RunoffModel: what a form, validation and calibration need. */
export interface ParamSpec<P> {
	key: keyof P & string;
	label: string;
	unit: string;
	default: number;
	/** Hard bounds: settings outside them are rejected, and calibration searches inside them. */
	min: number;
	max: number;
	/** The usual range in published applications (guidance for a hand-tuner, not a limit). */
	typical: [number, number];
	/** Fixed at its default unless the user opts in (GR4J's X2). */
	fixedByDefault?: boolean;
}

/** One day's fluxes out of a RunoffModel, in mm over the catchment. */
export interface DayFluxes {
	/** Flow at the outlet of the catchment's runoff model (natural flow). */
	qMm: number;
	/** Actual evaporation. */
	aetMm: number;
	/** Water gained (+) or lost (−) through groundwater exchange, as applied. */
	exchangeMm: number;
}

/** A named store of a RunoffModel, reported as a daily series (mm, end of day). */
export interface StoreSpec {
	key: string;
	label: string;
}

/**
 * A conceptual rainfall–runoff model stepped one day at a time. State is
 * mutable and step() allocates nothing, so a calibration can call it millions
 * of times. The daily water balance
 *   P − AET − Q + exchange = Δ storage(s)
 * holds for every model (testing/runoff.ts checks it).
 */
export interface RunoffModel<P, S> {
	id: RunoffModelId;
	params: ParamSpec<P>[];
	/** A fresh state; `fill` is the starting fraction of each finite store (default ½). */
	init(p: P, fill?: number): S;
	/** Advance one day with rain and potential evaporation (mm); writes the fluxes into `out`. */
	step(p: P, s: S, rainMm: number, petMm: number, out: DayFluxes): void;
	/** mm held in every store, unit-hydrograph queues included. */
	storage(s: S): number;
	stores: StoreSpec[];
	/** Each store's capacity (mm) in `stores` order; null = unbounded. */
	capacities(p: P): (number | null)[];
	/** Each store's content (mm), in `stores` order, into `out`. */
	readStores(s: S, out: Float64Array): void;
	/**
	 * The whole state as plain numbers (unit-hydrograph queues included), for a
	 * model-state snapshot (engine ≥ 1.1.0, ../warmstart); loadState(p, it)
	 * gives back a state that steps on to the bit. Optional: a model without
	 * them can't be captured or resumed.
	 */
	saveState?(s: S): number[];
	/** A state from saveState's numbers under the same parameters; throws when they don't fit. */
	loadState?(p: P, data: readonly number[]): S;
}

/** Natural flow for the run window, plus any extra catchment series to report. */
export interface NaturalFlowInput {
	naturalFlowM3Day: ArrayLike<number>;
	series?: { key: string; label: string; unit: string; values: number[] }[];
	/** Problems found while producing the natural flow (added to the run's warnings). */
	warnings?: string[];
	/** The runoff model's water balance (conceptual models), reported as summary.runoff. */
	balance?: RunoffBalance;
	/** The model's state at the start of run day `ctx.warm.captureAt`, when asked (engine ≥ 1.1.0, ../warmstart). */
	state?: number[];
}

export interface RunContext {
	settings: ProjectSettings;
	startDate: string;
	days: number;
	/** A project series cut/padded to the run window (null where missing). */
	aligned(kind: SeriesKind): (number | null)[];
	/**
	 * Capture and resume (engine ≥ 1.1.0, ../warmstart): return the model's
	 * state at the start of run day `captureAt` (0 … days) as
	 * NaturalFlowInput.state; or start the run from `resume`, a state captured
	 * that way, instead of the initial fill and the warm-up.
	 */
	warm?: { captureAt?: number; resume?: readonly number[] };
	/**
	 * The run's historical days, before its forecast tail (../forecastTail.ts;
	 * absent = every day). A warm-up that cycles the forcing cycles only
	 * these (engine ≥ 1.28.0), so a forecast tail can't change it.
	 */
	historyDays?: number;
}

/** Produces a run's natural flow. */
export type NaturalFlowGenerator = (input: ModelInput, ctx: RunContext) => NaturalFlowInput;
