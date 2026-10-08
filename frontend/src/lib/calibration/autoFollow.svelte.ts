// Automated calibration's latest run, as the Settings tab follows it
// (calibration/AutoFitPanel.svelte): loads a project's latest run, polls a
// running one every 1.5 s until it completes, fails or its job stops, and
// starts and applies runs. Each open() is a generation: a reply to an earlier
// project (or to a panel that has since closed) is dropped, never shown, and
// stops its own polling. Without that, a request in flight when the person
// opened another project landed in the new project's panel, and the poll it
// scheduled ran on after the panel was gone.
import type { AutoCalibration } from '$lib/api/types';
import { autoState } from './autoFit';

export const POLL_MS = 1500;

/** The server calls the follower makes (api.autoCalibrations; a stub in tests). */
export interface AutoCalibrationApi {
	list(projectId: string): Promise<AutoCalibration[]>;
	get(projectId: string, calibrationId: string): Promise<AutoCalibration>;
	start(projectId: string): Promise<{ calibration: AutoCalibration }>;
	apply(projectId: string, calibrationId: string): Promise<{ calibration: AutoCalibration; runError: string | null }>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AutoCalibrationFollower {
	/** The project's latest run, or null for none (or not loaded yet). */
	latest = $state.raw<AutoCalibration | null>(null);
	error = $state<string | null>(null);
	/** A start or an apply is waiting on the server. */
	busy = $state(false);
	/** An applied fit saved, but its run failed: why. */
	runError = $state<string | null>(null);
	#api: AutoCalibrationApi;
	#projectId: string | null = null;
	#gen = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(api: AutoCalibrationApi) {
		this.#api = api;
	}

	/** The project this follower shows, or null once closed. */
	get projectId(): string | null {
		return this.#projectId;
	}

	/** Show a project's latest run: whatever the previous project had in flight is dropped. */
	open(projectId: string): void {
		this.close();
		this.#projectId = projectId;
		this.latest = null;
		this.error = null;
		this.runError = null;
		this.busy = false;
		void this.#load(this.#gen);
	}

	/** Stop following: no reply already in flight is shown, and no poll runs after this. */
	close(): void {
		this.#gen++;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#projectId = null;
	}

	/** Start a run of the saved rules and follow it. */
	async start(): Promise<void> {
		const gen = this.#gen;
		const id = this.#projectId;
		if (id === null || this.busy) return;
		this.busy = true;
		this.error = null;
		this.runError = null;
		try {
			const res = await this.#api.start(id);
			if (gen !== this.#gen) return;
			this.#show(gen, res.calibration);
		} catch (e) {
			if (gen === this.#gen) this.error = message(e);
		} finally {
			if (gen === this.#gen) this.busy = false;
		}
	}

	/**
	 * Apply the latest run's kept fit. `onApplied` (reload the settings) runs
	 * only while the same project is still shown.
	 */
	async apply(onApplied: () => Promise<void>): Promise<void> {
		const gen = this.#gen;
		const id = this.#projectId;
		const run = this.latest;
		if (id === null || run === null || this.busy) return;
		this.busy = true;
		this.error = null;
		try {
			const res = await this.#api.apply(id, run.id);
			if (gen !== this.#gen) return;
			this.latest = res.calibration;
			this.runError = res.runError;
			await onApplied();
		} catch (e) {
			if (gen === this.#gen) this.error = message(e);
		} finally {
			if (gen === this.#gen) this.busy = false;
		}
	}

	async #load(gen: number): Promise<void> {
		const id = this.#projectId!;
		try {
			const [first] = await this.#api.list(id);
			if (gen !== this.#gen) return;
			this.#show(gen, first ?? null);
		} catch (e) {
			if (gen === this.#gen) this.error = message(e);
		}
	}

	/** Show a run, and poll it again while it is running. */
	#show(gen: number, run: AutoCalibration | null): void {
		this.latest = run;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (run && autoState(run).kind === 'running') this.#timer = setTimeout(() => void this.#poll(gen, run.id), POLL_MS);
	}

	async #poll(gen: number, calibrationId: string): Promise<void> {
		if (gen !== this.#gen) return;
		const id = this.#projectId!;
		try {
			const run = await this.#api.get(id, calibrationId);
			if (gen !== this.#gen) return;
			this.#show(gen, run);
		} catch (e) {
			if (gen === this.#gen) this.error = message(e);
		}
	}
}
