import { describe, expect, it } from 'vitest';
import { signupOpen } from './signupOpen.js';

const LAMBDA = { AWS_LAMBDA_FUNCTION_NAME: 'water-management-backend' };

describe('signupOpen', () => {
	it('is open locally when unset, and closed on Lambda when unset', () => {
		expect(signupOpen({})).toBe(true);
		expect(signupOpen({ SIGNUP_OPEN: '' })).toBe(true);
		expect(signupOpen({ ...LAMBDA })).toBe(false);
		expect(signupOpen({ ...LAMBDA, SIGNUP_OPEN: '' })).toBe(false);
	});

	it('follows an explicit setting anywhere', () => {
		expect(signupOpen({ SIGNUP_OPEN: 'false' })).toBe(false);
		expect(signupOpen({ ...LAMBDA, SIGNUP_OPEN: 'true' })).toBe(true);
		expect(signupOpen({ ...LAMBDA, SIGNUP_OPEN: 'false' })).toBe(false);
	});

	it('refuses anything else', () => {
		expect(() => signupOpen({ SIGNUP_OPEN: 'yes' })).toThrow(/true or false/);
		expect(() => signupOpen({ ...LAMBDA, SIGNUP_OPEN: '1' })).toThrow(/true or false/);
	});
});
