// The Data page's gauge vs logger table flows with the page instead of
// scrolling in a box (docs/ui.md § Data, "nothing on it scrolls inside
// itself"): every flagged water year and the latest few show, the rest behind
// "Show all N water years". Folding away a single year isn't worth a button
// (as common/fold.ts).

/** The years shown, in their own order, and how many the fold leaves out. */
export function agreementFold<T extends { flagged: boolean }>(years: readonly T[], open: boolean, latest = 5): { shown: T[]; hidden: number } {
	if (open) return { shown: [...years], hidden: 0 };
	const shown = years.filter((y, i) => y.flagged || i >= years.length - latest);
	if (years.length - shown.length <= 1) return { shown: [...years], hidden: 0 };
	return { shown, hidden: years.length - shown.length };
}
