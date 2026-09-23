#!/usr/bin/env node
// Hard ceilings on the shipped frontend bundle (estate standard: feohledger's
// web-bundle-budget.yml, threkir's check_web_bundle_budget.mjs).
//
// The frontend is a static SPA on S3 + CloudFront, so every kilobyte here is
// downloaded by every user on a cold visit, and nothing else in CI notices
// weight. A change that pushes a metric over its ceiling fails CI, so the
// increase is acknowledged instead of landing unremarked.
//
// It is a ratchet, not a wall. Raising a ceiling is a legitimate outcome when
// the answer is "ship the feature", but the raise is deliberate: edit BUDGET
// below and append a dated entry to the change log saying what was measured
// and why the growth is warranted.
//
// Three populations, gzip-measured with node:zlib:
//   totalCodeKb     every emitted JS + CSS file, summed in bytes and rounded
//                   once. Lazy chunks count too: code-splitting a dependency
//                   must not lower this number, only removing weight does.
//   largestChunkKb  the largest single JS/CSS file. Catches one heavyweight
//                   dependency landing in one chunk (a second chart library,
//                   a spreadsheet parser, a date library).
//   largestAssetKb  the largest single non-JS/CSS file (fonts, images, HTML,
//                   the manifest). Per file and never summed: a visitor loads
//                   one favicon, one font weight at a time.
//
// ── Ceiling change log (append; newest last) ──────────────────────────────
// 2026-09-23  initial. Measured on main @ 02552f4 (production build):
//             code 225 KB across 58 JS/CSS files, largest chunk 81 KB
//             (nodes/7: the catchment workspace page, which carries the
//             engine and uPlot), largest other asset 22 KB (icon-512.png).
//             Ceilings: ~25% headroom on the total and the largest chunk
//             (the engine and the workspace page are still growing), and a
//             100 KB per-asset ceiling that no single font or image should
//             ever need.
//
// Run:   pnpm build:frontend && pnpm check:bundle
// CI:    ci.yml, job `test`, after `pnpm build`.
// Tests: node --test scripts/guards/check_web_bundle_budget.test.mjs

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET = Object.freeze({
	totalCodeKb: 280,
	largestChunkKb: 100,
	largestAssetKb: 100,
});

const CODE = /\.(m?js|css)$/;

/** @param {number} bytes */
export const kb = (bytes) => Math.ceil(bytes / 1024);

/**
 * @param {{ path: string, gzipBytes: number }[]} files
 */
export function measure(files) {
	let codeBytes = 0;
	let codeCount = 0;
	let largestChunk = { path: '', gzipBytes: 0 };
	let largestAsset = { path: '', gzipBytes: 0 };
	for (const f of files) {
		if (CODE.test(f.path)) {
			codeBytes += f.gzipBytes;
			codeCount += 1;
			if (f.gzipBytes > largestChunk.gzipBytes) largestChunk = f;
		} else if (f.gzipBytes > largestAsset.gzipBytes) {
			largestAsset = f;
		}
	}
	return {
		fileCount: files.length,
		codeCount,
		totalCodeKb: kb(codeBytes),
		largestChunk: { path: largestChunk.path, kb: kb(largestChunk.gzipBytes) },
		largestAsset: { path: largestAsset.path, kb: kb(largestAsset.gzipBytes) },
	};
}

/**
 * @param {ReturnType<typeof measure>} m
 * @param {typeof BUDGET} budget
 * @returns {string[]} one message per ceiling exceeded
 */
export function violations(m, budget = BUDGET) {
	const out = [];
	if (m.codeCount === 0) {
		out.push('No JS or CSS files found in the build. The build output moved or the build failed; this guard measured nothing.');
		return out;
	}
	if (m.totalCodeKb > budget.totalCodeKb) {
		out.push(
			`Total gzipped JS+CSS is ${m.totalCodeKb} KB, over the ${budget.totalCodeKb} KB budget. Trim weight, or raise BUDGET.totalCodeKb in scripts/guards/check_web_bundle_budget.mjs with a dated change-log entry explaining the growth.`,
		);
	}
	if (m.largestChunk.kb > budget.largestChunkKb) {
		out.push(
			`Largest chunk ${m.largestChunk.path} is ${m.largestChunk.kb} KB, over the ${budget.largestChunkKb} KB per-chunk budget. This usually means one heavyweight dependency landed in one chunk; check it is needed before raising the ceiling.`,
		);
	}
	if (m.largestAsset.kb > budget.largestAssetKb) {
		out.push(
			`Asset ${m.largestAsset.path} is ${m.largestAsset.kb} KB gzipped, over the ${budget.largestAssetKb} KB per-asset budget. Subset the font or compress the image rather than raising the ceiling.`,
		);
	}
	return out;
}

/** @param {string} dir */
function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

function main() {
	const buildDir = process.argv[2] ?? 'frontend/build';
	let paths;
	try {
		paths = walk(buildDir);
	} catch {
		console.error(`::error::No build output at ${buildDir}. Run pnpm build:frontend first.`);
		process.exit(1);
	}
	const files = paths.map((p) => ({ path: relative(buildDir, p), gzipBytes: gzipSync(readFileSync(p)).length }));
	const m = measure(files);
	const rows = [
		['Total gzipped JS+CSS', `${m.totalCodeKb} KB`, `${BUDGET.totalCodeKb} KB`],
		[`Largest chunk (${m.largestChunk.path})`, `${m.largestChunk.kb} KB`, `${BUDGET.largestChunkKb} KB`],
		[`Largest other asset (${m.largestAsset.path || 'none'})`, `${m.largestAsset.kb} KB`, `${BUDGET.largestAssetKb} KB`],
	];
	for (const [what, size, budget] of rows) console.log(`${what}: ${size} (budget ${budget})`);
	console.log(`Files measured: ${m.fileCount} (${m.codeCount} JS/CSS)`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const table = ['## Web bundle budget', '', '| Metric | Size | Budget |', '|---|---|---|', ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, table.join('\n') + '\n');
	}
	const bad = violations(m);
	for (const v of bad) console.error(`::error::${v}`);
	process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
