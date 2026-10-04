// The app-wide two-step sign-in prompt (issue #282; docs/security.md §
// Two-step sign-in, docs/ui.md § Invitations, the two-step sign-in banner).
// It shows only once an action was refused for want of a second factor (a
// `403 mfa_required` / `403 mfa_step_up` from any request, the API client's
// onError, wired in routes/+layout.svelte): set it up, or sign in again with
// a code. A role that needs it (owner, team admin, assessor) is not told so
// up front any more (the operator's decision, 2026-10-03): a project that
// never does a protected action is never prompted, and one that does meets
// the prompt at that action, which the API still refuses. GET /auth/mfa
// (read by the layout and the Account page) only clears a refusal the status
// now resolves.
//
// The banner itself (layout/MfaBanner.svelte) is its own chunk, loaded only
// when there is something to say. Dismissing it lasts until the next refusal
// or until this tab closes (sessionStorage, so a reload doesn't bring it
// back); while the need stands the account menu keeps a badge
// (layout/AccountMenu.svelte, `pendingKind`), so it is never out of sight.
// This module holds no words.
import type { MfaStatus } from '$lib/api/types';

export type MfaPromptKind = 'setup' | 'step-up';

type Seen = Pick<MfaStatus, 'required' | 'enrolled' | 'sessionVerified'>;

export interface MfaPromptState {
	/** The account the state is for; anything else is stale. */
	user: string | null;
	status: Seen | null;
	/** A request was refused for want of a second factor, since the last read that resolved it. */
	refused: MfaPromptKind | null;
	/** The prompt dismissed (until the next refusal, or the tab closes), if any: a different prompt still shows. */
	dismissed: MfaPromptKind | null;
}

export const mfaPrompt = $state<MfaPromptState>({ user: null, status: null, refused: null, dismissed: null });

/** What the person still needs to do (dismissed or not), or nothing: the account menu's badge. Pure. */
export function pendingKind(p: MfaPromptState, user: string | null): MfaPromptKind | null {
	if (!user || p.user !== user) return null;
	return p.refused;
}

/** Which banner to show for this state, or none: the pending prompt unless it was dismissed. Pure. */
export function promptKind(p: MfaPromptState, user: string | null): MfaPromptKind | null {
	const kind = pendingKind(p, user);
	return kind && p.dismissed !== kind ? kind : null;
}

// The dismissal, kept for this tab (a reload reads it back). Storage can be
// missing or throw (a private window, blocked site data): then it lasts until
// the reload, as before.
const DISMISSED_KEY = 'wm.mfa-prompt-dismissed';

function storedDismissal(user: string): MfaPromptKind | null {
	try {
		const saved = JSON.parse(globalThis.sessionStorage?.getItem(DISMISSED_KEY) ?? 'null') as { user?: unknown; kind?: unknown } | null;
		return saved?.user === user && (saved.kind === 'setup' || saved.kind === 'step-up') ? saved.kind : null;
	} catch {
		return null;
	}
}

function storeDismissal(value: { user: string; kind: MfaPromptKind } | null): void {
	try {
		if (value) globalThis.sessionStorage?.setItem(DISMISSED_KEY, JSON.stringify(value));
		else globalThis.sessionStorage?.removeItem(DISMISSED_KEY);
	} catch {
		// Kept in memory only.
	}
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
	mfaPrompt.dismissed = storedDismissal(user);
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
	mfaPrompt.dismissed = null;
	storeDismissal(null);
}

/** Signed out: what was known belonged to that session (a refusal, a password-only sign-in). */
export function resetMfaPrompt(): void {
	mfaPrompt.user = null;
	mfaPrompt.status = null;
	mfaPrompt.refused = null;
	mfaPrompt.dismissed = null;
	storeDismissal(null);
}

/** Hide the banner showing now, until the next refusal or the tab closes; the account menu's badge stays. */
export function dismissMfaPrompt(): void {
	const user = mfaPrompt.user;
	const kind = promptKind(mfaPrompt, user);
	if (!user || !kind) return;
	mfaPrompt.dismissed = kind;
	storeDismissal({ user, kind });
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
	const mine = { user, at };
	reading = mine;
	try {
		await at;
	} finally {
		if (reading === mine) reading = null;
	}
}
