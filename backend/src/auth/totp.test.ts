// TOTP (RFC 6238) and its HOTP core (RFC 4226), checked against the RFCs' own
// test vectors, plus the window, replay and recovery-code rules mfa.ts relies
// on (issue #282, docs/security.md § Two-step sign-in).
import { describe, expect, it } from 'vitest';
import {
	base32Decode,
	base32Encode,
	hashRecoveryCode,
	hotp,
	newRecoveryCode,
	newTotpSecret,
	normaliseRecoveryCode,
	normaliseTotp,
	otpauthUri,
	RECOVERY_CODE_COUNT,
	totp,
	totpStep,
	verifyTotp
} from './totp.js';

const ascii = (s: string) => Buffer.from(s, 'ascii');

describe('HOTP, RFC 4226 Appendix D', () => {
	const secret = ascii('12345678901234567890');
	const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
	it.each(expected.map((code, counter) => [counter, code] as const))('counter %i → %s', (counter, code) => {
		expect(hotp(secret, counter)).toBe(code);
	});
	it('refuses a negative or fractional counter', () => {
		expect(() => hotp(secret, -1)).toThrow(RangeError);
		expect(() => hotp(secret, 1.5)).toThrow(RangeError);
	});
});

describe('TOTP, RFC 6238 Appendix B (8 digits, T0 = 0, X = 30)', () => {
	// The seeds are the ASCII string "1234567890" repeated to each hash's key length.
	const seeds = {
		sha1: ascii('12345678901234567890'),
		sha256: ascii('12345678901234567890123456789012'),
		sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234')
	} as const;
	const vectors: [number, string, keyof typeof seeds][] = [
		[59, '94287082', 'sha1'],
		[59, '46119246', 'sha256'],
		[59, '90693936', 'sha512'],
		[1111111109, '07081804', 'sha1'],
		[1111111109, '68084774', 'sha256'],
		[1111111109, '25091201', 'sha512'],
		[1111111111, '14050471', 'sha1'],
		[1111111111, '67062674', 'sha256'],
		[1111111111, '99943326', 'sha512'],
		[1234567890, '89005924', 'sha1'],
		[1234567890, '91819424', 'sha256'],
		[1234567890, '93441116', 'sha512'],
		[2000000000, '69279037', 'sha1'],
		[2000000000, '90698825', 'sha256'],
		[2000000000, '38618901', 'sha512'],
		[20000000000, '65353130', 'sha1'],
		[20000000000, '77737706', 'sha256'],
		[20000000000, '47863826', 'sha512']
	];
	it.each(vectors)('T = %i s → %s (%s)', (seconds, code, alg) => {
		expect(totp(seeds[alg], seconds * 1000, 8, alg)).toBe(code);
	});
	it('steps every 30 seconds from the epoch', () => {
		expect(totpStep(59_000)).toBe(1);
		expect(totpStep(1111111109_000)).toBe(0x23523ec);
		expect(totpStep(20000000000_000)).toBe(0x27bc86aa);
	});
	it('the app uses 6 digits: the RFC code’s last six', () => {
		expect(totp(seeds.sha1, 59_000)).toBe('287082');
	});
});

describe('base32 (RFC 4648 § 10, unpadded)', () => {
	it.each([
		['', ''],
		['f', 'MY'],
		['fo', 'MZXQ'],
		['foo', 'MZXW6'],
		['foob', 'MZXW6YQ'],
		['fooba', 'MZXW6YTB'],
		['foobar', 'MZXW6YTBOI']
	])('%j ↔ %s', (plain, encoded) => {
		expect(base32Encode(ascii(plain))).toBe(encoded);
		expect(base32Decode(encoded)!.toString('ascii')).toBe(plain);
	});
	it('forgives case, spaces, dashes and padding; refuses other characters', () => {
		expect(base32Decode('mzxw 6ytb-oi======')!.toString('ascii')).toBe('foobar');
		expect(base32Decode('MZXW1')).toBeNull();
	});
	it('round-trips a new 20-byte secret', () => {
		const s = newTotpSecret();
		expect(s).toHaveLength(20);
		expect(base32Decode(base32Encode(s))).toEqual(s);
	});
});

describe('verifyTotp', () => {
	const secret = ascii('12345678901234567890');
	const now = 1_700_000_000_000;
	const step = totpStep(now);
	const at = (s: number) => hotp(secret, s);

	it('accepts the current step and one either side (a phone clock a little off), and says which', () => {
		expect(verifyTotp(secret, at(step), now, null)).toBe(step);
		expect(verifyTotp(secret, at(step - 1), now, null)).toBe(step - 1);
		expect(verifyTotp(secret, at(step + 1), now, null)).toBe(step + 1);
	});
	it('refuses two steps away', () => {
		expect(verifyTotp(secret, at(step - 2), now, null)).toBeNull();
		expect(verifyTotp(secret, at(step + 2), now, null)).toBeNull();
	});
	it('refuses a step at or before the last one used (no replay), and accepts a later one', () => {
		expect(verifyTotp(secret, at(step), now, step)).toBeNull();
		expect(verifyTotp(secret, at(step - 1), now, step)).toBeNull();
		expect(verifyTotp(secret, at(step + 1), now, step)).toBe(step + 1);
		expect(verifyTotp(secret, at(step), now, step - 1)).toBe(step);
	});
	it('forgives spaces, refuses anything not six digits', () => {
		const c = at(step);
		expect(verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, now, null)).toBe(step);
		expect(verifyTotp(secret, `${c}0`, now, null)).toBeNull();
		expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
		expect(normaliseTotp(' 12 34 56 ')).toBe('123456');
		expect(normaliseTotp('12345')).toBeNull();
	});
	it('refuses a code made from another secret', () => {
		expect(verifyTotp(ascii('another-secret-00000'), at(step), now, null)).toBeNull();
	});
});

describe('otpauthUri', () => {
	it('names the issuer and the account, and carries the base32 secret and the parameters every app reads', () => {
		const uri = otpauthUri(ascii('12345678901234567890'), 'farmer+1@example.com');
		const u = new URL(uri);
		expect(u.protocol).toBe('otpauth:');
		expect(uri.startsWith('otpauth://totp/Water%20Management:farmer%2B1%40example.com?')).toBe(true);
		expect(u.host).toBe('totp');
		expect(decodeURIComponent(u.pathname)).toBe('/Water Management:farmer+1@example.com');
		expect(Object.fromEntries(u.searchParams)).toEqual({
			secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
			issuer: 'Water Management',
			algorithm: 'SHA1',
			digits: '6',
			period: '30'
		});
		// A space is %20, never '+', which some apps show as a plus.
		expect(uri).not.toContain('+');
	});
});

describe('recovery codes', () => {
	it('are ten characters from an alphabet without look-alikes, in two groups', () => {
		const codes = Array.from({ length: 200 }, newRecoveryCode);
		for (const c of codes) expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{5}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{5}$/);
		expect(new Set(codes).size).toBe(codes.length);
		expect(RECOVERY_CODE_COUNT).toBe(10);
	});
	it('normalise case and separators, and refuse what can’t be one', () => {
		expect(normaliseRecoveryCode('abcde-fgh23')).toBe('ABCDEFGH23');
		expect(normaliseRecoveryCode(' ABCDE FGH23 ')).toBe('ABCDEFGH23');
		expect(normaliseRecoveryCode('ABCDE-FGH2')).toBeNull();
		expect(normaliseRecoveryCode('ABCDE-FGH20')).toBeNull(); // 0 isn't in the alphabet
		expect(normaliseRecoveryCode('123456')).toBeNull();
	});
	it('hash to 32 bytes, the same for every spelling of one code', () => {
		const h = hashRecoveryCode(normaliseRecoveryCode('abcde-fgh23')!);
		expect(h).toHaveLength(32);
		expect(hashRecoveryCode(normaliseRecoveryCode('ABCDEFGH23')!)).toEqual(h);
	});
});
