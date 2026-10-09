// Recovery codes made harder to lose, and the self-service reset of a lost
// second factor (205_mfa_recovery; docs/ui.md § Account, § Sign-in;
// docs/security.md § Two-step sign-in → Recovery). Pure helpers, so the
// Account page and the sign-in page share them and the tests reach them.
import { ApiError } from '$lib/api/client';
import type { MfaStatus } from '$lib/api/types';

/** The file "Download the codes" saves. */
export const RECOVERY_CODES_FILE = 'water-management-recovery-codes.txt';

/** At or below this many recovery codes left, the Account page suggests a new set. */
export const FEW_RECOVERY_CODES = 2;

/** Whether to warn that the recovery codes are running out (only while two-step sign-in is on). */
export const fewRecoveryCodes = (status: Pick<MfaStatus, 'enrolled' | 'recoveryCodesLeft'>): boolean =>
	status.enrolled && status.recoveryCodesLeft <= FEW_RECOVERY_CODES;

/**
 * The recovery codes as the text file "Download the codes" saves and "Copy"
 * puts on the clipboard: a heading line, one code per line, a closing line.
 * The words come from the caller (translated there).
 */
export function recoveryCodesText(codes: readonly string[], heading: string, footer: string): string {
	return `${heading}\n\n${codes.join('\n')}\n\n${footer}\n`;
}

/** What POST /auth/mfa/reset answered, as the sign-in page shows it. */
export type ResetAsked = { kind: 'sent' } | { kind: 'pending'; effectiveAt: string };

export function resetAsked(r: { sent: true } | { pending: true; effectiveAt: string }): ResetAsked {
	return 'pending' in r ? { kind: 'pending', effectiveAt: r.effectiveAt } : { kind: 'sent' };
}

/**
 * Where the sign-in page goes after asking for a reset failed: the 5-minute
 * challenge ran out (or the password was reset meanwhile), so back to the
 * password step; anything else (the daily cap, a network error) stays on the
 * panel with its message.
 */
export const afterResetAskFailed = (err: unknown): 'password' | 'stay' =>
	err instanceof ApiError && err.code === 'mfa_challenge_expired' ? 'password' : 'stay';
