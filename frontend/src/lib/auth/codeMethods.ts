// Which way to ask for a two-step code, and what else to offer (issue #282,
// codes by email 206; docs/ui.md § Sign-in pages and § Evidence packs → A
// fresh code). The sign-in page's code step and the fresh-code dialog both
// start from the account's factors, the app first. Pure, so it is unit-tested
// without a DOM; the pages word the choices themselves (the sign-in page is
// translated, the dialog is the workspace's English).
import type { MfaMethod } from '$lib/api/types';

export type CodeMode = MfaMethod | 'recovery';

/** The way the code step starts on: the app when the account has one (the stronger), else the email. */
export function firstMode(methods: readonly MfaMethod[]): MfaMethod {
	return methods.includes('totp') || !methods.includes('email') ? 'totp' : 'email';
}

/**
 * The other ways offered under the code field, in order: the email or the app
 * (only those the account has), then a recovery code; never the one in use.
 * `recoveryFor`: what the recovery link is worded for, the lost phone or the
 * missing email (an account with the app is asked about the phone).
 */
export function otherModes(methods: readonly MfaMethod[], mode: CodeMode): { modes: CodeMode[]; recoveryFor: 'phone' | 'email' } {
	const modes: CodeMode[] = [];
	if (mode !== 'email' && methods.includes('email')) modes.push('email');
	if (mode !== 'totp' && methods.includes('totp')) modes.push('totp');
	if (mode !== 'recovery') modes.push('recovery');
	return { modes, recoveryFor: methods.includes('totp') ? 'phone' : 'email' };
}

/** The send button's state: sending, waiting out the minute (`left` seconds), or ready (first send, or again). */
export type SendState = { kind: 'sending' } | { kind: 'wait'; seconds: number } | { kind: 'ready'; again: boolean };

export function sendState(sending: boolean, left: number, sent: boolean): SendState {
	if (sending) return { kind: 'sending' };
	if (left > 0) return { kind: 'wait', seconds: left };
	return { kind: 'ready', again: sent };
}

/** The fresh-code dialog's English, for the account's factors (layout/FreshCodeDialog.svelte). */
export function freshCodeWords(methods: readonly MfaMethod[]): { title: string; need: string; help: string; emailButton: string | null } {
	const app = methods.includes('totp') || !methods.includes('email');
	const email = methods.includes('email');
	return {
		title: app ? 'Enter a code from your authenticator' : 'Enter a code from your email',
		need: `Signing off, issuing and withdrawing an evidence pack, and removing a team member’s two-step sign-in, need a code from the last 10 minutes${app && email ? ', from your authenticator app or by email' : email ? ', by email' : ' from your authenticator app'}.`,
		help: `${app && email ? 'Six digits from the app or the email' : email ? 'Six digits from the email' : 'Six digits from the app'}, or one of your recovery codes.`,
		emailButton: email ? (app ? 'Email me a code instead' : 'Email me a code') : null
	};
}

/** The dialog's send button's English, from its state. */
export function freshSendLabel(state: SendState, first: string): string {
	return state.kind === 'sending' ? 'Sending…' : state.kind === 'wait' ? `Send again (in ${state.seconds} s)` : state.again ? 'Send again' : first;
}
