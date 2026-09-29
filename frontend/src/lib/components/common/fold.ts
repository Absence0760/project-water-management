/**
 * The fold a long list shares across the workspace (the Data table, the Supply and
 * Allocations cards and rows): the first `cap` items in the list's own order, plus the picked item
 * wherever it sits, so a shared link or a pick keeps its row in view. Folding away a single item
 * isn't worth a button, so a list of `cap + 1` shows whole. `key` names an item (a series id, a
 * node id); `hidden` is how many the fold leaves out.
 */
export function foldList<T>(items: readonly T[], key: (item: T) => string, pickedId: string | null, open: boolean, cap: number): { shown: T[]; hidden: number } {
	if (open || items.length <= cap + 1) return { shown: [...items], hidden: 0 };
	const shown = items.filter((item, i) => i < cap || (pickedId !== null && key(item) === pickedId));
	return { shown, hidden: items.length - shown.length };
}
