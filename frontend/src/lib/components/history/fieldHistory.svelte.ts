// The project's per-field change counts (GET …/history/fields), shared by
// every field history line on the page through context. Nothing is fetched
// until a line asks (a node sheet, the farm drawer or Settings opens), so it
// costs the first paint nothing; one request answers every field. The page
// sets it only for members who see History (farmers and applicants don't),
// and refreshes it after a save or a restore.
import { getContext, setContext } from 'svelte';
import { api, type FieldHistory } from '$lib/api';

export class FieldHistoryStore {
	fields = $state<Record<string, FieldHistory> | null>(null);
	#wanted = false;
	#seq = 0;
	readonly projectId: string;

	constructor(projectId: string) {
		this.projectId = projectId;
	}

	/** A line wants the counts: the first call fetches them. */
	want() {
		if (this.#wanted) return;
		this.#wanted = true;
		void this.#fetch();
	}

	/** The inputs changed (a save, a restore): fetch again, if anything has asked. */
	refresh() {
		if (this.#wanted) void this.#fetch();
	}

	async #fetch() {
		const seq = ++this.#seq;
		try {
			const { fields } = await api.history.fields(this.projectId);
			if (seq === this.#seq) this.fields = fields;
		} catch {
			// The lines are an aid, not the form: on a failure they stay hidden and the fields work as before.
		}
	}
}

const KEY = Symbol('field-history');

/** The page's store, read when a line renders (the page may switch projects). */
export function setFieldHistory(get: () => FieldHistoryStore | null) {
	setContext(KEY, get);
}

/** Call while a component initialises; the getter it returns reads the page's current store. */
export function fieldHistoryGetter(): () => FieldHistoryStore | null {
	const get = getContext(KEY) as (() => FieldHistoryStore | null) | undefined;
	return () => get?.() ?? null;
}
