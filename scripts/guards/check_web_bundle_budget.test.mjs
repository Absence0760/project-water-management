import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { BUDGET, WORKSPACE_PAGE, calibrationWorkerViolations, kb, landingChunks, measure, tabChunks, tabModules, violations } from './check_web_bundle_budget.mjs';

const budget = { totalCodeKb: 30, largestChunkKb: 5, largestTabChunkKb: 7, largestWorkerKb: 8, largestSpreadsheetWorkerKb: 12, largestAssetKb: 3, landingKb: 6 };

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
	const total = measure(Array.from({ length: 8 }, (_, i) => ({ path: `${i}.js`, gzipBytes: 4 * 1024 })));
	assert.match(violations(total, budget).join('\n'), /Total gzipped JS\+CSS is 32 KB/);

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

test('a Web Worker has its own ceiling, and still counts in the total', () => {
	const m = measure([
		{ path: '_app/immutable/workers/autocal.worker-x.js', gzipBytes: 7 * 1024 },
		{ path: '_app/immutable/chunks/page.js', gzipBytes: 4 * 1024 },
	]);
	assert.deepEqual(m.largestWorker, { path: '_app/immutable/workers/autocal.worker-x.js', kb: 7 });
	assert.deepEqual(m.largestChunk, { path: '_app/immutable/chunks/page.js', kb: 4 });
	assert.equal(m.totalCodeKb, 11);
	assert.deepEqual(violations(m, budget), [], 'a 7 KB worker is over the 5 KB page-chunk ceiling but under its own 8 KB');
	const big = measure([{ path: '_app/immutable/workers/w.js', gzipBytes: 9 * 1024 }]);
	const v = violations(big, budget);
	assert.equal(v.length, 1);
	assert.match(v[0], /Web Worker _app\/immutable\/workers\/w\.js is 9 KB, over the 8 KB per-worker budget/);
	// A page chunk named like a worker elsewhere is still a page chunk.
	assert.equal(measure([{ path: '_app/immutable/chunks/workers.js', gzipBytes: 1024 }]).largestWorker.kb, 0);
});

test('a spreadsheet worker has its own ceiling, apart from the calibration worker', () => {
	const m = measure([
		{ path: '_app/immutable/workers/export.worker-abc.js', gzipBytes: 11 * 1024 },
		{ path: '_app/immutable/workers/import.worker-def.js', gzipBytes: 10 * 1024 },
		{ path: '_app/immutable/workers/autocal.worker-x.js', gzipBytes: 7 * 1024 },
	]);
	assert.deepEqual(m.largestSpreadsheetWorker, { path: '_app/immutable/workers/export.worker-abc.js', kb: 11 });
	assert.deepEqual(m.largestWorker, { path: '_app/immutable/workers/autocal.worker-x.js', kb: 7 });
	assert.equal(m.totalCodeKb, 28);
	assert.deepEqual(violations(m, budget), [], 'an 11 KB spreadsheet worker is over the 8 KB worker ceiling but under its own 12 KB');
	const big = violations(measure([{ path: '_app/immutable/workers/import.worker-z.js', gzipBytes: 13 * 1024 }]), budget);
	assert.equal(big.length, 1);
	assert.match(big[0], /Spreadsheet worker _app\/immutable\/workers\/import\.worker-z\.js is 13 KB, over the 12 KB spreadsheet-worker budget/);
	// Another worker named "…export…" is not a spreadsheet worker.
	assert.equal(measure([{ path: '_app/immutable/workers/csvexport.worker-z.js', gzipBytes: 1024 }]).largestSpreadsheetWorker.kb, 0);
});

test("the calibration worker must share the page build's chunks (issue #9)", () => {
	const shared = { path: '_app/immutable/workers/autocal.worker-Ab1.js', text: 'import{c as f}from"../chunks/D39qfV0U.js";self.onmessage=()=>{}' };
	const spreadsheet = { path: '_app/immutable/workers/export.worker-x.js', text: 'self.onmessage=()=>{}' };
	assert.deepEqual(calibrationWorkerViolations([shared, spreadsheet]), []);
	// Built on its own (new Worker(new URL(…))): no import from chunks/.
	const own = calibrationWorkerViolations([{ path: shared.path, text: 'const e=1;self.onmessage=()=>{}' }]);
	assert.equal(own.length, 1);
	assert.match(own[0], /imports nothing from the page build's chunks/);
	// Vite's own worker build puts its chunks under workers/chunks/: that is not sharing.
	assert.equal(calibrationWorkerViolations([{ path: shared.path, text: 'import{c}from"./chunks/x.js"' }]).length, 1);
	const missing = calibrationWorkerViolations([spreadsheet]);
	assert.equal(missing.length, 1);
	assert.match(missing[0], /Expected one calibration worker/);
});

test('the tab modules are the LOAD map of the workspace page, nothing else', () => {
	const page = `<script module lang="ts">
	const LOAD = {
		network: () => import('$lib/components/network/NetworkTab.svelte'),
		runs: () => import("$lib/components/runs/RunsTab.svelte"),
		compare: () => import('$lib/components/compare/CompareView.svelte')
	};
	const loadAddData = () => import('$lib/components/series/AddDataDialog.svelte');
</script>`;
	assert.deepEqual(tabModules(page), [
		'src/lib/components/network/NetworkTab.svelte',
		'src/lib/components/runs/RunsTab.svelte',
		'src/lib/components/compare/CompareView.svelte',
	]);
	assert.deepEqual(tabModules('<script>const tabs = { runs: () => import("./RunsTab.svelte") };</script>'), [], 'no LOAD map, no tabs');
});

test('the real workspace page still has its LOAD map of lazy tabs', () => {
	const mods = tabModules(readFileSync(new URL(`../../frontend/${WORKSPACE_PAGE}`, import.meta.url), 'utf8'));
	assert.ok(mods.length >= 10, `found ${mods.length} tabs`);
	for (const tab of ['settings/SettingsTab.svelte', 'runs/RunsTab.svelte', 'network/NetworkTab.svelte']) {
		assert.ok(mods.includes(`src/lib/components/${tab}`), tab);
	}
	assert.ok(!mods.some((m) => m.includes('AddDataDialog')), 'a dialog the page loads lazily is not a tab');
});

test('a tab is found by the chunk that holds its module, whatever the chunk is named', () => {
	const chunks = {
		'_app/immutable/chunks/Aa1.js': { modules: ['src/lib/components/runs/RunsTab.svelte', 'src/lib/components/runs/PlausibilityPanel.svelte'], css: ['_app/immutable/assets/Bb2.css'] },
		// The Settings tab merged with code its lazy editor shares: no facade, still found.
		'_app/immutable/chunks/Cc3.js': { modules: ['src/lib/components/settings/sections.ts', 'src/lib/components/settings/SettingsTab.svelte'], css: [] },
		'_app/immutable/chunks/Dd4.js': { modules: [WORKSPACE_PAGE, 'src/lib/components/overview/OverviewTab.svelte'], css: ['_app/immutable/assets/Ee5.css'] },
	};
	const { files, errors } = tabChunks(['src/lib/components/runs/RunsTab.svelte', 'src/lib/components/settings/SettingsTab.svelte'], chunks);
	assert.deepEqual(errors, []);
	assert.deepEqual([...files].sort(), ['_app/immutable/assets/Bb2.css', '_app/immutable/chunks/Aa1.js', '_app/immutable/chunks/Cc3.js']);

	const none = tabChunks([], chunks);
	assert.equal(none.files.size, 0);
	assert.match(none.errors.join('\n'), /Found no lazy-loaded workspace tabs/);

	const missing = tabChunks(['src/lib/components/gone/GoneTab.svelte'], chunks);
	assert.match(missing.errors.join('\n'), /GoneTab\.svelte is in 0 chunks/);
	assert.match(tabChunks(['src/lib/components/runs/RunsTab.svelte'], {}).errors.join('\n'), /in 0 chunks/, 'an empty or missing chunk map fails');

	const inPage = tabChunks(['src/lib/components/overview/OverviewTab.svelte'], chunks);
	assert.equal(inPage.files.size, 0);
	assert.match(inPage.errors.join('\n'), /in the workspace page's own chunk/);
});

test('a tab chunk has its own ceiling, apart from the page chunks, and still counts in the total', () => {
	const tabs = new Set(['_app/immutable/chunks/tab.js', '_app/immutable/assets/tab.css']);
	const m = measure(
		[
			{ path: '_app/immutable/chunks/tab.js', gzipBytes: 6 * 1024 },
			{ path: '_app/immutable/assets/tab.css', gzipBytes: 1024 },
			{ path: '_app/immutable/chunks/page.js', gzipBytes: 4 * 1024 },
		],
		tabs,
	);
	assert.equal(m.tabCount, 2);
	assert.deepEqual(m.largestTabChunk, { path: '_app/immutable/chunks/tab.js', kb: 6 });
	assert.deepEqual(m.largestChunk, { path: '_app/immutable/chunks/page.js', kb: 4 });
	assert.equal(m.totalCodeKb, 11);
	assert.deepEqual(violations(m, budget), [], 'a 6 KB tab is over the 5 KB page-chunk ceiling but under its own 7 KB');

	const big = violations(measure([{ path: '_app/immutable/chunks/tab.js', gzipBytes: 8 * 1024 }], tabs), budget);
	assert.equal(big.length, 1);
	assert.match(big[0], /Workspace tab chunk _app\/immutable\/chunks\/tab\.js is 8 KB, over the 7 KB per-tab budget/);

	// The same file, not known to be a tab, is a page chunk and fails the page ceiling.
	const asPage = violations(measure([{ path: '_app/immutable/chunks/tab.js', gzipBytes: 6 * 1024 }]), budget);
	assert.equal(asPage.length, 1);
	assert.match(asPage[0], /Largest chunk _app\/immutable\/chunks\/tab\.js is 6 KB/);
});

test('an empty build is a failure, not a pass', () => {
	const v = violations(measure([{ path: 'index.html', gzipBytes: 10 }]), budget);
	assert.equal(v.length, 1);
	assert.match(v[0], /No JS or CSS files/);
});

test('the committed budget is internally sane', () => {
	assert.ok(BUDGET.largestChunkKb < BUDGET.totalCodeKb);
	assert.ok(BUDGET.largestChunkKb < BUDGET.largestTabChunkKb, 'a tab loads on top of the page, so its ceiling is the higher');
	assert.ok(BUDGET.largestTabChunkKb < BUDGET.totalCodeKb);
	assert.ok(BUDGET.largestWorkerKb < BUDGET.totalCodeKb);
	assert.ok(BUDGET.largestSpreadsheetWorkerKb < BUDGET.totalCodeKb);
	assert.ok(Object.isFrozen(BUDGET));
});

test('the landing page is found by its modules, summed with its CSS, and has its own ceiling (issue #57)', () => {
	const chunks = {
		'_app/immutable/chunks/L1.js': { modules: ['src/lib/components/landing/Landing.svelte', 'src/lib/components/landing/Hero.svelte'], css: ['_app/immutable/assets/L1.css'] },
		'_app/immutable/chunks/L2.js': { modules: ['src/lib/components/landing/data.generated.ts'], css: [] },
		'_app/immutable/nodes/0.js': { modules: ['src/routes/+layout.svelte'], css: [] },
	};
	const { files, errors } = landingChunks(chunks);
	assert.deepEqual(errors, []);
	assert.deepEqual([...files].sort(), ['_app/immutable/assets/L1.css', '_app/immutable/chunks/L1.js', '_app/immutable/chunks/L2.js']);
	const m = measure(
		[
			{ path: '_app/immutable/chunks/L1.js', gzipBytes: 4 * 1024 },
			{ path: '_app/immutable/assets/L1.css', gzipBytes: 1024 },
			{ path: '_app/immutable/chunks/L2.js', gzipBytes: 2 * 1024 },
			{ path: '_app/immutable/nodes/0.js', gzipBytes: 1024 },
		],
		new Set(),
		files,
	);
	assert.equal(m.landingKb, 7);
	assert.equal(m.totalCodeKb, 8, 'the landing still counts in the total');
	assert.match(violations(m, budget).join('\n'), /landing page's code is 7 KB, over the 6 KB landing budget/);

	assert.match(landingChunks({}).errors.join('\n'), /Found no chunk holding/);
	const inLayout = landingChunks({ '_app/immutable/nodes/0.js': { modules: ['src/routes/+layout.svelte', 'src/lib/components/landing/Landing.svelte'], css: [] } });
	assert.match(inLayout.errors.join('\n'), /in the chunk of src\/routes\/\+layout\.svelte/);
});
