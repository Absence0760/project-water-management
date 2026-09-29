// The workspace's section header (issue #17, option A): one header per
// section, drawn by the page (routes/projects/[id]) above the open tab. A tab
// that has its own context line or actions (the Network's summary, Grids and
// Add node; the Crops summary and Add crop; the Summary's run line) puts
// them here while it shows its page (the Summary also puts its "Setup complete" pill beside the
// rain pill, as `status`), instead of drawing a header of its own,
// and the page renders them in SectionHeader. The same pattern as the
// sidebar's page slot (layout/sidebar.svelte.ts). A tab shown inside a
// modal or in scenario override mode doesn't fill it.
import type { Snippet } from 'svelte';

export interface HeaderParts {
	/** Replaces the page's one-line context under the title. */
	context?: Snippet;
	/** Beside the page's rain pill, before it (the Summary's "Setup complete" pill). */
	status?: Snippet;
	/** The section's own actions, placed before Add data and Run model. */
	actions?: Snippet;
	/**
	 * The section's main action where the page's Run model would be: last, after Add data.
	 * Runs & results puts its run form (label, Run forecast, Run model) here.
	 */
	main?: Snippet;
}

export const headerSlot = $state<{ context: Snippet | null; status: Snippet | null; actions: Snippet | null; main: Snippet | null }>({
	context: null,
	status: null,
	actions: null,
	main: null
});

/** Puts `parts` in the header while `on`; call from an $effect so they clear when the tab goes. */
export function fillHeader(parts: HeaderParts, on = true): (() => void) | void {
	if (!on) return;
	const context = parts.context ?? null;
	const status = parts.status ?? null;
	const actions = parts.actions ?? null;
	const main = parts.main ?? null;
	headerSlot.context = context;
	headerSlot.status = status;
	headerSlot.actions = actions;
	headerSlot.main = main;
	return () => {
		// Only clear what is still ours: the next tab may already have filled it.
		if (headerSlot.context === context) headerSlot.context = null;
		if (headerSlot.status === status) headerSlot.status = null;
		if (headerSlot.actions === actions) headerSlot.actions = null;
		if (headerSlot.main === main) headerSlot.main = null;
	};
}
