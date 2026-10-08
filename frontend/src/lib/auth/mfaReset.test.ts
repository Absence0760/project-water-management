import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { afterResetAskFailed, FEW_RECOVERY_CODES, fewRecoveryCodes, RECOVERY_CODES_FILE, recoveryCodesText, resetAsked } from './mfaReset';

describe('fewRecoveryCodes', () => {
	it('warns at two codes or fewer, only while two-step sign-in is on', () => {
		expect(FEW_RECOVERY_CODES).toBe(2);
		expect(fewRecoveryCodes({ enrolled: true, recoveryCodesLeft: 3 })).toBe(false);
		expect(fewRecoveryCodes({ enrolled: true, recoveryCodesLeft: 2 })).toBe(true);
		expect(fewRecoveryCodes({ enrolled: true, recoveryCodesLeft: 0 })).toBe(true);
		expect(fewRecoveryCodes({ enrolled: false, recoveryCodesLeft: 0 })).toBe(false);
	});
});

describe('recoveryCodesText', () => {
	it('is saved as a plain text file', () => {
		expect(RECOVERY_CODES_FILE).toBe('water-management-recovery-codes.txt');
	});

	it('puts one code a line between the heading and the closing line', () => {
		expect(recoveryCodesText(['AAAAA-BBBBB', 'CCCCC-DDDDD'], 'Codes for a@example.com', 'Each works once.')).toBe(
			'Codes for a@example.com\n\nAAAAA-BBBBB\nCCCCC-DDDDD\n\nEach works once.\n'
		);
	});
});

describe('resetAsked', () => {
	it('tells a link on its way from a reset already waiting', () => {
		expect(resetAsked({ sent: true })).toEqual({ kind: 'sent' });
		expect(resetAsked({ pending: true, effectiveAt: '2026-10-11T12:00:00.000Z' })).toEqual({ kind: 'pending', effectiveAt: '2026-10-11T12:00:00.000Z' });
	});
});

describe('afterResetAskFailed', () => {
	it('goes back to the password when the sign-in challenge ran out, and stays on the panel otherwise', () => {
		expect(afterResetAskFailed(new ApiError(401, 'timed out', undefined, 'mfa_challenge_expired'))).toBe('password');
		expect(afterResetAskFailed(new ApiError(429, 'too many', undefined, 'mfa_reset_limit'))).toBe('stay');
		expect(afterResetAskFailed(new ApiError(500, 'boom'))).toBe('stay');
		expect(afterResetAskFailed(new Error('offline'))).toBe('stay');
	});
});
