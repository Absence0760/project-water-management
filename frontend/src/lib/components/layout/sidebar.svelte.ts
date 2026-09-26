// The app sidebar's page slot (AppShell): a page fills it with its own
// navigation while it is shown on a wide screen (the workspace: the catchment
// and its sections), and clears it on leave. Help doesn't: a long contents list
// made the sidebar scroll, so Help keeps them in the page.
// One instance of that navigation ever exists: on a phone the page renders it
// in the page instead, and doesn't fill the slot.
import type { Snippet } from 'svelte';

export const sidebarSlot = $state<{ content: Snippet | null }>({ content: null });

/** Puts `content` in the slot while `on`; call from an $effect so it clears when the page goes. */
export function fillSidebar(content: Snippet, on: boolean): (() => void) | void {
	if (!on) return;
	sidebarSlot.content = content;
	return () => {
		if (sidebarSlot.content === content) sidebarSlot.content = null;
	};
}
