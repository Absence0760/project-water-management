// Tests for check_forecast_cut.mjs, plus the check itself against the real
// tree (this is what runs in CI's guard step).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { findProblems, HOWS, INVENTORY, latestFunctions, scan } from './check_forecast_cut.mjs';

function tree(files) {
	const root = mkdtempSync(join(tmpdir(), 'forecast-cut-'));
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), text);
	}
	return root;
}

describe('scan', () => {
	it('finds the frontend fetches, the backend reads and the SQL functions, and skips tests', () => {
		const root = tree({
			'frontend/src/lib/a.svelte': 'cachedSeries(id, k, null, () => api.runs.series(p, id, k, null)); api.runs.series(p, id, "x", null)',
			'frontend/src/lib/share.ts': "api.series(token, 'ewr')",
			'frontend/src/lib/urls.ts': '`/runs/${r}/series/bulk`',
			'frontend/src/lib/a.test.ts': 'api.runs.series(p, id, k, null)',
			'backend/src/x.ts': 'SELECT "values" FROM run_series WHERE run_id = $1; -- FROM\n\t run_series',
			'backend/src/x.db.test.ts': 'FROM run_series',
			'backend/src/__tests__/helpers.ts': 'FROM run_series',
			'backend/src/y.ts': 'run_series has no ordinal column', // a comment, not a read
			'backend/migrations/001_a.sql': 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 FROM run_series $$;\nCREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 FROM run_series $$;',
			'backend/migrations/002_b.sql': 'CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nDROP FUNCTION g();'
		});
		assert.deepEqual(
			Object.fromEntries(scan(root)),
			{ 'frontend/src/lib/a.svelte': 2, 'frontend/src/lib/share.ts': 1, 'frontend/src/lib/urls.ts': 1, 'backend/src/x.ts': 2 }
		);
	});

	it('reads a function at its latest definition (a later CREATE OR REPLACE that reads run_series counts)', () => {
		const fns = latestFunctions([
			{ name: '001.sql', text: 'CREATE FUNCTION f(a int) RETURNS int AS $$ SELECT 1 $$;' },
			{ name: '002.sql', text: 'CREATE OR REPLACE FUNCTION f(a int) RETURNS int AS $$ SELECT 1 FROM run_series $$;' }
		]);
		assert.equal(fns.get('f').file, '002.sql');
		assert.match(fns.get('f').body, /run_series/);
	});
});

describe('findProblems', () => {
	const files = { 'a.svelte': 'x = beforeForecast(v, s, f); <LineChart {band} />', 'b.ts': '' };
	const read = (p) => files[p] ?? null;
	const entry = { path: 'a.svelte', reads: 1, how: 'cut+band', evidence: ['beforeForecast(', '{band}'] };

	it('passes a listed reader with its count and its evidence (positive control)', () => {
		assert.deepEqual(findProblems(new Map([['a.svelte', 1]]), [entry], read), []);
	});

	it('fails a reader that is not listed: a new view over stored series', () => {
		const p = findProblems(new Map([['a.svelte', 1], ['new.svelte', 1]]), [entry], read);
		assert.equal(p.length, 1);
		assert.match(p[0], /new\.svelte reads a run's stored series \(1×\) but isn't in the inventory/);
	});

	it('fails a second read in a listed file', () => {
		assert.match(findProblems(new Map([['a.svelte', 2]]), [entry], read)[0], /2× but the inventory says 1×/);
	});

	it('fails when the cut or the band is gone', () => {
		const p = findProblems(new Map([['a.svelte', 1]]), [entry], (f) => (f === 'a.svelte' ? '<LineChart />' : null));
		assert.equal(p.length, 2);
		assert.match(p[0], /"cut\+band" \("beforeForecast\("\) is gone from a\.svelte/);
	});

	it('fails a stale entry, and an unknown way of treating the forecast', () => {
		assert.match(findProblems(new Map(), [entry], read)[0], /reads no run series any more/);
		assert.match(findProblems(new Map([['a.svelte', 1]]), [{ ...entry, how: 'ignore' }], read)[0], /"ignore" is not one of/);
	});

	it('reads evidence from another file when `in` names one', () => {
		const e = { path: 'b.ts', reads: 1, how: 'cut', evidence: ['{band}'], in: 'a.svelte' };
		assert.deepEqual(findProblems(new Map([['b.ts', 1]]), [e], read), []);
	});
});

describe('the inventory', () => {
	it('says how every entry treats a forecast run, once per path', () => {
		for (const e of INVENTORY) assert.ok(HOWS.includes(e.how), e.path);
		assert.equal(new Set(INVENTORY.map((e) => e.path)).size, INVENTORY.length);
	});

	it('matches the real tree: every reader listed, every listed reader real, every piece of evidence there', () => {
		assert.deepEqual(findProblems(scan()), []);
	});
});
