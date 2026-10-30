// Fit automatically's state: the choices, the running fit and its result. The
// workspace page holds it (routes/projects/[id]/+page.svelte), not the Settings
// tab, as it holds the unsaved settings (settings/settingsDraft.svelte.ts): a
// fit keeps running, and its result stays to be read and applied, when the
// person opens another tab and comes back. Leaving the project with a fit
// running or a result not yet applied asks first (the page's guardUnsaved);
// leaving anyway, or opening another project, cancels the fit.
import {
	DEFAULT_PRIOR_WEIGHT,
	DEFAULT_STARTS,
	type ApanDailyFingerprint,
	type DailySeries,
	type CalibrationBounds,
	type CalibrationFlowKind,
	type CalibrationProgress,
	type CalibrationReport,
	type FitRecord,
	type ObjectiveId,
	type ProjectSettings,
	type SeriesOrigin,
	type SeriesProvenance,
	type StepwiseProgress,
	type ZoneFitStep
} from '@water-management/engine';
import { priorUseOfRecord, type PriorUse } from './prior';
import { FitCancelled, type FitHandle } from './runner';

/** What the shown report was run on, for its fit record. */
export interface FitRan {
	settings: ProjectSettings;
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	chirpsSource?: SeriesProvenance | null;
	apanDaily?: ApanDailyFingerprint | null;
	/** The daily reference ET series as the fit loaded it (issue #604 R5-E): fingerprinted at Apply, through the fit's last scored day. */
	et0Series?: Pick<DailySeries, 'startDate' | 'values'> | null;
	observedOrigin?: SeriesOrigin | null;
	/** Every record's source and given unit as the fit loaded them, by model-input key: a stepwise fit's zone records' (issue #555). */
	origins?: Record<string, SeriesOrigin | null>;
}

export type FitStatus = 'idle' | 'loading' | 'running' | 'done' | 'error';

export class FitSession {
	/** The project the state belongs to. */
	projectId = $state<string | null>(null);
	objective = $state<ObjectiveId>('kgePrime');
	bounds = $state<CalibrationBounds>('wide');
	/** How the fit uses the regional prior (issue #622): off, a penalty, the search box, or both. */
	priorUse = $state<PriorUse>('off');
	/** The prior's penalty weight (engine DEFAULT_PRIOR_WEIGHT unless changed). */
	priorWeight = $state<number | null>(DEFAULT_PRIOR_WEIGHT);
	budget = $state<number | null>(1500);
	validate = $state(true);
	// Shown and recorded: the same seed, inputs and engine version reproduce the fit.
	seed = $state<number | null>(1);
	starts = $state<number | null>(DEFAULT_STARTS);
	validationRecord = $state<CalibrationFlowKind | null>(null);
	/** The parameters ticked to fit; the panel seeds the defaults. */
	picked = $state<Record<string, boolean>>({});
	status = $state<FitStatus>('idle');
	progress = $state<CalibrationProgress | null>(null);
	report = $state.raw<CalibrationReport | null>(null);
	/**
	 * A stepwise fit's steps, in dependency order (calibration locations, issue #659, docs/model.md §2.10n): `report`
	 * is the headline location's step's. null before a fit.
	 */
	steps = $state.raw<ZoneFitStep[] | null>(null);
	/** Which step is running, for the progress line; null for one fit. */
	stepProgress = $state<Pick<StepwiseProgress, 'step' | 'steps' | 'zoneNodeId'> | null>(null);
	error = $state<string | null>(null);
	/** The running fit's starts and validation, for its progress bar. */
	runStarts = $state(1);
	runValidate = $state(true);
	/** The shown report has been written into the form. */
	applied = $state(false);
	ran: FitRan | null = null;
	#handle: FitHandle | null = null;
	#gen = 0;
	/** The search choices have been started from the project's fit record since the last reset (searchFrom). */
	#searchSeeded = false;

	get busy(): boolean {
		return this.status === 'running' || this.status === 'loading';
	}

	/** A fit running, or a result not yet applied to the form. */
	get unapplied(): boolean {
		return this.busy || (this.report !== null && !this.applied);
	}

	/**
	 * Run one fit: `prepare` loads what it needs (status 'loading'), `run`
	 * starts the worker. A fit already running is cancelled first.
	 */
	async start(prepare: () => Promise<Omit<FitRan, 'observedOrigin'>>, run: () => FitHandle, origin: (report: CalibrationReport) => SeriesOrigin | null | undefined): Promise<void> {
		this.#stop();
		const gen = this.#gen;
		this.status = 'loading';
		this.error = null;
		this.report = null;
		this.steps = null;
		this.stepProgress = null;
		this.applied = false;
		this.progress = null;
		this.ran = null;
		try {
			const context = await prepare();
			// Cancelled, discarded or reset while the data loaded.
			if (gen !== this.#gen) return;
			this.status = 'running';
			const handle = (this.#handle = run());
			const report = await handle.result;
			const steps = handle.steps ? await handle.steps : null;
			if (gen !== this.#gen) return;
			this.steps = steps;
			const o = origin(report);
			this.ran = { ...context, ...(o !== undefined ? { observedOrigin: o } : {}) };
			this.report = report;
			this.status = 'done';
		} catch (e) {
			if (e instanceof FitCancelled || gen !== this.#gen) return;
			this.error = e instanceof Error ? e.message : String(e);
			this.status = 'error';
		} finally {
			if (gen === this.#gen) this.#handle = null;
		}
	}

	/** End whatever is in flight: a later await in `start` sees the new generation and stops. */
	#stop(): void {
		this.#gen++;
		const h = this.#handle;
		this.#handle = null;
		h?.cancel();
	}

	/** Stop a running fit; nothing it found is kept. */
	cancel(): void {
		this.#stop();
		if (this.busy) this.status = 'idle';
	}

	/** Drop the result without applying it. */
	discard(): void {
		this.cancel();
		this.report = null;
		this.steps = null;
		this.stepProgress = null;
		this.ran = null;
		this.applied = false;
		this.progress = null;
		this.error = null;
		this.status = 'idle';
	}

	/** Another project (or none): cancel and start over with the default choices. */
	reset(projectId: string | null): void {
		this.discard();
		this.projectId = projectId;
		this.objective = 'kgePrime';
		this.bounds = 'wide';
		this.priorUse = 'off';
		this.priorWeight = DEFAULT_PRIOR_WEIGHT;
		this.budget = 1500;
		this.validate = true;
		this.seed = 1;
		this.starts = DEFAULT_STARTS;
		this.validationRecord = null;
		this.picked = {};
		this.#searchSeeded = false;
	}

	/**
	 * Start the Search choices (bounds, model runs per fit, starts, seed) from
	 * the project's fit record, so a re-fit repeats the last one unless they
	 * are changed (issue #554). Once per reset: the page calls it on every load,
	 * and a reload of the same project mustn't undo a choice made since. A
	 * record from before starts were recorded ran one start. No record (or
	 * none yet): the defaults stay, and a later load with a record still
	 * applies it.
	 */
	searchFrom(record: Pick<FitRecord, 'bounds' | 'budget' | 'starts' | 'seed' | 'prior'> | null | undefined): void {
		if (this.#searchSeeded || !record) return;
		this.#searchSeeded = true;
		// A fit with the regional prior (issue #622): its use and weight; its box is the prior's, not a Bounds choice.
		const p = priorUseOfRecord(record);
		this.bounds = p.bounds;
		this.priorUse = p.use;
		if (p.weight !== null) this.priorWeight = p.weight;
		this.budget = record.budget;
		this.starts = record.starts ?? 1;
		this.seed = record.seed;
	}
}
