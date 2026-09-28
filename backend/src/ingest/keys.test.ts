// API key parsing, hashing and the constant-time comparison (WP-2.9). No database.
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the comparison the module imports, keeping the real implementation.
const calls = vi.hoisted(() => ({ timingSafeEqual: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:crypto')>();
	return {
		...real,
		timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
			calls.timingSafeEqual++;
			return real.timingSafeEqual(a, b);
		}
	};
});

const { bearerKey, CreateKeyBody, hashApiKey, keyAllows, newApiKey, parseApiKey, sameKeyHash } = await import('./keys.js');
const { requireScope } = await import('./auth.js');

const ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';

beforeEach(() => {
	calls.timingSafeEqual = 0;
});

describe('the key format', () => {
	it('makes wm_<first 8 of the id>_<43 base64url>, and stores its SHA-256', () => {
		const { key, prefix, hash } = newApiKey(ID);
		expect(prefix).toBe('3f2a9c1e');
		expect(key).toMatch(/^wm_3f2a9c1e_[A-Za-z0-9_-]{43}$/);
		expect(hash.equals(createHash('sha256').update(key).digest())).toBe(true);
		expect(hash).toHaveLength(32);
		// 32 fresh random bytes each time.
		expect(newApiKey(ID).key).not.toBe(key);
	});

	it('parses its own keys back to the prefix and the same hash', () => {
		const { key, hash } = newApiKey(ID);
		const parsed = parseApiKey(key);
		expect(parsed?.prefix).toBe('3f2a9c1e');
		expect(parsed?.hash.equals(hash)).toBe(true);
	});

	it('rejects anything not exactly our format, before any database work', () => {
		const { key } = newApiKey(ID);
		for (const bad of [
			'',
			'wm_',
			key.slice(0, -1),
			`${key}A`,
			key.replace('wm_', 'wk_'),
			key.replace('wm_', 'WM_'),
			key.replace('3f2a9c1e', '3F2A9C1E'),
			key.replace('3f2a9c1e', '3f2a9c1'),
			key.replace('3f2a9c1e', 'zzzzzzzz'),
			` ${key}`,
			`${key}\n`,
			key.replace(/_([^_]*)$/, '_' + '+'.repeat(43))
		]) {
			expect(parseApiKey(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it('reads the key from a Bearer header only', () => {
		expect(bearerKey('Bearer wm_x')).toBe('wm_x');
		expect(bearerKey('bearer wm_x')).toBe('wm_x');
		expect(bearerKey('BEARER   wm_x')).toBe('wm_x');
		for (const h of [undefined, null, '', 'Bearer', 'Bearer ', 'Basic wm_x', 'wm_x', 'Bearer a b', `Bearer ${'a'.repeat(300)}`]) {
			expect(bearerKey(h), String(h)).toBeNull();
		}
	});
});

describe('comparing hashes in constant time', () => {
	it('matches the same hash and refuses any other, always through timingSafeEqual', () => {
		const a = hashApiKey('wm_3f2a9c1e_' + 'a'.repeat(43));
		const b = hashApiKey('wm_3f2a9c1e_' + 'b'.repeat(43));
		expect(sameKeyHash(a, Buffer.from(a))).toBe(true);
		expect(sameKeyHash(a, b)).toBe(false);
		// Differing only in the last byte, or only in the first: the same path.
		const last = Buffer.from(a);
		last[31] = last[31]! ^ 1;
		const first = Buffer.from(a);
		first[0] = first[0]! ^ 1;
		expect(sameKeyHash(a, last)).toBe(false);
		expect(sameKeyHash(a, first)).toBe(false);
		expect(calls.timingSafeEqual).toBe(4);
	});

	it('refuses a hash of another length without throwing, and still pays a comparison', () => {
		const a = hashApiKey('x');
		expect(sameKeyHash(a, Buffer.alloc(16))).toBe(false);
		expect(sameKeyHash(a, Buffer.alloc(0))).toBe(false);
		expect(calls.timingSafeEqual).toBe(2);
	});
});

describe('the create body', () => {
	it('defaults to any series and no expiry, and drops repeated series', () => {
		expect(CreateKeyBody.parse({ name: '  Gateway  ' })).toEqual({ name: 'Gateway', allowedSeries: null });
		const body = CreateKeyBody.parse({
			name: 'g',
			allowedSeries: [
				{ kind: 'rain_catchment_mm', name: 'Weir' },
				{ kind: 'rain_catchment_mm', name: 'Weir ' },
				{ kind: 'flow_logger_m3s' }
			],
			expiresInDays: 30
		});
		expect(body.allowedSeries).toEqual([
			{ kind: 'rain_catchment_mm', name: 'Weir' },
			{ kind: 'flow_logger_m3s', name: '' }
		]);
		expect(body.expiresInDays).toBe(30);
	});

	it('refuses a name with NUL, an unknown scope and extra fields', () => {
		for (const b of [{ name: 'a\u0000b' }, { name: 'ok', scopes: ['series:read'] }, { name: 'ok', keyHash: 'x' }]) {
			expect(CreateKeyBody.safeParse(b).success, JSON.stringify(b)).toBe(false);
		}
	});
});

describe('what a key may write', () => {
	it('allows any series when unrestricted, else only the listed (kind, name) pairs', () => {
		expect(keyAllows(null, 'rain_catchment_mm', 'x')).toBe(true);
		const list = [{ kind: 'rain_catchment_mm' as const, name: 'Weir' }];
		expect(keyAllows(list, 'rain_catchment_mm', 'Weir')).toBe(true);
		expect(keyAllows(list, 'rain_catchment_mm', 'weir')).toBe(false);
		expect(keyAllows(list, 'flow_logger_m3s', 'Weir')).toBe(false);
	});

	it('answers 403 for a scope the key does not hold (positive control: the one it does)', () => {
		const ctx = (scopes: string[]) => ({ get: () => ({ id: 'k', projectId: 'p', projectName: 'P', name: 'n', scopes, allowedSeries: null }) }) as never;
		expect(requireScope(ctx(['series:write']), 'series:write').id).toBe('k');
		expect(() => requireScope(ctx(['series:write']), 'model:write')).toThrow(expect.objectContaining({ status: 403 }));
		expect(() => requireScope(ctx([]), 'series:write')).toThrow(expect.objectContaining({ status: 403 }));
	});
});
