// The model input the Data tab's derived rows read (issue #553 round 5, docs/ui.md § Data): the input a run would
// read (GET /projects/:id/model-input), fetched once when an area row opens or a grouped CSV is built, and dropped
// whenever the series, the settings or the model change, so a derived line is never older than its inputs. A
// result that arrives after the inputs changed is neither kept nor reported as current (`current`). Pure: no Svelte.
import type { ModelInput } from '@water-management/engine';

export class ModelInputCache {
	#fetch: () => Promise<ModelInput>;
	#input: ModelInput | null = null;
	#pending: Promise<ModelInput> | null = null;
	/** Bumped by every invalidate(): a caller holding an older one has a stale answer. */
	generation = 0;

	constructor(fetch: () => Promise<ModelInput>) {
		this.#fetch = fetch;
	}

	/** The inputs changed: forget the input, and make every answer in flight stale. */
	invalidate(): void {
		this.generation++;
		this.#input = null;
		this.#pending = null;
	}

	/** Whether an answer started at `generation` is still current. */
	current(generation: number): boolean {
		return generation === this.generation;
	}

	/** The input: the one held, else one fetch shared by every caller until it settles (a failed one is retried next time). */
	async get(): Promise<ModelInput> {
		if (this.#input) return this.#input;
		const gen = this.generation;
		const pending = (this.#pending ??= this.#fetch());
		try {
			const input = await pending;
			if (this.current(gen)) this.#input = input;
			return input;
		} catch (e) {
			if (this.current(gen) && this.#pending === pending) this.#pending = null;
			throw e;
		}
	}
}
