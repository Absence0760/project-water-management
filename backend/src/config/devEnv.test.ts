// The local-dev env loader (config/devEnv.ts): each checkout gets its own dev
// database, and only a local URL naming the default `water` is redirected.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
	// A temp directory holding only a copy of the committed file, so the developer's own (gitignored)
	// backend/.env.development.local, which may point DATABASE_URL at a preview database, never reaches the test.
	const committed = fileURLToPath(new URL('../../.env.development', import.meta.url));
	const dirs: string[] = [];
	function envDir(local?: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'wm-devenv-'));
		dirs.push(dir);
		copyFileSync(committed, join(dir, '.env.development'));
		if (local !== undefined) writeFileSync(join(dir, '.env.development.local'), local);
		return dir;
	}
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it('loads the committed env file and points both URLs at the checkout database', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42' };
		loadDevEnv(env, envDir());
		expect(env.DATABASE_URL).toBe(APP.replace(/water$/, 'water_w42'));
		expect(env.MIGRATION_DATABASE_URL).toBe(OWNER.replace(/water$/, 'water_w42'));
	});

	it('keeps a URL already set to another database', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42', DATABASE_URL: 'postgresql://water_app:water_app@127.0.0.1:5434/water_e2e' };
		loadDevEnv(env, envDir());
		expect(env.DATABASE_URL).toBe('postgresql://water_app:water_app@127.0.0.1:5434/water_e2e');
	});

	it('lets .env.development.local override the committed file, and leaves its other database alone', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42' };
		loadDevEnv(env, envDir('DATABASE_URL=postgresql://water_app:water_app@127.0.0.1:5434/preview\n'));
		expect(env.DATABASE_URL).toBe('postgresql://water_app:water_app@127.0.0.1:5434/preview');
		expect(env.MIGRATION_DATABASE_URL).toBe(OWNER.replace(/water$/, 'water_w42'));
	});

	it('reads nothing but the directory it is given', () => {
		const env: NodeJS.ProcessEnv = { DEV_DB_NAME: 'water_w42' };
		const dir = mkdtempSync(join(tmpdir(), 'wm-devenv-empty-'));
		dirs.push(dir);
		loadDevEnv(env, dir);
		expect(env.DATABASE_URL).toBeUndefined();
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
