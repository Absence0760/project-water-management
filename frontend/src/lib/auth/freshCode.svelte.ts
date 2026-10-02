// A code from the authenticator again, inside the session (licensing
// positions item 9; docs/security.md § Two-step sign-in → A fresh code). A
// sign-off, issuing an evidence pack and withdrawing one need a code from the
// last 10 minutes: the API answers 401 `mfa_fresh_code` otherwise, the API
// client calls askForCode (wired in routes/+layout.svelte), the layout opens
// layout/FreshCodeDialog.svelte while `freshCode.open`, and the action is sent
// again once the code is accepted. This module holds no words.

export interface FreshCodeState {
	/** The dialog is asking. */
	open: boolean;
}

export const freshCode = $state<FreshCodeState>({ open: false });

let pending: ((ok: boolean) => void) | null = null;

/** Open the dialog; resolves true once a code was accepted, false when it was cancelled. One question at a time: a second caller waits on the same answer. */
let asking: Promise<boolean> | null = null;
export function askForCode(): Promise<boolean> {
	if (asking) return asking;
	freshCode.open = true;
	asking = new Promise<boolean>((resolve) => {
		pending = resolve;
	});
	return asking;
}

/** The dialog's answer: true after POST /auth/mfa/step-up accepted a code, false on cancel. */
export function answerCode(ok: boolean): void {
	freshCode.open = false;
	const done = pending;
	pending = null;
	asking = null;
	done?.(ok);
}
