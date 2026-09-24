// When a node is picked on the schematic in the one-node view, the form under
// the node picker should come into view if the user can't already see it.

/**
 * True when the one-node form (which starts at the picker) is mostly out of
 * view: the picker sits in the bottom 40 % of the viewport or below it, or has
 * scrolled up out of it.
 */
export function formOffScreen(picker: { top: number; bottom: number }, viewportHeight: number): boolean {
	return picker.top > viewportHeight * 0.6 || picker.bottom < 0;
}
