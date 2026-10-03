// Client for the email-driven account flows and pending invites (docs/api.md
// § Auth, § Members, § Teams). Kept beside client.ts rather than inside it so
// it can land without touching the shared client; it goes through the same
// `request`, so errors are the usual ApiError.
import { msg, type Msg } from '$lib/i18n/msg';
import type { Api } from './client';
import type { AddMemberResult, Invite, InviteInfo, Member, Role, TeamMember, TeamRole } from './types';

export type { AddMemberResult, Invite, InviteInfo } from './types';

const enc = encodeURIComponent;

export function emailAuthApi(api: Pick<Api, 'request'>) {
	const { request } = api;
	return {
		/** Always resolves (202) for a well-formed address — the server never says whether it has an account. */
		forgotPassword: (email: string) => request<{ ok: true }>('POST', '/auth/forgot-password', { email }),
		/** 204 on success; signs out every session (log in again afterwards). */
		resetPassword: (token: string, password: string) =>
			request<void>('POST', '/auth/reset-password', { token, password }),
		verifyEmail: (token: string) => request<{ verified: true; email: string }>('POST', '/auth/verify-email', { token }),
		/** Signed out, from the sign-in page (issue #57): always 202, whether or not the address has an account waiting to be confirmed. */
		resendConfirmation: (email: string) => request<{ ok: true }>('POST', '/auth/resend-confirmation', { email }),
		/** 202, or ApiError 429 (sent a moment ago) / 409 (already verified). */
		resendVerification: () => request<{ sent: true }>('POST', '/auth/resend-verification'),
		inviteInfo: (token: string) =>
			request<{ invite: InviteInfo }>('POST', '/auth/invite-info', { token }).then((r) => r.invite),

		projectInvites: {
			/** Same endpoint as members.add, typed with the invite branch. */
			add: (projectId: string, email: string, role: Role) =>
				request<AddMemberResult>('POST', `/projects/${enc(projectId)}/members`, { email, role }),
			list: (projectId: string) =>
				request<{ invites: Invite[] }>('GET', `/projects/${enc(projectId)}/invites`).then((r) => r.invites),
			revoke: (projectId: string, inviteId: string) =>
				request<void>('DELETE', `/projects/${enc(projectId)}/invites/${enc(inviteId)}`)
		},
		teamInvites: {
			add: (teamId: string, email: string, role: TeamRole) =>
				request<AddMemberResult>('POST', `/teams/${enc(teamId)}/members`, { email, role }),
			list: (teamId: string) =>
				request<{ invites: Invite[] }>('GET', `/teams/${enc(teamId)}/invites`).then((r) => r.invites),
			revoke: (teamId: string, inviteId: string) =>
				request<void>('DELETE', `/teams/${enc(teamId)}/invites/${enc(inviteId)}`)
		}
	};
}

export type EmailAuthApi = ReturnType<typeof emailAuthApi>;

/**
 * The one-time token from an emailed link (`?token=…`, or `?invite=…` on the
 * sign-up page). Returns null for anything that can't be one of ours, so a
 * mangled link shows a clear message instead of a server round trip.
 */
export function linkToken(url: URL, param: 'token' | 'invite' = 'token'): string | null {
	const t = url.searchParams.get(param)?.trim() ?? '';
	return /^[A-Za-z0-9_-]{43}$/.test(t) ? t : null;
}

/**
 * Password rule shared with the server (8–200 characters). Returns the
 * English message (the translated pages word it with `t`), so this module,
 * which the workspace uses too, never loads the message code.
 */
export function passwordProblem(password: string, confirm: string): Msg | null {
	// i18n-section: password
	if (password.length < 8) return msg('Use at least 8 characters.');
	if (password.length > 200) return msg('Use at most 200 characters.');
	if (password !== confirm) return msg('The two passwords don’t match.');
	return null;
}

/**
 * Display-name rule shared with the server (backend/src/auth/displayName.ts):
 * 1–100 characters once whitespace runs are one space and the controls are
 * dropped, with at least one letter, digit, symbol or punctuation mark, so a
 * name of only invisible characters is refused here rather than as a bare 400.
 */
export function displayNameProblem(name: string): Msg | null {
	// i18n-section: account
	const clean = name.replace(/\s+/g, ' ').replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '').trim();
	if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(clean)) return msg('Enter a display name.');
	if (clean.length > 100) return msg('Use at most 100 characters.');
	return null;
}
