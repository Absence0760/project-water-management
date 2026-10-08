// Fit automatically's state: the choices, the running fit and its result. The
// workspace page holds it (routes/projects/[id]/+page.svelte), not the Settings
// tab, as it holds the unsaved settings (settings/settingsDraft.svelte.ts): a
// fit keeps running, and its result stays to be read and applied, when the
// person opens another tab and comes back. Leaving the project with a fit
// running or a result not yet applied asks first (the page's guardUnsaved);
// leaving anyway, or opening another project, cancels the fit.
import {
	DEFAULT_STARTS,
	type ApanDailyFingerprint,
	type CalibrationBounds,
	type CalibrationFlowKind,
	type CalibrationProgress,
	type CalibrationReport,
	type ObjectiveId,
	type ProjectSettings,
	type SeriesOrigin,
	type SeriesProvenance
} from '@water-management/engine';
import { FitCancelled, type FitHandle } from './runner';

/** What the shown report was run on, for its fit record. */
export interface FitRan {
	settings: ProjectSettings;
	validate: boolean;
	validationRecord: CalibrationFlowKind | null;
	chirpsSource?: SeriesProvenance | null;
	apanDaily?: ApanDailyFingerprint | null;
	observedOrigin?: SeriesOrigin | null;
}

export type FitStatus = 'idle' | 'loading' | 'running' | 'done' | 'error';

export class FitSession {
	/** The project the state belongs to. */
	projectId = $state<string | null>(null);
	objective = $state<ObjectiveId>('kgePrime');
	bounds = $state<CalibrationBounds>('wide');
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
	error = $state<string | null>(null);
	/** The running fit's starts and validation, for its progress bar. */
	runStarts = $state(1);
	runValidate = $state(true);
	/** The shown report has been written into the form. */
	applied = $state(false);
	ran: FitRan | null = null;
	#handle: FitHandle | null = null;
	#gen = 0;

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
		this.applied = false;
		this.progress = null;
		this.ran = null;
		try {
			const context = await prepare();
			// Cancelled, discarded or reset while the data loaded.
			if (gen !== this.#gen) return;
			this.status = 'running';
			this.#handle = run();
			const report = await this.#handle.result;
			if (gen !== this.#gen) return;
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
		this.budget = 1500;
		this.validate = true;
		this.seed = 1;
		this.starts = DEFAULT_STARTS;
		this.validationRecord = null;
		this.picked = {};
	}
}
