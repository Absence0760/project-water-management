#!/usr/bin/env node
// The site's /reports/* path belongs to CloudFront, not the SPA.
//
// In production the distribution sends every /reports/* request to the
// private reports bucket, and serves it only to a CloudFront signed URL the
// API minted (infra/s3_cloudfront.tf, the /reports/* ordered_cache_behavior;
// docs/security.md § Reports). That behaviour is matched before the default
// (SPA) one, so a frontend page, endpoint or static file under /reports
// would work in `pnpm dev` and e2e and then answer 403 (no signature) or a
// bucket miss in production, silently. The report PDF keys are
// reports/<project>/<report>.pdf, which is why the path isn't renamed.
//
// This guard fails when the frontend could own a URL under /reports:
//   - a top-level route segment `reports` in frontend/src/routes, looking
//     through route groups (`(app)/reports`) and SvelteKit's character
//     escapes (`[x+72]eports`);
//   - a top-level dynamic segment (`[slug]`, `[x=matcher]`, `[...rest]`,
//     `[[optional]]`, or a segment mixing text and a parameter), which
//     would also match /reports/...;
//   - anything under frontend/static/reports (copied to the build as is).
// Prerendered pages come from routes, so the route checks cover them.
//
// Run:   node scripts/guards/check_reports_path.mjs
// Tests: node --test scripts/guards/check_reports_path.test.mjs (pnpm test:guards,
//        which also checks the real tree; CI's guard step runs it).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESERVED = 'reports';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const WHY =
	'CloudFront routes /reports/* to the private reports bucket and serves it only to signed URLs the API mints ' +
	'(infra/s3_cloudfront.tf, the /reports/* behaviour; docs/security.md § Reports). A frontend route or static file there ' +
	'works locally but is unreachable in production. Put report pages under /projects/:id/ instead.';

/** A route group segment, `(name)`: adds nothing to the URL. */
const isGroup = (seg) => /^\([^)]*\)$/.test(seg);

/** SvelteKit's escapes, `[x+HH]` and `[u+HHHH]`, decoded; other brackets left as they are. */
export const decodeEscapes = (seg) =>
	seg.replace(/\[x\+([0-9a-f]{2})\]/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\[u\+([0-9a-f]{4,6})\]/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

/** Whether a segment has a parameter once escapes are decoded. */
export const isDynamic = (seg) => decodeEscapes(seg).includes('[');

/**
 * Problems with a route directory, given as its path segments under
 * frontend/src/routes (e.g. ['(app)', 'reports', '[id]']). Only the first
 * URL segment matters.
 * @param {string[]} segments
 * @returns {string | null}
 */
export function routeProblem(segments) {
	const first = segments.find((s) => !isGroup(s));
	if (first === undefined) return null;
	if (isDynamic(first)) return `a top-level dynamic route segment "${first}" also matches /${RESERVED}/…`;
	if (decodeEscapes(first) === RESERVED) return `a top-level route "/${RESERVED}"`;
	return null;
}

/**
 * Every problem in a tree: route directories (segments under routes/) and
 * static files (paths under static/).
 * @param {{ routeDirs: string[][], staticFiles: string[] }} tree
 * @returns {string[]}
 */
export function findProblems({ routeDirs, staticFiles }) {
	const out = [];
	for (const segs of routeDirs) {
		// Report each clash once, at the directory where it starts.
		const firstUrl = segs.findIndex((s) => !isGroup(s));
		if (firstUrl !== segs.length - 1) continue;
		const p = routeProblem(segs);
		if (p) out.push(`frontend/src/routes/${segs.join('/')}: ${p}`);
	}
	for (const f of staticFiles) {
		if (f === RESERVED || f.startsWith(`${RESERVED}/`)) out.push(`frontend/static/${f}: a static file served at /${f}`);
	}
	return out;
}

/** Directories under `dir`, as segment lists relative to it. */
function walkDirs(dir, base = dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (!statSync(p).isDirectory()) continue;
		out.push(relative(base, p).split(/[\\/]/));
		walkDirs(p, base, out);
	}
	return out;
}

/** Files under `dir`, relative to it, with / separators. */
function walkFiles(dir, base = dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walkFiles(p, base, out);
		else out.push(relative(base, p).split(/[\\/]/).join('/'));
	}
	return out;
}

/** The real tree under `root` (the repo by default). */
export function scan(root = ROOT) {
	const routes = join(root, 'frontend/src/routes');
	if (!existsSync(routes)) throw new Error(`no ${routes}`);
	return { routeDirs: walkDirs(routes), staticFiles: walkFiles(join(root, 'frontend/static')) };
}

function main() {
	const problems = findProblems(scan());
	if (problems.length) {
		for (const p of problems) console.error(`::error::${p}`);
		console.error(WHY);
		process.exit(1);
	}
	console.log(`/${RESERVED}/* is free for CloudFront: no frontend route or static file under it.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
