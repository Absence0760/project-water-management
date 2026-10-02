// Ending the signed-in session on this device: what every sign-out path
// forgets (the farm view's saved copies, the note counts, the session),
// then the sign-in page. The account menu's Sign out, Sign out everywhere
// and Sign in again with a code, the two-step banner's Sign in again, the
// farm view's Sign out and Delete my account all end here.
import { tick } from 'svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';
import { api } from '$lib/api';
import { session } from '$lib/auth/session.svelte';
import { clearAllSaved } from '$lib/components/farm/savedCopy';
import { clearNoteCounts } from '$lib/components/notes/counts.svelte';

/** Forget the session here, then go to `to` (a path under the app, default the sign-in page). */
export async function forgetSession(to = '/login', options?: { replaceState?: boolean }): Promise<void> {
	clearAllSaved();
	clearNoteCounts();
	session.user = null;
	// Let the layout's route guard react first; the navigation below then wins.
	await tick();
	await goto(`${base}${to}`, options);
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
