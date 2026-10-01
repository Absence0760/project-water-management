// The switch for the second-factor requirement (auth/stepUp.ts): on unless
// explicitly off, and never off on Lambda. The requirement itself is in
// stepUp.db.test.ts.
import { describe, expect, it } from 'vitest';
import { mfaRequired } from './stepUp.js';

describe('mfaRequired', () => {
	it('is on when unset, empty or true', () => {
		expect(mfaRequired({})).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: '' })).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: 'true' })).toBe(true);
		expect(mfaRequired({ MFA_REQUIRED: 'true', AWS_LAMBDA_FUNCTION_NAME: 'api' })).toBe(true);
	});
	it('is off only when set to false off Lambda', () => {
		expect(mfaRequired({ MFA_REQUIRED: 'false' })).toBe(false);
		expect(() => mfaRequired({ MFA_REQUIRED: 'false', AWS_LAMBDA_FUNCTION_NAME: 'api' })).toThrow(/Lambda always requires/);
	});
	it('refuses anything else rather than guess', () => {
		for (const v of ['0', 'off', 'no', 'FALSE']) expect(() => mfaRequired({ MFA_REQUIRED: v }), v).toThrow(/true or false/);
	});
});
