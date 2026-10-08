import { describe, expect, it } from 'vitest';
import { firstMode, freshCodeWords, freshSendLabel, otherModes, sendState } from './codeMethods';

describe('the sign-in code step’s ways (206)', () => {
	it('starts on the app when the account has it, else the email; an older server’s empty list means the app', () => {
		expect(firstMode(['totp'])).toBe('totp');
		expect(firstMode(['totp', 'email'])).toBe('totp');
		expect(firstMode(['email'])).toBe('email');
		expect(firstMode([])).toBe('totp');
	});

	it('offers only the ways the account has, never the one in use, and the recovery code last', () => {
		expect(otherModes(['totp'], 'totp')).toEqual({ modes: ['recovery'], recoveryFor: 'phone' });
		expect(otherModes(['email'], 'email')).toEqual({ modes: ['recovery'], recoveryFor: 'email' });
		expect(otherModes(['totp', 'email'], 'totp')).toEqual({ modes: ['email', 'recovery'], recoveryFor: 'phone' });
		expect(otherModes(['totp', 'email'], 'email')).toEqual({ modes: ['totp', 'recovery'], recoveryFor: 'phone' });
		expect(otherModes(['totp', 'email'], 'recovery')).toEqual({ modes: ['email', 'totp'], recoveryFor: 'phone' });
		expect(otherModes(['email'], 'recovery')).toEqual({ modes: ['email'], recoveryFor: 'email' });
	});

	it('the send button: sending, then waiting out the seconds, then ready to send again', () => {
		expect(sendState(false, 0, false)).toEqual({ kind: 'ready', again: false });
		expect(sendState(true, 0, false)).toEqual({ kind: 'sending' });
		expect(sendState(false, 42, true)).toEqual({ kind: 'wait', seconds: 42 });
		expect(sendState(false, 0, true)).toEqual({ kind: 'ready', again: true });
	});
});

describe('the fresh-code dialog with codes by email', () => {
	it('words itself for the factors the account has', () => {
		expect(freshCodeWords(['totp'])).toEqual({
			title: 'Enter a code from your authenticator',
			need: 'Signing off, issuing and withdrawing an evidence pack need a code from the last 10 minutes from your authenticator app.',
			help: 'Six digits from the app, or one of your recovery codes.',
			emailButton: null
		});
		expect(freshCodeWords(['totp', 'email'])).toMatchObject({
			title: 'Enter a code from your authenticator',
			need: expect.stringContaining('from your authenticator app or by email'),
			help: 'Six digits from the app or the email, or one of your recovery codes.',
			emailButton: 'Email me a code instead'
		});
		expect(freshCodeWords(['email'])).toMatchObject({ title: 'Enter a code from your email', help: 'Six digits from the email, or one of your recovery codes.', emailButton: 'Email me a code' });
	});

	it('its send button counts down, then offers to send again', () => {
		expect(freshSendLabel(sendState(false, 0, false), 'Email me a code instead')).toBe('Email me a code instead');
		expect(freshSendLabel(sendState(true, 0, false), 'Email me a code')).toBe('Sending…');
		expect(freshSendLabel(sendState(false, 59, true), 'Email me a code')).toBe('Send again (in 59 s)');
		expect(freshSendLabel(sendState(false, 0, true), 'Email me a code')).toBe('Send again');
	});
});
