// The path rule itself (http/rawPath.ts); the app-level and runtime tests are
// in rawPath.security.test.ts.
import { describe, expect, it } from 'vitest';
import { pathRefusal, rawPathOf } from './rawPath.js';

describe('pathRefusal', () => {
	it('refuses an escaped unreserved character: letters, digits, - . _ ~, in either case', () => {
		for (const p of ['/%61uth/login', '/%41uth', '/auth/log%69n', '/projects/%31', '/a%2Db', '/a%2eb', '/%2e%2e/auth', '/a%5Fb', '/a%7eb']) {
			expect(pathRefusal(p), p).not.toBeNull();
		}
	});

	it('refuses an escaped slash, backslash or percent (double encoding), and control characters', () => {
		for (const p of ['/projects%2Fx', '/a%2fb', '/a%5Cb', '/a%255C', '/a%2561uth', '/a%00', '/a%0A', '/a%1f', '/a%7F']) {
			expect(pathRefusal(p), p).not.toBeNull();
		}
	});

	it('refuses a malformed escape', () => {
		for (const p of ['/a%', '/a%4', '/a%zz', '/a%G1']) expect(pathRefusal(p), p).not.toBeNull();
	});

	it('refuses a raw dot segment or backslash', () => {
		for (const p of ['/x/../auth/login', '/./health', '/x/..', '/a\\b']) expect(pathRefusal(p), p).not.toBeNull();
	});

	it('lets through plain paths and the escapes a name needs: spaces, non-ASCII, other reserved characters (positive control)', () => {
		for (const p of [
			'/',
			'/health',
			'/projects/0b8c6f8e-5a4e-4b8f-9c1d-2f3a4b5c6d7e/runs',
			'/projects/a%20b',
			'/projects/caf%C3%A9',
			'/projects/%E6%B0%B4',
			'/projects/x%3Ay',
			'/projects/a%40b%2Bc%26d',
			'/projects/a.b/file.csv',
			'/projects/..hidden',
			'/projects/export.json'
		]) {
			expect(pathRefusal(p), p).toBeNull();
		}
	});
});

describe('rawPathOf', () => {
	it('takes the path of a request target or absolute URL without decoding it', () => {
		expect(rawPathOf('/a/%61?x=%2F#f')).toBe('/a/%61');
		expect(rawPathOf('https://h:3001/x/%2e%2e/y?q')).toBe('/x/%2e%2e/y');
		expect(rawPathOf('https://h')).toBe('/');
		expect(rawPathOf('/a/b')).toBe('/a/b');
	});
});
