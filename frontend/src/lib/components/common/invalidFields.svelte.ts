// The number fields that hold text they can't take (NumberInput), while they
// are mounted. Such a field keeps what was typed and says how to fix it, but
// the model never changed, so without this the save bar would say "No unsaved
// changes" and a navigation would drop the typed text without asking. The
// save bar and the leave guard read `count` (and `fields`, to name them), and
// a Discard calls `reset()` to put every invalid field back to its stored
// value: a discard that restores the same value wouldn't move the field
// otherwise.
import { SvelteMap } from 'svelte/reactivity';

export interface InvalidField {
	/** The field's id (NumberInput's own, or the `id` prop). */
	id: string;
	/** The field's accessible name, as a list names it ("Losses on the way, %"); '' when it has none. */
	label: string;
	/** What the field says to fix it ("Enter a number from 0 to 99.9"). */
	message: string;
}

class InvalidFields {
	#fields = new SvelteMap<string, InvalidField>();
	#epoch = $state(0);

	/** How many mounted fields are invalid now (reactive). */
	get count(): number {
		return this.#fields.size;
	}

	/** The invalid fields, in the order they turned invalid (reactive). */
	get fields(): InvalidField[] {
		return [...this.#fields.values()];
	}

	/** Bumped by `reset()`; every NumberInput follows it. */
	get epoch(): number {
		return this.#epoch;
	}

	/** Record (or update) an invalid field under its instance's `key`. NumberInput calls it. */
	set(key: string, field: InvalidField): void {
		this.#fields.set(key, field);
	}

	/** Forget a field: it is valid again, or unmounted. NumberInput calls it. */
	delete(key: string): void {
		this.#fields.delete(key);
	}

	/** Put every invalid field back to the value it holds (Discard, after a save). */
	reset(): void {
		this.#epoch++;
	}
}

export const invalidFields = new InvalidFields();
