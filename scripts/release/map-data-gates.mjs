#!/usr/bin/env node
// The licence gates on the catchment map's production data (docs/maps.md §
// Sources; docs/deployment.md § Map tiles and § Reference datasets), checked
// before anything ships, with no AWS:
//
//   node scripts/release/map-data-gates.mjs frontend
//     deploy-frontend.yml, before the build. PUBLIC_TILES_URL,
//     PUBLIC_TILES_GLYPHS_URL and PUBLIC_TERRAIN_URL (from the repository's
//     variables) must each be empty or a same-origin path under /tiles/ that
//     the site's /tiles/* behaviour serves (infra/s3_cloudfront.tf
//     tiles_range): the CSP's connect-src 'self' allows nothing else anyway,
//     and a typo would ship a map that silently draws nothing. The relief
//     (PUBLIC_TERRAIN_URL) needs the Copernicus WorldDEM-30 licence's
//     liability sentence (Art. 6(c)) in the app's legal text first.
//
//   node scripts/release/map-data-gates.mjs load
//     load-reference.yml, before the production approval. LOAD_KIND,
//     LOAD_KEY, LOAD_SHA256, LOAD_DATASET, LOAD_SOURCE and LOAD_MIN_ORDER
//     (the workflow's inputs) must have the shapes the migrate Lambda accepts
//     (backend/src/geo/referenceLoad.ts parseLoadRequest checks them again),
//     the kind must be one the Sources table allows (land-cover,
//     evaporation, rivers), and
//     rivers need HydroSHEDS' Exhibit B statement in the app's legal text
//     first (the HydroSHEDS licence, § 2.2).
//
// "In the app's legal text" means some file under frontend/src (tests left
// out) carries the sentence, wherever the legal notice puts it.
//
// Tests: node --test scripts/release/map-data-gates.test.mjs (pnpm test:guards)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The sentences a licence requires in the legal text before its data is served. */
export const REQUIRED_TEXT = {
	// License COPDEM 30, Art. 6(c).
	terrain: 'do not incur any liability for any use of the Copernicus WorldDEM-30',
	// HydroSHEDS version 1 License Agreement, Exhibit B.
	rivers: 'WWF has not evaluated the data as altered and incorporated within'
};

/** The kinds a production load may name (backend/src/geo/referenceLoad.ts REFERENCE_KINDS, the allowed ones; referenceLoad.test.ts keeps the two in step). */
export const LOADABLE = ['land-cover', 'evaporation', 'rivers'];

const ARCHIVE = /^\/tiles\/[a-z0-9-]+\.pmtiles$/;
const GLYPHS = '/tiles/fonts/{fontstack}/{range}.pbf';

/** Every text source under frontend/src, tests left out. */
export function frontendSources(dir = join(ROOT, 'frontend/src')) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) return frontendSources(p);
		return /\.(svelte|ts|js|md|json)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [p] : [];
	});
}

/** Whether some legal-text source carries `sentence` (whitespace-insensitive). */
export function legalTextHas(sentence, files = frontendSources(), read = (f) => readFileSync(f, 'utf8')) {
	const squash = (s) => s.replace(/\s+/g, ' ');
	const want = squash(sentence);
	return files.some((f) => squash(read(f)).includes(want));
}

/** Problems with the frontend's map variables (empty: none). */
export function frontendProblems(env, hasText = legalTextHas) {
	const problems = [];
	const tiles = (env.PUBLIC_TILES_URL ?? '').trim();
	const glyphs = (env.PUBLIC_TILES_GLYPHS_URL ?? '').trim();
	const terrain = (env.PUBLIC_TERRAIN_URL ?? '').trim();
	if (tiles && !ARCHIVE.test(tiles)) problems.push('PUBLIC_TILES_URL must be empty or /tiles/<name>.pmtiles (same origin, served by the /tiles/* behaviour)');
	if (glyphs && glyphs !== GLYPHS) problems.push(`PUBLIC_TILES_GLYPHS_URL must be empty or exactly ${GLYPHS}`);
	if (terrain && !ARCHIVE.test(terrain)) problems.push('PUBLIC_TERRAIN_URL must be empty or /tiles/<name>.pmtiles');
	if (terrain && !hasText(REQUIRED_TEXT.terrain)) {
		problems.push('PUBLIC_TERRAIN_URL (the relief) needs the Copernicus WorldDEM-30 licence’s liability sentence (Art. 6(c)) in the app’s legal text first (docs/maps.md § Relief)');
	}
	return problems;
}

/** Problems with a reference load's inputs (empty: none). Never echoes an input. */
export function loadProblems(env, hasText = legalTextHas) {
	const problems = [];
	const kind = env.LOAD_KIND ?? '';
	if (!LOADABLE.includes(kind)) {
		problems.push(`the kind must be one of ${LOADABLE.join(', ')}: the others are blocked by their licences (docs/maps.md § Sources)`);
		return problems;
	}
	if (!new RegExp(`^reference/${kind}/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`).test(env.LOAD_KEY ?? '') || (env.LOAD_KEY ?? '').includes('..')) {
		problems.push(`the key must be reference/${kind}/<file> in the reference bucket`);
	}
	if (!/^[0-9a-f]{64}$/.test(env.LOAD_SHA256 ?? '')) problems.push('sha256 must be the file’s SHA-256 (sha256sum), 64 lowercase hex digits');
	if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$/.test(env.LOAD_DATASET ?? '') || env.LOAD_DATASET === 'synthetic') {
		problems.push('the dataset must be a label of 1–50 letters, digits, spaces, dots, dashes or underscores, not "synthetic"');
	}
	const source = env.LOAD_SOURCE ?? '';
	if (source.length > 500 || /[\u0000-\u001f]/.test(source)) problems.push('the source is at most 500 characters on one line');
	if (kind === 'rivers' && !source.trim()) problems.push('rivers need a source: the attribution stored on every reach');
	const order = env.LOAD_MIN_ORDER ?? '1';
	if (!/^([1-9]|1[0-5])$/.test(order)) problems.push('min_order is a Strahler order, 1 to 15');
	if (kind === 'rivers' && !hasText(REQUIRED_TEXT.rivers)) {
		problems.push('rivers need HydroSHEDS’ Exhibit B statement in the app’s legal text first (docs/maps.md § Sources, the HydroRIVERS row)');
	}
	return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2];
	const problems = mode === 'frontend' ? frontendProblems(process.env) : mode === 'load' ? loadProblems(process.env) : ['usage: map-data-gates.mjs frontend | load'];
	for (const p of problems) console.error(`::error::${p}`);
	if (problems.length) process.exit(1);
	console.log(mode === 'frontend' ? 'Map variables OK.' : 'Load inputs OK.');
}
