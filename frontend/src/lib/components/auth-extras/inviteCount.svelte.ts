// How many invitations wait for the signed-in account (GET /me/invites,
// issue #136), for the banner every page shows while one does
// (InvitesBanner.svelte). Read once per signed-in account, and again when the
// invitations page accepts or declines one or the tab comes back into view.
import { api } from '$lib/api';

export const pendingInvites = $state<{ user: string | null; count: number }>({ user: null, count: 0 });

/**
 * Read the count for `user` unless it has been read for them already (`again`: read it anyway). The
 * count shown stays until the new one arrives, so the banner doesn't blink. A failure keeps the count it
 * had: the banner is only a nudge (the invitations page and the invite email are the ways in, and the
 * page reports its own errors).
 */
export async function loadPendingInvites(user: string, again = false): Promise<void> {
	if (pendingInvites.user === user && !again) return;
	if (pendingInvites.user !== user) pendingInvites.count = 0;
	pendingInvites.user = user;
	try {
		const mine = await api.invites.mine();
		if (pendingInvites.user === user) pendingInvites.count = mine.length;
	} catch {
		// Keep the count it had.
	}
}

/** The invitations page changed the list, or the tab came back into view: read the count again. */
export function invitesChanged(): void {
	if (pendingInvites.user) void loadPendingInvites(pendingInvites.user, true);
}
