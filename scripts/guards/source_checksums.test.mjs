// The downloaded map sources' SHA-256 check (source_checksums.mjs) and its use
// in the operator fetch scripts. Nothing is downloaded: the scripts run with
// a stub curl on PATH that writes a few bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSource, DEFAULT_MANIFEST, parseManifest } from './source_checksums.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const tmp = mkdtempSync(join(tmpdir(), 'wm-source-checksums-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = () => {
	const d = join(tmp, String(n++));
	mkdirSync(d);
	return d;
};

test('parseManifest reads sha256sum lines and comments, and refuses anything else', () => {
	const m = parseManifest(`# a comment\n\n${'a'.repeat(64)}  one.zip\n${'b'.repeat(64)} *two.tif\n`);
	assert.deepEqual([...m], [
		['one.zip', 'a'.repeat(64)],
		['two.tif', 'b'.repeat(64)]
	]);
	assert.throws(() => parseManifest(`${'a'.repeat(63)}  short.zip\n`), /line 1/);
	assert.throws(() => parseManifest(`${'a'.repeat(64)}  ../escape\n`), /line 1/);
	assert.throws(() => parseManifest(`${'a'.repeat(64)}  x.zip\n${'b'.repeat(64)}  x.zip\n`), /listed twice/);
});

test('a file matching its entry passes and stays put (positive control)', async () => {
	const d = dir();
	const file = join(d, 'one.zip');
	writeFileSync(file, 'the real bytes');
	const manifest = join(d, 'm.sha256');
	writeFileSync(manifest, `${sha('the real bytes')}  one.zip\n`);
	const r = await checkSource(file, 'one.zip', manifest);
	assert.equal(r.status, 'ok');
	assert.ok(existsSync(file));
});

test('a mismatch is reported and the file moved aside, so a re-run does not use it', async () => {
	const d = dir();
	const file = join(d, 'one.zip');
	writeFileSync(file, 'tampered bytes');
	const manifest = join(d, 'm.sha256');
	writeFileSync(manifest, `${sha('the real bytes')}  one.zip\n`);
	const r = await checkSource(file, 'one.zip', manifest);
	assert.equal(r.status, 'mismatch');
	assert.equal(r.expected, sha('the real bytes'));
	assert.equal(r.actual, sha('tampered bytes'));
	assert.ok(!existsSync(file));
	assert.ok(existsSync(`${file}.mismatch`));
	assert.equal(readFileSync(manifest, 'utf8'), `${sha('the real bytes')}  one.zip\n`, 'the manifest is not rewritten');
});

test('a file not yet listed is recorded on first use, then held to it', async () => {
	const d = dir();
	const manifest = join(d, 'm.sha256');
	writeFileSync(manifest, '# no trailing newline');
	const file = join(d, '1991_daily_pet.nc');
	writeFileSync(file, 'year one');
	assert.equal((await checkSource(file, undefined, manifest)).status, 'recorded');
	assert.equal(readFileSync(manifest, 'utf8'), `# no trailing newline\n${sha('year one')}  1991_daily_pet.nc\n`);
	assert.equal((await checkSource(file, undefined, manifest)).status, 'ok');
	writeFileSync(file, 'year one, re-issued');
	assert.equal((await checkSource(file, undefined, manifest)).status, 'mismatch');
});

test('a name that is not a plain file name is refused', async () => {
	const d = dir();
	const file = join(d, 'x');
	writeFileSync(file, 'x');
	await assert.rejects(checkSource(file, '../x', join(d, 'm')), /plain file name/);
});

test('the committed manifest parses and pins the default sources', () => {
	const m = parseManifest(readFileSync(DEFAULT_MANIFEST, 'utf8'));
	assert.ok(m.has('HydroRIVERS_v10_af_shp.zip'));
	for (const t of ['10E_20S', '10E_30S', '20E_20S', '20E_30S', '30E_20S', '30E_30S']) assert.ok(m.has(`occurrence_${t}_v1_5_2024.tif`), t);
	// The label fonts' archive, at the commit tiles-dev.sh pins.
	const ref = readFileSync(join(ROOT, 'bin', 'tiles-dev.sh'), 'utf8').match(/^FONTS_REF="\$\{TILES_FONTS_REF:-([0-9a-f]{40})\}"/m)?.[1];
	assert.ok(ref, 'FONTS_REF in tiles-dev.sh');
	assert.ok(m.has(`basemaps-assets-${ref}.tar.gz`), 'the pinned fonts commit has a SHA-256');
});

// The scripts, end to end, with stubs on PATH: curl writes `body` to its -o
// file; the next step (unzip for rivers, the tsx reducer via pnpm for
// evaporation) exits 42, so reaching it means the check passed.
function stubs(body) {
	const bin = dir();
	const write = (name, text) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${text}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	write('curl', `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then printf %s ${JSON.stringify(body)} > "$2"; shift; fi; shift; done`);
	write('ogr2ogr', 'exit 0');
	write('unzip', 'echo "unzip reached" >&2; exit 42');
	write('pnpm', 'echo "reducer reached" >&2; exit 42');
	write('tar', 'echo "tar reached" >&2; exit 42');
	return bin;
}
const run = (script, args, body, manifestText) => {
	const cache = dir();
	const manifest = join(cache, 'm.sha256');
	writeFileSync(manifest, manifestText);
	const r = spawnSync('bash', [join(ROOT, 'bin', script), ...args], {
		env: { PATH: `${stubs(body)}:${process.env.PATH}`, HOME: process.env.HOME, XDG_CACHE_HOME: cache, SOURCE_CHECKSUMS: manifest },
		encoding: 'utf8'
	});
	return { ...r, cache, manifest };
};

test('tiles-dev.sh rivers stops on a tampered zip before unpacking it', () => {
	const r = run('tiles-dev.sh', ['rivers'], 'tampered', `${sha('the real zip')}  HydroRIVERS_v10_af_shp.zip\n`);
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, /HydroRIVERS_v10_af_shp\.zip: SHA-256 MISMATCH/);
	assert.doesNotMatch(r.stderr, /unzip reached/);
	assert.ok(existsSync(join(r.cache, 'water-management-tiles', 'HydroRIVERS_v10_af_shp.zip.mismatch')));
});

test('tiles-dev.sh rivers goes on with a matching zip (positive control)', () => {
	const r = run('tiles-dev.sh', ['rivers'], 'the real zip', `${sha('the real zip')}  HydroRIVERS_v10_af_shp.zip\n`);
	assert.equal(r.status, 42, r.stderr);
	assert.match(r.stderr, /unzip reached/);
});

const FONTS_TGZ = 'basemaps-assets-028c18f713baecad011301ff7a69acc39bcc2ae7.tar.gz';

test('tiles-dev.sh fonts stops on a tampered fonts archive before unpacking it', () => {
	const r = run('tiles-dev.sh', ['fonts'], 'tampered', `${sha('the real fonts')}  ${FONTS_TGZ}\n`);
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stderr, new RegExp(`${FONTS_TGZ.replace(/\./g, '\\.')}: SHA-256 MISMATCH`));
	assert.doesNotMatch(r.stderr, /tar reached/);
	assert.ok(existsSync(join(r.cache, 'water-management-tiles', `${FONTS_TGZ}.mismatch`)));
});

test('tiles-dev.sh fonts goes on with a matching fonts archive (positive control)', () => {
	const r = run('tiles-dev.sh', ['fonts'], 'the real fonts', `${sha('the real fonts')}  ${FONTS_TGZ}\n`);
	assert.equal(r.status, 42, r.stderr);
	assert.match(r.stderr, /tar reached/);
});

test('evaporation-fetch.sh records a year on first fetch, then stops on a changed one', () => {
	const first = run('evaporation-fetch.sh', ['2000', '2000'], 'year 2000', '');
	assert.equal(first.status, 42, first.stderr);
	assert.equal(readFileSync(first.manifest, 'utf8'), `${sha('year 2000')}  2000_daily_pet.nc\n`);
	const changed = run('evaporation-fetch.sh', ['2000', '2000'], 'year 2000, changed', `${sha('year 2000')}  2000_daily_pet.nc\n`);
	assert.equal(changed.status, 1, changed.stderr);
	assert.match(changed.stderr, /2000_daily_pet\.nc: SHA-256 MISMATCH/);
	assert.doesNotMatch(changed.stderr, /reducer reached/);
});
