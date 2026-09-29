// The leave guard (issue #162 items 11 and 13): the one `beforeNavigate` that
// asks, in the app's own dialog (confirm.svelte.ts), before a navigation drops
// the unsaved work registered in unsaved.ts, naming where it goes. On Stay the
// navigation is cancelled; on Leave it is made again, let through once.
// Reload and tab close get the browser's own prompt (no page can restyle it).
import { onMount } from 'svelte';
import { beforeNavigate, goto } from '$app/navigation';
import { base } from '$app/paths';
import { page } from '$app/state';
import { confirmDialog } from '$lib/components/common/confirm.svelte';
import { destinationName } from './destination';
import { anyUnsaved, leaveQuestion, unsavedDroppedBy, whatOf } from './unsaved';

// A navigation the person already agreed to: let it through once.
let agreedHref: string | null = null;
let asking = false;

/** Install the guard. Call once, during the root layout's init. */
export function installLeaveGuard(): void {
	// Reload, tab close or an external link: the page unloads, and only the browser's own
	// prompt can show. A plain listener, not SvelteKit's 'leave' navigation, which it skips
	// for an external link it has already let through.
	onMount(() => {
		const onUnload = (e: BeforeUnloadEvent) => {
			if (anyUnsaved()) e.preventDefault();
		};
		addEventListener('beforeunload', onUnload);
		return () => removeEventListener('beforeunload', onUnload);
	});
	beforeNavigate((nav) => {
		const to = nav.to?.url ?? null;
		if (nav.willUnload) return;
		if (to && agreedHref === to.href) {
			agreedHref = null;
			return;
		}
		agreedHref = null;
		const dropped = unsavedDroppedBy(page.url, to);
		if (!dropped.length) return;
		nav.cancel();
		if (asking) return;
		asking = true;
		const q = leaveQuestion(dropped.map(whatOf), to ? destinationName(page.url, to, base) : null);
		void confirmDialog({ ...q, confirmLabel: 'Leave without saving', cancelLabel: 'Stay', danger: true }).then((ok) => {
			asking = false;
			if (!ok || !to) return;
			agreedHref = to.href;
			// Back or Forward: the cancelled step was undone, so take it again.
			if (nav.type === 'popstate' && nav.delta) history.go(nav.delta);
			else void goto(to);
		});
	});
}
