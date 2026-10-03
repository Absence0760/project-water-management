// What the workspace's save bar (SaveBar.svelte) needs from an unsaved form
// the page holds besides the model: today the project details
// (project/detailsDraft.svelte.ts). The page adapts each one to this shape
// (routes/projects/[id]/+page.svelte, `pageDrafts`) and passes the list to the
// bar, which shows them, lists their problems, and discards them with the
// model; the page's saveAll saves them, each before the model. A new form
// that must outlive a tab change (Settings' draft) is one more entry: its
// draft, an adapter, and a branch in saveAll if its save needs more than
// `save()`.

export interface PageDraft {
	/** What the bar and its questions call it: "the project details". */
	what: string;
	/** The bar's region name when this is the only unsaved work: "Unsaved project details". */
	region: string;
	/** Where its problems are fixed (a link in the workspace): "?tab=project". */
	href: string;
	readonly dirty: boolean;
	readonly saving: boolean;
	readonly saveError: string | null;
	/** What blocks its save, in words. */
	readonly problems: readonly string[];
	revert(): void;
}

/** A problem the bar or a save row lists, as a link to where it is fixed. */
export interface ProblemLink {
	message: string;
	href: string;
}
