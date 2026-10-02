// The operator's fetch scripts (bin/tiles-dev.sh, bin/evaporation-fetch.sh)
// check every override before it reaches a command line or a download
// (round-4 hardening; docs/maps.md § Basemap, § Evaporation from the map):
// a hostile or mistyped value exits 2 before anything runs, and every
// download is HTTPS only, redirects included. Runs each script with `env`
// (prints only) or a bad value; nothing is downloaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (script, args, env) => spawnSync('bash', [join(ROOT, 'bin', script), ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });

test('tiles-dev.sh: the defaults pass, and `env` prints the URLs', () => {
	const r = run('tiles-dev.sh', ['env'], {});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^PUBLIC_TILES_URL=/m);
});

test('tiles-dev.sh refuses a hostile or mistyped override with exit 2, before doing anything', () => {
	const bad = {
		TILES_BBOX: '16,-35,33,-22 -sql "DROP"',
		TILES_MAXZOOM: '15; rm -rf ~',
		TERRAIN_MAXZOOM: 'x',
		RIVERS_MIN_ORDER: '-1',
		TILES_FONTS_REF: 'main',
		TILES_BUILD: '2026-10-01',
		TERRAIN_SOURCE: 'http://example.com/planet.pmtiles',
		WATER_SOURCE: 'file:///etc',
		RIVERS_URL: 'https://example.com/a b.zip'
	};
	for (const [k, v] of Object.entries(bad)) {
		const r = run('tiles-dev.sh', ['env'], { [k]: v });
		assert.equal(r.status, 2, `${k}=${v} should be refused`);
		assert.equal(r.stdout, '', `${k}: nothing runs`);
	}
});

test('evaporation-fetch.sh refuses a non-HTTPS source, a bad box and a bad label with exit 2', () => {
	for (const env of [{ EVAP_URL: 'http://data.bris.ac.uk/x' }, { EVAP_BBOX: '16,-35;id' }, { EVAP_DATASET: '$(id)' }]) {
		const r = run('evaporation-fetch.sh', ['2000', '2000'], { XDG_CACHE_HOME: '/nonexistent-cache', ...env });
		assert.equal(r.status, 2, JSON.stringify(env));
	}
});

test('every curl in the fetch scripts is HTTPS only, redirects included', () => {
	for (const script of ['tiles-dev.sh', 'evaporation-fetch.sh']) {
		const src = readFileSync(join(ROOT, 'bin', script), 'utf8');
		for (const line of src.split('\n').filter((l) => /(^|[\s(])curl\s/.test(l) && !/^\s*#/.test(l))) {
			// Local MinIO probes (http://localhost) are the one exception.
			if (/localhost|\$URL|\$TERRAIN_URL|\$WATER_URL|serves_/.test(line)) continue;
			assert.match(line, /--proto '=https' --proto-redir '=https'/, `${script}: ${line.trim()}`);
		}
	}
});
