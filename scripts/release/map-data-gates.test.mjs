// The licence and shape gates on the map's production data
// (scripts/release/map-data-gates.mjs): the frontend's tile variables, and a
// reference load's inputs, each with its positive control.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { frontendProblems, frontendSources, LOADABLE, legalTextHas, loadProblems, REQUIRED_TEXT } from './map-data-gates.mjs';

const has = () => true;
const lacks = () => false;

describe('frontend: the tile variables', () => {
	it('empty everywhere is fine (the map draws the plain background)', () => {
		assert.deepEqual(frontendProblems({}, lacks), []);
		assert.deepEqual(frontendProblems({ PUBLIC_TILES_URL: '', PUBLIC_TILES_GLYPHS_URL: ' ', PUBLIC_TERRAIN_URL: '' }, lacks), []);
	});

	it('the documented same-origin paths pass, the relief with its liability sentence', () => {
		const env = { PUBLIC_TILES_URL: '/tiles/south-africa.pmtiles', PUBLIC_TILES_GLYPHS_URL: '/tiles/fonts/{fontstack}/{range}.pbf', PUBLIC_TERRAIN_URL: '/tiles/terrain.pmtiles' };
		assert.deepEqual(frontendProblems(env, has), []);
	});

	it('refuses another origin, another path, or a glyph template that is not the served one', () => {
		for (const [k, v] of [
			['PUBLIC_TILES_URL', 'https://tiles.example.org/sa.pmtiles'],
			['PUBLIC_TILES_URL', '/api/tiles.pmtiles'],
			['PUBLIC_TILES_URL', '/tiles/../x.pmtiles'],
			['PUBLIC_TERRAIN_URL', '//evil.example/terrain.pmtiles'],
			['PUBLIC_TILES_GLYPHS_URL', '/tiles/fonts/{fontstack}/{range}.json']
		]) {
			assert.equal(frontendProblems({ [k]: v }, has).length, 1, `${k}=${v}`);
		}
	});

	it('the relief waits for the Copernicus Art. 6(c) sentence in the legal text', () => {
		const [p] = frontendProblems({ PUBLIC_TERRAIN_URL: '/tiles/terrain.pmtiles' }, lacks);
		assert.match(p, /Art\. 6\(c\)/);
		assert.deepEqual(frontendProblems({ PUBLIC_TILES_URL: '/tiles/south-africa.pmtiles' }, lacks), [], 'the basemap needs no such sentence');
	});
});

describe('load: a reference load’s inputs', () => {
	const landCover = { LOAD_KIND: 'land-cover', LOAD_KEY: 'reference/land-cover/worldcover-2021.json.gz', LOAD_SHA256: 'a'.repeat(64), LOAD_DATASET: 'WorldCover-2021-v200', LOAD_SOURCE: '', LOAD_MIN_ORDER: '1' };
	const rivers = { ...landCover, LOAD_KIND: 'rivers', LOAD_KEY: 'reference/rivers/hydrorivers-za.geojson.gz', LOAD_DATASET: 'HydroRIVERS-v10', LOAD_SOURCE: 'HydroRIVERS v1.0 © WWF' };

	it('well-formed loads of the allowed kinds pass (rivers once Exhibit B is in the legal text)', () => {
		assert.deepEqual(loadProblems(landCover, lacks), []);
		assert.deepEqual(loadProblems(rivers, has), []);
		assert.deepEqual(LOADABLE, ['land-cover', 'rivers']);
	});

	it('refuses the licence-blocked kinds, naming the Sources table, not the input', () => {
		for (const kind of ['quaternaries', 'dam-register', 'gauge-stations', 'sanlc']) {
			const problems = loadProblems({ ...landCover, LOAD_KIND: kind }, has);
			assert.equal(problems.length, 1);
			assert.match(problems[0], /blocked by their licences/);
			assert.doesNotMatch(problems[0], new RegExp(kind));
		}
	});

	it('rivers wait for HydroSHEDS’ Exhibit B statement, and need a source', () => {
		assert.match(loadProblems(rivers, lacks).join('\n'), /Exhibit B/);
		assert.match(loadProblems({ ...rivers, LOAD_SOURCE: ' ' }, has).join('\n'), /need a source/);
	});

	it('refuses malformed inputs before the approval', () => {
		for (const patch of [
			{ LOAD_KEY: 'reference/rivers/x.json' },
			{ LOAD_KEY: 'reference/land-cover/../x.json' },
			{ LOAD_KEY: 'reference/land-cover/a/b.json' },
			{ LOAD_SHA256: 'A'.repeat(64) },
			{ LOAD_DATASET: 'synthetic' },
			{ LOAD_DATASET: 'a"; rm -rf /' },
			{ LOAD_SOURCE: 'two\nlines' },
			{ LOAD_MIN_ORDER: '16' },
			{ LOAD_MIN_ORDER: '0' }
		]) {
			assert.equal(loadProblems({ ...landCover, ...patch }, has).length, 1, JSON.stringify(patch));
		}
	});
});

describe('the legal text search', () => {
	it('reads frontend/src without its tests, and finds a sentence across line breaks', () => {
		const files = frontendSources();
		assert.ok(files.some((f) => f.endsWith('routes/terms/+page.svelte')), 'positive control: the terms page is read');
		assert.ok(!files.some((f) => /\.test\./.test(f)));
		const fake = { 'a.svelte': '<p>The organisations … do not incur any\n\t\tliability for any use of the Copernicus WorldDEM-30.</p>' };
		assert.equal(legalTextHas(REQUIRED_TEXT.terrain, Object.keys(fake), (f) => fake[f]), true);
		assert.equal(legalTextHas(REQUIRED_TEXT.rivers, Object.keys(fake), (f) => fake[f]), false);
	});

	it('the sentences are the licences’ own words (as docs/maps.md § Sources quotes them)', () => {
		const maps = readFileSync(fileURLToPath(new URL('../../docs/maps.md', import.meta.url)), 'utf8');
		assert.ok(maps.includes(REQUIRED_TEXT.rivers));
		const deployment = readFileSync(fileURLToPath(new URL('../../docs/deployment.md', import.meta.url)), 'utf8');
		assert.ok(deployment.replace(/\s+/g, ' ').includes(REQUIRED_TEXT.terrain));
	});
});
