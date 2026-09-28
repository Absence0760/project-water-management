// The canonical order the engine sums lists in (docs/model.md §6, order
// invariance). Floating-point addition is not associative, so a sum over the
// nodes, crops, crop areas, land-cover patches or transfers in display order
// can differ in its last bit when the user reorders them. That alone is noise,
// but a dam at its drought trigger or at empty turns it into a different
// result (fuzz seeds 3899, 7094), so every sum that feeds the simulation runs
// in id order instead. Code compares ids with this, not localeCompare, which
// depends on the runtime's locale.

/** Plain code-unit order of two strings: −1, 0 or 1. */
export function cmpStr(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
