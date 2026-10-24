// A typed search is one step in history (docs/design/ui-playbook.md § 4 "A pick is a step in history"): the first
// change a search box writes to the URL after it takes the focus adds an entry, so Back returns to the page as it
// was before the search; the rest of that search replace it, so Back never steps letter by letter. Shared by the
// project list, Runs' label filter and History's Parameter filter.
//
// "The first" means the first that lands. SvelteKit writes history only once a navigation finishes, and drops one a
// newer navigation overtakes: a push for the first keystroke, overtaken by the second keystroke's replace, never
// happened, and that replace overwrote the entry the search came from, so Back left the app (history-steps.spec.ts,
// on SvelteKit 3). So a write pushes until one of this search's pushes has landed (the address is the one it wrote);
// only one of several overlapping pushes can land, since SvelteKit commits the newest.

/** One search box's history steps: call `focus` from its onfocus, and make each write through `write`. */
export class SearchStep {
	#landed = false;
	#search = 0;
	readonly #here: () => string;

	/** `here`: the address now (the browser's, in the app). */
	constructor(here: () => string = () => location.href) {
		this.#here = here;
	}

	/** The box took the focus: a new search, whose first write adds a history entry. */
	focus = (): void => {
		this.#landed = false;
		this.#search += 1;
	};

	/**
	 * Write one change of the search to `href` with `go(replace)` (a goto with that `replace`): it adds an entry
	 * until a push of this search has landed, then replaces that entry.
	 */
	async write(href: string, go: (replace: boolean) => Promise<unknown>): Promise<void> {
		const replace = this.#landed;
		const search = this.#search;
		const here = this.#here;
		await go(replace);
		if (!replace && search === this.#search && new URL(href, here()).href === here()) this.#landed = true;
	}
}
