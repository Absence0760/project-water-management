// What a page says when a code-split chunk fails to download
// (ChunkFailed.svelte), and how a page tells it there are unsaved changes.
// Only a reload recovers from a failed chunk (see lazy.ts), and a reload goes
// through the page's beforeunload guard, so unsaved work is never dropped
// silently; the message just warns the user first.
import { getContext, setContext } from 'svelte';

const UNSAVED = Symbol('unsaved-changes');
type Check = () => boolean;

/**
 * Tell the chunk-failure messages below this component whether it has
 * unsaved changes. Call during component init. Nested providers combine: the
 * workspace's model editor and a scenario's override editor both count.
 */
export function provideUnsaved(check: Check): void {
	setContext<Check>(UNSAVED, withParent(check, getContext<Check | undefined>(UNSAVED)));
}

/** A provider's check combined with the one above it: either unsaved counts. */
export function withParent(check: Check, parent: Check | undefined): Check {
	return parent ? () => check() || parent() : check;
}

/** The nearest provider's check, or one that is always false. Call during component init. */
export function unsavedCheck(): Check {
	return getContext<Check | undefined>(UNSAVED) ?? (() => false);
}

/** The failure message; `what` names the part that failed, e.g. "The import". */
export function chunkFailedText(what: string, unsaved: boolean): string {
	const failed = `${what} could not be loaded. Check your connection, then reload the page.`;
	return unsaved
		? `${failed} You have unsaved changes: save them first, or the browser will ask before the reload discards them.`
		: failed;
}
