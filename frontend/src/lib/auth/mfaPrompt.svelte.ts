// The app-wide two-step sign-in prompt (issue #282; docs/security.md §
// Two-step sign-in, docs/ui.md § Invitations, the two-step sign-in banner). A project owner,
// team admin or assessor without an authenticator, or with one but signed in
// with a password only, is told so on every workspace page, not only on the
// Account page or by the 403 of the action they tried. Two sources:
//
// - GET /auth/mfa, read once per signed-in account on the workspace (and fed
//   by the Account page's own read): `required && !enrolled` → set it up;
//   `required && enrolled && !sessionVerified` → sign in again.
// - A `403 mfa_required` / `403 mfa_step_up` from any request (the API
//   client's onError, wired in routes/+layout.svelte): the same two prompts,
//   for whoever met one (an editor publishing to farmers needs it too,
//   without `required`).
//
// The banner itself (layout/MfaBanner.svelte) is its own chunk, loaded only
// when there is something to say. This module holds no words.
import type { MfaStatus } from '$lib/api/types';

export type MfaPromptKind = 'setup' | 'step-up';

type Seen = Pick<MfaStatus, 'required' | 'enrolled' | 'sessionVerified'>;

export interface MfaPromptState {
	/** The account the state is for; anything else is stale. */
	user: string | null;
	status: Seen | null;
	/** A request was refused for want of a second factor, since the last read that resolved it. */
	refused: MfaPromptKind | null;
	/** Dismissed until the next refusal. */
	dismissed: boolean;
}

export const mfaPrompt = $state<MfaPromptState>({ user: null, status: null, refused: null, dismissed: false });

/** Which prompt to show for this state, or none. Pure. */
export function promptKind(p: MfaPromptState, user: string | null): MfaPromptKind | null {
	if (!user || p.user !== user || p.dismissed) return null;
	if (p.refused) return p.refused;
	const s = p.status;
	if (!s?.required) return null;
	if (!s.enrolled) return 'setup';
	if (!s.sessionVerified) return 'step-up';
	return null;
}

/** The prompt a refused request calls for: a 403 with one of the two codes, else null. */
export function refusalKind(err: unknown): MfaPromptKind | null {
	if (!err || typeof err !== 'object') return null;
	const { status, code } = err as { status?: unknown; code?: unknown };
	if (status !== 403) return null;
	if (code === 'mfa_required') return 'setup';
	if (code === 'mfa_step_up') return 'step-up';
	return null;
}

function forUser(user: string) {
	if (mfaPrompt.user === user) return;
	mfaPrompt.user = user;
	mfaPrompt.status = null;
	mfaPrompt.refused = null;
	mfaPrompt.dismissed = false;
}

/** A read of GET /auth/mfa for `user` (the layout's, or the Account page's). Clears a refusal the status now resolves. */
export function mfaStatusSeen(user: string, status: Seen): void {
	forUser(user);
	mfaPrompt.status = { required: status.required, enrolled: status.enrolled, sessionVerified: status.sessionVerified };
	if (mfaPrompt.refused === 'setup' && status.enrolled) mfaPrompt.refused = null;
	if (mfaPrompt.refused === 'step-up' && status.sessionVerified) mfaPrompt.refused = null;
}

/** A request by `user` failed: note it if it was refused for want of a second factor. */
export function noteMfaRefusal(user: string | null, err: unknown): void {
	const kind = refusalKind(err);
	if (!kind || !user) return;
	forUser(user);
	// A step-up after a set-up refusal means they have set one up since: the newer answer wins.
	mfaPrompt.refused = kind;
	mfaPrompt.dismissed = false;
}

/** Signed out: what was known belonged to that session (a refusal, a password-only sign-in). */
export function resetMfaPrompt(): void {
	mfaPrompt.user = null;
	mfaPrompt.status = null;
	mfaPrompt.refused = null;
	mfaPrompt.dismissed = false;
}

export function dismissMfaPrompt(): void {
	mfaPrompt.dismissed = true;
}

let reading: { user: string; at: Promise<void> } | null = null;

/**
 * Read GET /auth/mfa for `user` unless it has been read for them already
 * (`again`: read it anyway). A failure keeps what was known: the prompt is
 * only a nudge (the Account page and the action's own 403 still say it).
 */
export async function loadMfaPrompt(user: string, read: () => Promise<Seen>, again = false): Promise<void> {
	if (!again && mfaPrompt.user === user && mfaPrompt.status) return;
	if (reading?.user === user && !again) return reading.at;
	const at = (async () => {
		try {
			const status = await read();
			mfaStatusSeen(user, status);
		} catch {
			// Keep what was known.
		}
	})();
	reading = { user, at };
	try {
		await at;
	} finally {
		if (reading?.at === at) reading = null;
	}
}
