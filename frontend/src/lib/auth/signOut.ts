// Ending the signed-in session on this device: what every sign-out path
// forgets (the farm view's saved copies, the note counts, the assistant's past
// chats, the session),
// then the sign-in page. The account menu's Sign out, Sign out everywhere
// and Sign in again with a code, the two-step banner's Sign in again, the
// farm view's Sign out and Delete my account all end here.
import { tick } from 'svelte';
import { goto } from '$app/navigation';
import { basePath } from '#lib/nav/base.js';
import { api } from '#lib/api/index.js';
import { session } from '#lib/auth/session.svelte.js';
import { clearAllSaved } from '#lib/components/farm/savedCopy.js';
import { clearNoteCounts } from '#lib/components/notes/counts.svelte.js';
import { clearAllChatHistory } from '#lib/components/assistant/historyClear.js';

/** Forget the session here, then go to `to` (a path under the app, default the sign-in page). */
export async function forgetSession(to = '/login', options?: { replace?: boolean }): Promise<void> {
	clearAllSaved();
	clearNoteCounts();
	clearAllChatHistory();
	session.user = null;
	// Let the layout's route guard react first; the navigation below then wins.
	await tick();
	await goto(`${basePath()}${to}`, options);
}

/** Sign out on the server (`end`, this device's logout by default; signed out here whatever it answers), then forgetSession(`to`). */
export async function signOutTo(to = '/login', end: () => Promise<unknown> = () => api.auth.logout()): Promise<void> {
	try {
		await end();
	} catch {
		// Signed out locally whatever the server said.
	}
	await forgetSession(to);
}

/** The sign-in page, back to `next` (a path and query under the app) after. */
export const loginReturningTo = (next: string) => `/login?next=${encodeURIComponent(next)}`;
