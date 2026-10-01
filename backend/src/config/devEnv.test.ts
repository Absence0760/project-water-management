// The local-dev env loader (config/devEnv.ts): each checkout gets its own dev
// database, and only a local URL naming the default `water` is redirected.
import { describe, expect, it } from 'vitest';
import { testDbName } from '../__tests__/test-db.js';
import { checkoutDevDbName, devDbName, loadDevEnv, withDevDb } from './devEnv.js';

const APP = 'postgresql://water_app:water_app@127.0.0.1:5434/water';
const OWNER = 'postgresql://water:water@127.0.0.1:5434/water';

describe('devDbName', () => {
	it('keeps `water` for the main checkout', () => {
		expect(devDbName('/home/x/project-water-management', false)).toBe('water');
	});

	it('gives a worktree water_w<n>, the same n as its test database', () => {
		for (const path of ['/home/x/wm-a', '/home/x/wm-b', '/tmp/wm-some-long-branch-name']) {
			const name = devDbName(path, true);
			expect(name).toMatch(/^water_w([1-9]|[1-9][0-9])$/);
			expect(testDbName(path, true)).toBe(name.replace('water_w', 'water_test_w'));
		}
	});

	it('is stable for a path and differs between paths', () => {
		expect(devDbName('/home/x/wm-a', true)).toBe(devDbName('/home/x/wm-a', true));
		const names = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => devDbName(`/home/x/wm-${s}`, true)));
		expect(names.size).toBeGreaterThan(1);
	});
});

describe('withDevDb', () => {
	it('points a local URL naming `water` at the given database', () => {
		expect(withDevDb(APP, 'water_w7')).toBe('postgresql://water_app:water_app@127.0.0.1:5434/water_w7');
		expect(withDevDb('postgresql://water:water@localhost:5434/water?sslmode=disable', 'water_w7')).toBe(
			'postgresql://water:water@localhost:5434/water_w7?sslmode=disable'
		);
	});

	it('leaves any other database, a remote host and a non-URL alone', () => {
		for (const url of [
			'postgresql://water_app:water_app@127.0.0.1:5434/water_e2e',
			'postgresql://water_app:water_app@127.0.0.1:5434/water_test_w3',
			'postgresql://water_app:water_app@127.0.0.1:5434/mine',
			'postgresql://water_app:pw@db.example.org:5432/water',
			'not a url'
		]) {
			expect(withDevDb(url, 'water_w7')).toBe(url);
		}
	});
});

describe('checkoutDevDbName', () => {
	it('takes DEV_DB_NAME over the checkout', () => {
		expect(checkoutDevDbName({ DEV_DB_NAME: 'water' })).toBe('water');
		expect(checkoutDevDbName({ DEV_DB_NAME: ' water_mine ' })).toBe('water_mine');
	});

	it('refuses a DEV_DB_NAME that is not a plain database name', () => {
		for (const bad of ['Water', 'water"; DROP DATABASE water; --', 'water-1', '1water', 'x'.repeat(64)]) {
			expect(() => checkoutDevDbName({ DEV_DB_NAME: bad })).toThrow(/DEV_DB_NAME/);
		}
	});

	it('without DEV_DB_NAME, names this checkout by where it is', () => {
		expect(checkoutDevDbName({})).toMatch(/^water(_w\d+)?$/);
	});
});

describe('loadDevEnv', () => {
	it('loads the committed env file and points both URLs at the checkout database', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42' };
		loadDevEnv(env);
		expect(env.DATABASE_URL).toBe(APP.replace(/water$/, 'water_w42'));
		expect(env.MIGRATION_DATABASE_URL).toBe(OWNER.replace(/water$/, 'water_w42'));
	});

	it('keeps a URL already set to another database', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42', DATABASE_URL: 'postgresql://water_app:water_app@127.0.0.1:5434/water_e2e' };
		loadDevEnv(env);
		expect(env.DATABASE_URL).toBe('postgresql://water_app:water_app@127.0.0.1:5434/water_e2e');
	});
});
