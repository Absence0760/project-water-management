// How long the server's background model work would take on the job worker
// (an automated calibration's fit, the ensemble after an applied fit),
// estimated from the model's size, never from a clock: the same project and
// rules always get the same answer, on an idle server or a busy one
// (docs/model.md §2.10j, "Run by the server").
//
// It used to time model runs in the request and scale them, so a busy server
// (a loaded CI runner, a Lambda sharing its CPU) refused rules it had
// accepted a moment before. The work instead grows with the model's size: a
// fit evaluation runs the units' GR4J over the warm-up and the record, then
// the network over the record, so its cost is about
//
//   days × (A + B × nodes) + warm-up days × G × runoff units + C × nodes + D
//
// The constants are an upper envelope, not a fit: the largest cost measured
// over 522 evaluations (2026-10-30: the four example catchments, the
// Showcase and 87 random networks of 1 to 41 nodes from the fuzz generator,
// each at its full record and a quarter of it, with 0, 365 and 3 650 warm-up
// days; Node 24 on an AMD Ryzen 9 5900HX, nothing else running) was 0.75 of
// what they give, the median 0.43. A model run has its own envelope the same
// way (runModelWithoutChecks: largest 0.72 of it, median 0.44, over 36 runs),
// and a whole server ensemble (its context, every member's run and scoring)
// stays inside members + 1 of those (30 members on 30 networks: largest 0.84,
// median 0.40). WORKER_SLOWDOWN carries that machine's
// times to the job worker's: an arm64 Lambda (Graviton2, about half the
// single-thread speed) at 1 024 MB, which is 0.58 of a vCPU (1 024 / 1 769),
// so about 3.5×, taken as 4. Production's worker has 2 048 MB (a full vCPU)
// when delineation is on, so there the estimate errs further on the long side.
//
// An estimate that is still too short is caught while the work runs: the job
// stops a fit (or an ensemble) once it passes the same limit, and fails,
// saying so (store.ts fitNextCase, jobs/handlers/uncertainty.ts), rather than
// the Lambda timing out on it. Each case job logs its estimate beside its
// time (`auto_calibration_case`), which is what to re-derive WORKER_SLOWDOWN
// from on the deployed worker.
import { prepareRun, type AutoCalibrationPlan, type ModelInput } from '@water-management/engine';

/** What the cost grows with: the run's days, its nodes, the nodes with a catchment area (a GR4J unit each) and the GR4J warm-up. */
export interface ModelSize {
	days: number;
	nodes: number;
	units: number;
	warmupDays: number;
}

interface Envelope {
	/** µs per day of the record. */
	perDay: number;
	/** µs per node per day of the record. */
	perNodeDay: number;
	/** µs per runoff unit per warm-up day. */
	perUnitWarmupDay: number;
	/** µs per node, once per call. */
	perNode: number;
	/** µs per call. */
	perCall: number;
}

/** One fit evaluation (calibrate.ts prepareCalibration's simulate), on the measuring machine. */
export const EVALUATION_US: Envelope = { perDay: 3, perNodeDay: 2, perUnitWarmupDay: 0.2, perNode: 100, perCall: 500 };
/** One model run, on the measuring machine. */
export const RUN_US: Envelope = { perDay: 10, perNodeDay: 4, perUnitWarmupDay: 0.2, perNode: 300, perCall: 20_000 };
/** The job worker's time over the measuring machine's (see the header). */
export const WORKER_SLOWDOWN = 4;
/**
 * Model runs a case makes besides its fit's evaluations: preparing the fit
 * and each validation record, and the run with the fitted parameters
 * (calibrate/auto.ts runAutoCase). Generous: they are a rounding error
 * beside the evaluations except on the smallest searches.
 */
export const CASE_EXTRA_RUNS = 5;

/** The GR4J warm-up a run uses (runoff/simulate.ts resolveWarmupDays): a whole number of days 0–3 650, else 365. */
function warmupDaysOf(input: ModelInput): number {
	const v = (input.settings as { gr4j?: { warmupDays?: unknown } }).gr4j?.warmupDays;
	return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650 ? v : 365;
}

/** The model's size, from the input alone. Throws as a run would when it has no simulation period. */
export function modelSize(input: ModelInput): ModelSize {
	const nodes = input.model.nodes;
	return {
		days: prepareRun(input).days,
		nodes: nodes.length,
		units: nodes.filter((n) => n.areaKm2 > 0).length,
		warmupDays: warmupDaysOf(input)
	};
}

const micros = (e: Envelope, s: ModelSize): number =>
	s.days * (e.perDay + e.perNodeDay * s.nodes) + s.warmupDays * e.perUnitWarmupDay * s.units + e.perNode * s.nodes + e.perCall;

/** Seconds one fit evaluation takes on the job worker, at most. */
export const evaluationSeconds = (s: ModelSize): number => (WORKER_SLOWDOWN * micros(EVALUATION_US, s)) / 1e6;
/** Seconds one model run takes on the job worker, at most. */
export const runSeconds = (s: ModelSize): number => (WORKER_SLOWDOWN * micros(RUN_US, s)) / 1e6;

/** Seconds one case of a run of the rules (a fit with validation, then a run) takes on the job worker, at most. */
export const caseSeconds = (plan: Pick<AutoCalibrationPlan, 'caseEvaluations'>, s: ModelSize): number =>
	plan.caseEvaluations * evaluationSeconds(s) + CASE_EXTRA_RUNS * runSeconds(s);

/** Seconds an ensemble of `members` sampled members (and member 0) takes on the job worker, at most. */
export const ensembleSeconds = (members: number, s: ModelSize): number => (members + 1) * runSeconds(s);

/** A clock for the deadline the job keeps while the work runs (store.ts fitNextCase); tests pass their own. */
export type Clock = () => number;
export const wallClock: Clock = () => performance.now();
