// Tests for check_lambda_bundle.mjs. The metafiles are cut down from what
// esbuild 0.28 actually writes for backend/src/lambda.ts with
// --external:playwright-core (the guard job has no node_modules, so esbuild
// isn't run here; package-lambdas.sh runs the guard on real metafiles in CI).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkMetafile, parseArgs } from './check_lambda_bundle.mjs';

const OUT = '../../../tmp/tmp.abc/api/lambda.mjs';

/** A metafile for the API bundle, with extra inputs and output imports. */
function meta({ inputs = [], imports = [] } = {}) {
	const ins = {
		'src/lambda.ts': { bytes: 1, imports: [] },
		'src/reports/render.ts': { bytes: 1, imports: [{ path: 'playwright-core', kind: 'dynamic-import', external: true }] },
		'../node_modules/.pnpm/pg@8.16.3/node_modules/pg/lib/index.js': { bytes: 1, imports: [] },
	};
	for (const p of inputs) ins[p] = { bytes: 1, imports: [] };
	return {
		inputs: ins,
		outputs: {
			[OUT]: {
				bytes: 1,
				imports: [
					{ path: 'crypto', kind: 'import-statement', external: true },
					{ path: 'pg-native', kind: 'require-call', external: true },
					{ path: 'playwright-core', kind: 'dynamic-import', external: true },
					...imports,
				],
			},
		},
	};
}

const chromium = [
	{ pkg: 'playwright-core', why: 'only the renderer image ships it', allowDynamic: true },
	{ pkg: 'chromium-bidi', why: 'only the renderer image ships it', allowDynamic: false },
];

describe('checkMetafile', () => {
	it('passes the API bundle as built: playwright-core only through the lazy import()', () => {
		assert.deepEqual(checkMetafile(meta(), 'api', chromium), []);
	});

	it('refuses a static import of the external playwright-core (the case the inputs-only guard missed, issue #126)', () => {
		const m = meta({ imports: [{ path: 'playwright-core', kind: 'import-statement', external: true }] });
		// The package is external, so it is not an input: the old check saw nothing.
		assert.equal(Object.keys(m.inputs).some((p) => p.includes('node_modules/playwright-core/')), false);
		const errors = checkMetafile(m, 'api', chromium);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /the api bundle has a static \(non-dynamic\) import of playwright-core/);
		assert.match(errors[0], /lambda\.mjs: import-statement of external 'playwright-core'/);
	});

	it('refuses a require() and a subpath import of it too', () => {
		for (const imp of [
			{ path: 'playwright-core', kind: 'require-call', external: true },
			{ path: 'playwright-core/lib/server', kind: 'import-statement', external: true },
		]) {
			assert.equal(checkMetafile(meta({ imports: [imp] }), 'api', chromium).length, 1, imp.path);
		}
	});

	it('does not mistake a package whose name only starts with the forbidden one', () => {
		const m = meta({ imports: [{ path: 'playwright-core-extra', kind: 'import-statement', external: true }] });
		assert.deepEqual(checkMetafile(m, 'api', chromium), []);
		// pg-native is external in every pg bundle; a `pg` rule must not trip on it.
		const noPg = meta();
		delete noPg.inputs['../node_modules/.pnpm/pg@8.16.3/node_modules/pg/lib/index.js'];
		assert.deepEqual(checkMetafile(noPg, 'fetcher', [{ pkg: 'pg', why: 'no database' }]), []);
	});

	it('refuses a bundled package (its files are inputs)', () => {
		const m = meta({ inputs: ['../node_modules/.pnpm/chromium-bidi@1.0.0/node_modules/chromium-bidi/lib/index.js'] });
		const errors = checkMetafile(m, 'api', chromium);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /the api bundle carries chromium-bidi/);
	});

	it('refuses even a dynamic import of a package under a plain --forbid rule', () => {
		const m = meta({ imports: [{ path: 'dotenv', kind: 'dynamic-import', external: true }] });
		const errors = checkMetafile(m, 'api', [{ pkg: 'dotenv', why: 'no env files', allowDynamic: false }]);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /an import of dotenv/);
	});

	it('refuses the pg the fetcher must not carry', () => {
		const errors = checkMetafile(meta(), 'fetcher', [{ pkg: 'pg', why: 'no database' }]);
		assert.equal(errors.length, 1);
		assert.match(errors[0], /the fetcher bundle carries pg \(no database\)/);
	});

	it('fails a metafile with no lambda entry or no output instead of passing it', () => {
		for (const m of [{}, { inputs: { 'src/other.ts': {} }, outputs: { [OUT]: { imports: [] } } }, { inputs: meta().inputs, outputs: {} }]) {
			const errors = checkMetafile(m, 'api', chromium);
			assert.equal(errors.length, 1);
			assert.match(errors[0], /the bundle guards cannot run/);
		}
	});
});

describe('parseArgs', () => {
	it('reads the rules', () => {
		assert.deepEqual(parseArgs(['m.json', 'api', '--forbid', 'dotenv', 'why a', '--forbid-static', 'playwright-core', 'why b']), {
			file: 'm.json',
			name: 'api',
			rules: [
				{ pkg: 'dotenv', why: 'why a', allowDynamic: false },
				{ pkg: 'playwright-core', why: 'why b', allowDynamic: true },
			],
		});
	});

	it('refuses a malformed or empty rule list', () => {
		assert.throws(() => parseArgs(['m.json']), /usage/);
		assert.throws(() => parseArgs(['m.json', 'api']), /no rules/);
		assert.throws(() => parseArgs(['m.json', 'api', '--forbid', 'dotenv']), /bad rule/);
		assert.throws(() => parseArgs(['m.json', 'api', '--ban', 'dotenv', 'why']), /bad rule/);
	});
});

describe('CLI', () => {
	const script = fileURLToPath(new URL('./check_lambda_bundle.mjs', import.meta.url));
	const run = (m) => {
		const file = join(mkdtempSync(join(tmpdir(), 'lambda-meta-')), 'api.json');
		writeFileSync(file, JSON.stringify(m));
		return spawnSync(process.execPath, [script, file, 'api', '--forbid-static', 'playwright-core', 'why'], { encoding: 'utf8' });
	};

	it('exits 0 on a clean bundle and 1 with the message on a static import', () => {
		assert.equal(run(meta()).status, 0);
		const bad = run(meta({ imports: [{ path: 'playwright-core', kind: 'import-statement', external: true }] }));
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /^error: the api bundle has a static \(non-dynamic\) import of playwright-core/);
	});
});
