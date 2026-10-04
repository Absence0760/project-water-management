import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import {
	dismissMfaPrompt,
	loadMfaPrompt,
	mfaPrompt,
	mfaStatusSeen,
	noteMfaRefusal,
	pendingKind,
	promptKind,
	refusalKind,
	resetMfaPrompt,
	type MfaPromptState
} from './mfaPrompt.svelte';

const state = (over: Partial<MfaPromptState> = {}): MfaPromptState => ({ user: 'u1', status: null, refused: null, dismissed: null, ...over });
const status = (required: boolean, enrolled: boolean, sessionVerified: boolean) => ({ required, enrolled, sessionVerified });

describe('promptKind', () => {
	// The operator's decision, 2026-10-03: only a refused action prompts, never the role alone.
	it('a role that needs it is not prompted up front, enrolled or not, until an action is refused', () => {
		expect(promptKind(state({ status: status(true, false, false) }), 'u1')).toBeNull();
		expect(promptKind(state({ status: status(true, true, false) }), 'u1')).toBeNull();
		expect(promptKind(state({ status: status(true, false, false), refused: 'setup' }), 'u1')).toBe('setup');
		expect(promptKind(state({ status: status(true, true, false), refused: 'step-up' }), 'u1')).toBe('step-up');
	});
	it('a role that does not need it: nothing, enrolled or not', () => {
		expect(promptKind(state({ status: status(false, false, false) }), 'u1')).toBeNull();
		expect(promptKind(state({ status: status(false, true, false) }), 'u1')).toBeNull();
	});
	it('a refusal wins over the status (an editor publishing to farmers needs it without `required`)', () => {
		expect(promptKind(state({ status: status(false, false, false), refused: 'setup' }), 'u1')).toBe('setup');
		expect(promptKind(state({ status: status(false, true, false), refused: 'step-up' }), 'u1')).toBe('step-up');
	});
	it('nothing before the status is known, when dismissed, signed out, or for another account', () => {
		expect(promptKind(state(), 'u1')).toBeNull();
		expect(promptKind(state({ refused: 'setup', dismissed: 'setup' }), 'u1')).toBeNull();
		expect(promptKind(state({ refused: 'setup' }), null)).toBeNull();
		expect(promptKind(state({ refused: 'setup' }), 'u2')).toBeNull();
	});
});

describe('pendingKind (the account menu’s badge)', () => {
	it('stays after a refusal, dismissed or not; no badge for the role alone', () => {
		expect(pendingKind(state({ refused: 'setup', dismissed: 'setup' }), 'u1')).toBe('setup');
		expect(pendingKind(state({ refused: 'step-up', dismissed: 'step-up' }), 'u1')).toBe('step-up');
		expect(pendingKind(state({ status: status(true, false, false) }), 'u1')).toBeNull();
	});
	it('goes once it is resolved, and is never another account’s (positive control above)', () => {
		expect(pendingKind(state({ status: status(true, true, true) }), 'u1')).toBeNull();
		expect(pendingKind(state({ status: status(false, false, false) }), 'u1')).toBeNull();
		expect(pendingKind(state({ status: status(true, false, false) }), 'u2')).toBeNull();
		expect(pendingKind(state({ status: status(true, false, false) }), null)).toBeNull();
	});
	it('a dismissed set-up prompt doesn’t hide a step-up one', () => {
		expect(promptKind(state({ refused: 'step-up', dismissed: 'setup' }), 'u1')).toBe('step-up');
	});
});

describe('refusalKind', () => {
	it('maps the two 403 codes', () => {
		expect(refusalKind(new ApiError(403, 'x', undefined, 'mfa_required'))).toBe('setup');
		expect(refusalKind(new ApiError(403, 'x', undefined, 'mfa_step_up'))).toBe('step-up');
	});
	it('ignores any other error', () => {
		expect(refusalKind(new ApiError(403, 'x', undefined, null))).toBeNull();
		expect(refusalKind(new ApiError(400, 'x', undefined, 'mfa_code_wrong'))).toBeNull();
		expect(refusalKind(new ApiError(401, 'x', undefined, 'mfa_step_up'))).toBeNull();
		expect(refusalKind(new Error('x'))).toBeNull();
		expect(refusalKind(null)).toBeNull();
	});
});

describe('the shared state', () => {
	beforeEach(() => {
		Object.assign(mfaPrompt, { user: null, status: null, refused: null, dismissed: null });
	});

	it('a refusal shows the prompt again after a dismissal, and a later status that resolves it clears it', () => {
		mfaStatusSeen('u1', status(false, false, false));
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		dismissMfaPrompt();
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');
		// Set up on the Account page (its read feeds this), in that same session: signed in with a code.
		mfaStatusSeen('u1', status(false, true, true));
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
	});

	it('a step-up refusal stays until a session signed in with a code is seen', () => {
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_step_up'));
		mfaStatusSeen('u1', status(true, true, false));
		expect(promptKind(mfaPrompt, 'u1')).toBe('step-up');
		mfaStatusSeen('u1', status(true, true, true));
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
	});

	it('another account starts clean; unrelated errors and a signed-out refusal change nothing', () => {
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		mfaStatusSeen('u2', status(false, false, false));
		expect(promptKind(mfaPrompt, 'u2')).toBeNull();
		noteMfaRefusal('u2', new ApiError(500, 'x'));
		noteMfaRefusal(null, new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(mfaPrompt.refused).toBeNull();
	});

	it('loadMfaPrompt reads once per account unless asked again, and a failed read keeps what was known', async () => {
		const read = vi.fn(async () => status(true, false, false));
		await Promise.all([loadMfaPrompt('u1', read), loadMfaPrompt('u1', read)]);
		await loadMfaPrompt('u1', read);
		expect(read).toHaveBeenCalledTimes(1);
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		await loadMfaPrompt('u1', async () => {
			throw new Error('offline');
		}, true);
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');
		await loadMfaPrompt('u1', async () => status(true, true, true), true);
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
	});
});

it('signing out forgets the session’s refusal and status, so the next sign-in reads them afresh', async () => {
	resetMfaPrompt();
	noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_step_up'));
	resetMfaPrompt();
	expect(mfaPrompt).toEqual({ user: null, status: null, refused: null, dismissed: null });
	const read = vi.fn(async () => status(true, true, true));
	await loadMfaPrompt('u1', read);
	expect(read).toHaveBeenCalledTimes(1);
	expect(promptKind(mfaPrompt, 'u1')).toBeNull();
});

describe('the dismissal outlasts a reload of the tab', () => {
	const store = new Map<string, string>();
	beforeEach(() => {
		store.clear();
		vi.stubGlobal('sessionStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		});
		resetMfaPrompt();
	});
	afterEach(() => vi.unstubAllGlobals());

	/** A reload: the module's memory is gone, the tab's storage isn't. */
	const reload = () => Object.assign(mfaPrompt, { user: null, status: null, refused: null, dismissed: null });

	it('a dismissed banner stays hidden after a reload, and the badge stays', () => {
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		dismissMfaPrompt();
		reload();
		noteMfaRefusal('u1', null);
		mfaStatusSeen('u1', status(true, false, false));
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
		expect(mfaPrompt.dismissed).toBe('setup');
	});

	it('without a dismissal, a refusal after a reload shows it (positive control)', () => {
		reload();
		mfaStatusSeen('u1', status(true, false, false));
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');
	});

	it('a refusal, signing out, or another account brings it back', () => {
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		dismissMfaPrompt();
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');

		dismissMfaPrompt();
		reload();
		noteMfaRefusal('u2', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u2')).toBe('setup');

		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		dismissMfaPrompt();
		resetMfaPrompt();
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');
	});

	it('storage that throws keeps the dismissal in memory only', () => {
		vi.stubGlobal('sessionStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		});
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		dismissMfaPrompt();
		expect(promptKind(mfaPrompt, 'u1')).toBeNull();
		reload();
		noteMfaRefusal('u1', new ApiError(403, 'x', undefined, 'mfa_required'));
		expect(promptKind(mfaPrompt, 'u1')).toBe('setup');
	});
});
