import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, kb, measure, violations } from './check_web_bundle_budget.mjs';

const budget = { totalCodeKb: 10, largestChunkKb: 5, largestAssetKb: 3 };

test('kb rounds up once, not per file', () => {
	assert.equal(kb(0), 0);
	assert.equal(kb(1), 1);
	assert.equal(kb(1024), 1);
	assert.equal(kb(1025), 2);
	// Two 600-byte files are 2 KB rounded each but 2 KB summed only when summed first.
	const m = measure([
		{ path: 'a.js', gzipBytes: 600 },
		{ path: 'b.js', gzipBytes: 600 },
	]);
	assert.equal(m.totalCodeKb, 2);
	const m3 = measure([
		{ path: 'a.js', gzipBytes: 300 },
		{ path: 'b.js', gzipBytes: 300 },
		{ path: 'c.js', gzipBytes: 300 },
	]);
	assert.equal(m3.totalCodeKb, 1, 'three 300-byte chunks are 1 KB, not 3');
});

test('JS and CSS count as code; everything else is an asset', () => {
	const m = measure([
		{ path: '_app/immutable/chunks/x.js', gzipBytes: 2048 },
		{ path: '_app/immutable/assets/y.css', gzipBytes: 1024 },
		{ path: 'fonts/z.woff2', gzipBytes: 4096 },
		{ path: 'index.html', gzipBytes: 512 },
	]);
	assert.equal(m.codeCount, 2);
	assert.equal(m.totalCodeKb, 3);
	assert.deepEqual(m.largestChunk, { path: '_app/immutable/chunks/x.js', kb: 2 });
	assert.deepEqual(m.largestAsset, { path: 'fonts/z.woff2', kb: 4 });
});

test('a build under every ceiling passes', () => {
	const m = measure([
		{ path: 'a.js', gzipBytes: 4 * 1024 },
		{ path: 'b.css', gzipBytes: 1024 },
		{ path: 'icon.png', gzipBytes: 1024 },
	]);
	assert.deepEqual(violations(m, budget), []);
});

test('each ceiling fails on its own', () => {
	const total = measure(Array.from({ length: 3 }, (_, i) => ({ path: `${i}.js`, gzipBytes: 4 * 1024 })));
	assert.match(violations(total, budget).join('\n'), /Total gzipped JS\+CSS is 12 KB/);

	const chunk = measure([{ path: 'big.js', gzipBytes: 6 * 1024 }]);
	const v = violations(chunk, budget);
	assert.equal(v.length, 1);
	assert.match(v[0], /Largest chunk big\.js is 6 KB/);

	const asset = measure([
		{ path: 'a.js', gzipBytes: 1024 },
		{ path: 'font.woff2', gzipBytes: 4 * 1024 },
	]);
	assert.match(violations(asset, budget).join('\n'), /Asset font\.woff2 is 4 KB/);
});

test('an empty build is a failure, not a pass', () => {
	const v = violations(measure([{ path: 'index.html', gzipBytes: 10 }]), budget);
	assert.equal(v.length, 1);
	assert.match(v[0], /No JS or CSS files/);
});

test('the committed budget is internally sane', () => {
	assert.ok(BUDGET.largestChunkKb < BUDGET.totalCodeKb);
	assert.ok(Object.isFrozen(BUDGET));
});
