/**
 * The Data table's fold: the first `cap` rows in the table's order (series/freshness.ts
 * `freshnessOrder`: the series behind, then those a run reads, then the rest), plus the charted
 * series wherever it sits, so a `series=` link or a pick keeps its row in view. Folding away a single
 * row isn't worth a button, so a list of `cap + 1` shows whole. `hidden` is how many the fold leaves
 * out. (The Dams page's `foldCards` is the same rule over cards keyed by node.)
 */
export function foldRows<T extends { id: string }>(rows: readonly T[], pickedId: string | null, open: boolean, cap: number): { shown: T[]; hidden: number } {
	if (open || rows.length <= cap + 1) return { shown: [...rows], hidden: 0 };
	const shown = rows.filter((r, i) => i < cap || r.id === pickedId);
	return { shown, hidden: rows.length - shown.length };
}
