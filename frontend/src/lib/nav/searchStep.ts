// A typed search is one step in history (docs/design/ui-playbook.md § 4 "A pick is a step in history"): the first
// change a search box writes to the URL after it takes the focus adds an entry, so Back returns to the page as it
// was before the search; the rest of that search replace it, so Back never steps letter by letter. Shared by the
// project list, Runs' label filter and History's Parameter filter.

/** One search box's history steps: call `focus` from its onfocus, and pass `replace()` as goto's `replace` on each write. */
export class SearchStep {
	#stepped = false;

	/** The box took the focus: its next write adds a history entry. */
	focus = (): void => {
		this.#stepped = false;
	};

	/** goto's `replace` for a write the box is about to make: false for the first since the focus, true after. */
	replace(): boolean {
		const replace = this.#stepped;
		this.#stepped = true;
		return replace;
	}
}
