// What the workspace's save bar (SaveBar.svelte) needs from an unsaved form
// the page holds besides the model: the project details
// (project/detailsDraft.svelte.ts) and the settings
// (settings/settingsDraft.svelte.ts). The page adapts each one to this shape
// (routes/projects/[id]/+page.svelte, `pageDrafts`) and passes the list to the
// bar, which shows them, lists their problems, and discards them with the
// model; the page's saveAll saves them, each before the model. A new form
// that must outlive a tab change is one more entry: its draft, an adapter,
// and a step in saveAll.

export interface PageDraft {
	/** What the bar and its questions call it: "the project details". */
	what: string;
	/** The bar's region name when this is the only unsaved work: "Unsaved project details". */
	region: string;
	readonly dirty: boolean;
	readonly saving: boolean;
	readonly saveError: string | null;
	/** What blocks its save, each a link to where it is fixed. */
	readonly problems: readonly ProblemLink[];
	/** Its save takes the bar's "Reason for this change" (the History tab keeps it): the settings do. */
	readonly takesReason?: boolean;
	/** The bar's Preview can show what it does to the last run (issue #284): the settings can. */
	readonly previewable?: boolean;
	revert(): void;
}

/** A problem the bar or a save row lists, as a link to where it is fixed. */
export interface ProblemLink {
	message: string;
	href: string;
}
