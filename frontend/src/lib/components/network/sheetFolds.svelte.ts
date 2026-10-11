// Which parts of the node sheet's form are open (issue #521): its section
// cards, each section's "More … settings" and "Not used …" folds, and the
// "Show every field" switch that opens them all. Kept per browser tab rather
// than per node, so ‹ › to the next unit keeps the same section open (the dam
// of each unit in turn), and the switch is remembered on this device
// (localStorage, read and written defensively, as the flow units are).
const ALL_KEY = 'wm.nodeSheet.all';

function readAll(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(ALL_KEY) === '1';
	} catch {
		return false;
	}
}

class SheetFolds {
	/** Every fold and section opened by hand: a section's name ('dam'), or a fold's key ('more:dam'). */
	open = $state<string[]>([]);
	/** "Show every field": every section and fold open. */
	all = $state(readAll());

	setAll(on: boolean) {
		this.all = on;
		try {
			localStorage.setItem(ALL_KEY, on ? '1' : '0');
		} catch {
			// Storage blocked: it holds until the page reloads.
		}
	}

	/** A sheet opening on a node: with none of its sections open, its first one opens (no section menu press yet). */
	start(sections: readonly string[]) {
		if (sections.length && !sections.some((k) => this.open.includes(k))) this.open = [...this.open, sections[0]!];
	}

	/** Whether a section or fold is open. */
	isOpen(key: string): boolean {
		return this.all || this.open.includes(key);
	}

	/**
	 * A section or fold the reader opened or closed with its summary. `keys`:
	 * every section and fold the form has, for closing one while all show.
	 */
	toggled(key: string, isOpen: boolean, keys: readonly string[]) {
		if (isOpen === this.isOpen(key)) return;
		if (isOpen) this.open = [...this.open, key];
		else if (this.all) {
			// Closing one while every field shows: the rest stay open, as if opened by hand.
			this.setAll(false);
			this.open = keys.filter((k) => k !== key);
		} else this.open = this.open.filter((k) => k !== key);
	}

	/** The section menu's jump: that section open and the other sections closed (each section's folds keep their state). */
	only(section: string, sections: readonly string[]) {
		if (this.all) return;
		this.open = [...this.open.filter((k) => !sections.includes(k)), section];
	}
}

export const sheetFolds = new SheetFolds();
