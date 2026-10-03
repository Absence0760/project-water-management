// The local-dev env loader (config/devEnv.ts): each checkout gets its own dev
// database, and only a local URL naming the default `water` is redirected.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testDbName } from '../__tests__/test-db.js';
import { checkoutDevDbName, devDbName, loadDevEnv, withDevDb } from './devEnv.js';

const APP = 'postgresql://water_app:water_app@127.0.0.1:5434/water';
const OWNER = 'postgresql://water:water@127.0.0.1:5434/water';

describe('devDbName', () => {
	it('keeps `water` for the main checkout', () => {
		expect(devDbName('/home/x/project-water-management', false)).toBe('water');
	});

	it('gives a worktree water_w<16 hex>, the same tag as its test database', () => {
		for (const path of ['/home/x/wm-a', '/home/x/wm-b', '/tmp/wm-some-long-branch-name']) {
			const name = devDbName(path, true);
			expect(name).toMatch(/^water_w[0-9a-f]{16}$/);
			expect(testDbName(path, true)).toBe(name.replace('water_w', 'water_test_w'));
		}
	});

	it('is stable for a path and distinct between paths', () => {
		expect(devDbName('/home/x/wm-a', true)).toBe(devDbName('/home/x/wm-a', true));
		const names = Array.from({ length: 2000 }, (_, i) => devDbName(`/home/x/wm-${i}`, true));
		expect(new Set(names).size).toBe(names.length);
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
		expect(checkoutDevDbName({})).toMatch(/^water(_w[0-9a-f]{16})?$/);
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

describe('the dev CLI scripts', () => {
	// The reference-data importers (pnpm import:*) loaded dotenv themselves, so in a worktree they wrote to the
	// main checkout's `water` and left the worktree's own database empty: its Map proposed nothing.
	it('read the database URLs only through loadDevEnv, never dotenv directly', () => {
		const dir = new URL('../../scripts/', import.meta.url);
		const scripts = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
		const readsDb = scripts.filter((f) => /process\.env\.(MIGRATION_)?DATABASE_URL/.test(readFileSync(new URL(f, dir), 'utf8')));
		expect(readsDb).toContain('import-quaternaries.ts');
		const offenders = readsDb.filter((f) => /from 'dotenv'/.test(readFileSync(new URL(f, dir), 'utf8')));
		expect(offenders).toEqual([]);
		const unloaded = readsDb.filter((f) => !/loadDevEnv\(\)/.test(readFileSync(new URL(f, dir), 'utf8')));
		expect(unloaded).toEqual([]);
	});
});
