// Unsaved work and the leave guard's question (issue #162 items 11 and 13).
// The guard itself is leaveGuard.ts. One question, in the app's
// own dialog, before a navigation drops unsaved work. Each piece of unsaved
// work registers itself here while its component is mounted (guardUnsaved):
// the workspace's model edits and project details, override mode's edits, a
// half-filled scenario change or rename, and the New scenario dialog. The root
// layout installs the one `beforeNavigate` that asks (installLeaveGuard), so
// several pieces of unsaved work give one question naming them all and where
// the navigation goes ("Leave and go to All projects?").
//
// Closing the tab or reloading can't show an app dialog: the browser asks its
// own "Leave site?" there, and that is the only place it does.
import { onMount } from 'svelte';

export interface UnsavedWork {
	/** Whether there is unsaved work now. */
	dirty: () => boolean;
	/** What is unsaved, as the question lists it: "model edits", "project details". */
	what: string | (() => string);
	/**
	 * Whether a navigation from `from` to `to` drops the work. The default:
	 * any change of page (path); a tab change within the workspace keeps the
	 * page's own state, so only its parts that live in one tab say more.
	 */
	leaves?: (from: URL, to: URL) => boolean;
}

const registered = new Set<UnsavedWork>();

/** Register unsaved work; the function returned unregisters it. */
export function registerUnsaved(work: UnsavedWork): () => void {
	registered.add(work);
	return () => {
		registered.delete(work);
	};
}

/** Register unsaved work for as long as the calling component is mounted. Call during component init. */
export function guardUnsaved(work: UnsavedWork): void {
	onMount(() => registerUnsaved(work));
}

export const pathChanges = (from: URL, to: URL) => from.pathname !== to.pathname;

/** The registered work a navigation from `from` to `to` would drop (`to` null: the page is unloading). */
export function unsavedDroppedBy(from: URL, to: URL | null, works: Iterable<UnsavedWork> = registered): UnsavedWork[] {
	return [...works].filter((w) => w.dirty() && (!to || (w.leaves ?? pathChanges)(from, to)));
}

/** Any unsaved work at all (the chunk-failure message, the reload prompt). */
export function anyUnsaved(): boolean {
	return [...registered].some((w) => w.dirty());
}

export const whatOf = (w: UnsavedWork) => (typeof w.what === 'function' ? w.what() : w.what);

/** "a, b and c". */
export function listAnd(items: string[]): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The question's words. `destination` null: somewhere outside the app. */
export function leaveQuestion(whats: string[], destination: string | null): { title: string; message: string } {
	const unique = [...new Set(whats)];
	const where = destination ? `Leave and go to ${destination}?` : 'Leave this page?';
	return {
		title: 'Leave without saving?',
		message: `You have unsaved changes${unique.length ? ` (${listAnd(unique)})` : ''}. ${where} They will be lost.`
	};
}
