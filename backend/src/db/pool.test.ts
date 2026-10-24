// The pool's size (issue #541): the API's and the worker's caps × DB_POOL_MAX
// are what production's database connections are sized on, so a value that
// isn't a pool size must fail at start-up, not open a pool of 0 or NaN.
import { describe, expect, it } from 'vitest';
import { acquireTimeoutMs, DEFAULT_POOL_MAX, poolMax } from './pool.js';

describe('poolMax (DB_POOL_MAX)', () => {
	it('is the local default when unset or blank', () => {
		expect(DEFAULT_POOL_MAX).toBe(5);
		expect(poolMax(undefined)).toBe(5);
		expect(poolMax('')).toBe(5);
		expect(poolMax('  ')).toBe(5);
	});

	it('takes a whole number of at least 1, as Terraform sets it', () => {
		expect(poolMax('2')).toBe(2);
		expect(poolMax(' 2 ')).toBe(2);
		expect(poolMax('1')).toBe(1);
		expect(poolMax('10')).toBe(10);
	});

	it.each(['0', '-1', '1.5', 'two', 'NaN', 'Infinity'])('refuses %j', (v) => {
		expect(() => poolMax(v)).toThrow('DB_POOL_MAX must be a whole number of at least 1');
	});
});

describe('acquireTimeoutMs', () => {
	it('fails a wait for a connection in 10 s in Lambda, and waits as pg does elsewhere', () => {
		expect(acquireTimeoutMs({ AWS_LAMBDA_FUNCTION_NAME: 'water-management-backend' })).toBe(10_000);
		expect(acquireTimeoutMs({})).toBe(0);
	});
});
