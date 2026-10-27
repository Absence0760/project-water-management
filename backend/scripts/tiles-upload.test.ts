// The tile upload (tiles-upload.ts): the URLs it prints for the
// frontend (basemap, relief, glyphs), which files of a fonts directory become
// glyph objects (#326 A6): only `<fontstack>/<n>-<n+255>.pbf` and the licence;
// the env lines `dev:tiles:up` writes into the frontend's .env.development.local;
// and its provenance step (#604 R3-D): the archive's and the originals' SHA-256,
// one polite HEAD of the upstream (a 403 stops it), the originals kept under
// originals/<archive>/, the provenance file last in production, the sidecar a
// later upload of the same bytes reuses, against a fake S3.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTileProvenance, TILE_ARCHIVES } from '../src/geo/referenceOrigin.js';
import {
	executePlan,
	fontObjects,
	fontsDigest,
	glyphsUrl,
	hashFile,
	headUpstream,
	isRangeFile,
	originalKey,
	parseUploadArgs,
	planUpload,
	publicReadPolicy,
	REFERENCE_BUCKET,
	sidecarPath,
	terrainUrl,
	tilesEnv,
	tilesUrl,
	UpstreamRefused,
	USER_AGENT,
	withEnv,
	writeSidecar,
	type HeadFetch,
	type TileStore,
	type UploadArgs
} from './tiles-upload.js';

describe('tiles-upload', () => {
	it('prints localhost URLs for the tiles and the glyphs, braces kept for MapLibre', () => {
		expect(tilesUrl('http://127.0.0.1:9002/')).toBe('http://localhost:9002/tiles/south-africa.pmtiles');
		expect(glyphsUrl('http://127.0.0.1:9002')).toBe('http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf');
		expect(terrainUrl('http://127.0.0.1:9002')).toBe('http://localhost:9002/tiles/terrain.pmtiles');
	});

	it('lets anyone GET an object and nothing else', () => {
		expect(JSON.parse(publicReadPolicy()).Statement).toEqual([{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::tiles/*'] }]);
	});

	it('takes glyph ranges as MapLibre names them, and nothing else', () => {
		expect(isRangeFile('0-255.pbf')).toBe(true);
		expect(isRangeFile('65280-65535.pbf')).toBe(true);
		expect(isRangeFile('1-256.pbf')).toBe(false);
		expect(isRangeFile('0-511.pbf')).toBe(false);
		expect(isRangeFile('0-255.pbf.bak')).toBe(false);
	});

	it('uploads each font stack’s ranges and the licence, under fonts/, skipping stray files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-fonts-'));
		mkdirSync(join(dir, 'Noto Sans Regular'));
		mkdirSync(join(dir, 'Noto Sans Italic'));
		for (const f of ['0-255.pbf', '256-511.pbf', 'README.md']) writeFileSync(join(dir, 'Noto Sans Regular', f), 'x');
		writeFileSync(join(dir, 'Noto Sans Italic', '0-255.pbf'), 'x');
		writeFileSync(join(dir, 'OFL.txt'), 'licence');
		writeFileSync(join(dir, 'notes.txt'), 'stray');
		expect(fontObjects(dir).map((o) => [o.key, o.contentType])).toEqual([
			['fonts/Noto Sans Italic/0-255.pbf', 'application/x-protobuf'],
			['fonts/Noto Sans Regular/0-255.pbf', 'application/x-protobuf'],
			['fonts/Noto Sans Regular/256-511.pbf', 'application/x-protobuf'],
			['fonts/OFL.txt', 'text/plain; charset=utf-8']
		]);
	});

	it('sets the tiles URLs in an env file, keeping its other lines, and changes nothing the second time', () => {
		const vars = { PUBLIC_TILES_URL: 'http://localhost:9002/tiles/south-africa.pmtiles', PUBLIC_TILES_GLYPHS_URL: 'http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf' };
		const first = withEnv('# mine\nPUBLIC_API_URL=http://localhost:3001\nPUBLIC_TILES_URL=\n', vars);
		expect(first).toEqual({
			changed: true,
			text: '# mine\nPUBLIC_API_URL=http://localhost:3001\nPUBLIC_TILES_URL=http://localhost:9002/tiles/south-africa.pmtiles\nPUBLIC_TILES_GLYPHS_URL=http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf\n'
		});
		expect(withEnv(first.text, vars)).toEqual({ changed: false, text: first.text });
	});

	it('writes a new env file from nothing, and sets the last of a repeated key', () => {
		expect(withEnv('', { A: '1' })).toEqual({ changed: true, text: 'A=1\n' });
		expect(withEnv('A=0\nB=2\nA=9', { A: '1' }).text).toBe('A=0\nB=2\nA=1\n');
	});

	it('adds the relief URL to the env lines only when asked (the DEM is optional)', () => {
		expect(Object.keys(tilesEnv(false))).toEqual(['PUBLIC_TILES_URL', 'PUBLIC_TILES_GLYPHS_URL']);
		expect(tilesEnv(true)).toEqual({ ...tilesEnv(false), PUBLIC_TERRAIN_URL: terrainUrl() });
	});
});

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const TODAY = '2026-10-27';

/** A HEAD that answers `status` with an ETag and a Last-Modified, recording each call. */
function fakeHead(status = 200, headers: Record<string, string> = { etag: '"v1"', 'last-modified': 'Tue, 20 Oct 2026 08:00:00 GMT' }) {
	const calls: { url: string; ua: string }[] = [];
	const head: HeadFetch = async (url, init) => {
		calls.push({ url, ua: init.headers['user-agent']! });
		return { status, url, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
	};
	return { head, calls };
}

/** An S3 that keeps what is put, in order. */
function fakeStore() {
	const buckets: { bucket: string; publicRead: boolean }[] = [];
	const objects: { bucket: string; key: string; bytes: Buffer; contentType: string; cacheControl?: string }[] = [];
	const store: TileStore = {
		async ensureBucket(bucket, publicRead) {
			buckets.push({ bucket, publicRead });
		},
		async put(p) {
			const chunks: Buffer[] = [];
			if (Buffer.isBuffer(p.body)) chunks.push(p.body);
			else for await (const c of p.body) chunks.push(c as Buffer);
			objects.push({ bucket: p.bucket, key: p.key, bytes: Buffer.concat(chunks), contentType: p.contentType, cacheControl: p.cacheControl });
		}
	};
	return { store, buckets, objects };
}

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-tiles-'));
	const archive = join(dir, 'terrain.pmtiles');
	writeFileSync(archive, 'the terrain archive');
	const original = join(dir, 'planet extract.pmtiles');
	writeFileSync(original, 'the original download');
	return { dir, archive, original };
}

const args = (over: Partial<UploadArgs>): UploadArgs => ({ archive: 'terrain', path: '', production: null, version: null, upstream: null, originals: [], head: true, dryRun: false, ...over });

describe('tiles-upload: the provenance step', () => {
	it('parses the flags, resolving paths from where the command was typed, and refuses the wrong ones', () => {
		const env = { INIT_CWD: '/work' };
		expect(parseUploadArgs(['--terrain', 'terrain.pmtiles', '--version', '0.0.13', '--original', 'a.pmtiles', '--no-head', '--dry-run'], env)).toEqual({
			archive: 'terrain',
			path: '/work/terrain.pmtiles',
			production: null,
			version: '0.0.13',
			upstream: null,
			originals: ['/work/a.pmtiles'],
			head: false,
			dryRun: true
		});
		expect(parseUploadArgs(['--production', '--tiles-bucket', 'wm-tiles-1', '--reference-bucket', 'wm-reference-1', 'x.pmtiles'], env)).toMatchObject({
			archive: 'basemap',
			production: { tilesBucket: 'wm-tiles-1', referenceBucket: 'wm-reference-1' }
		});
		expect(parseUploadArgs(['--production', 'x.pmtiles'], env)).toMatch(/--tiles-bucket and --reference-bucket/);
		expect(parseUploadArgs(['--tiles-bucket', 'b-b-b', 'x.pmtiles'], env)).toMatch(/go with --production/);
		expect(parseUploadArgs(['x.pmtiles', '--upstream', 'http://example.com/x'], env)).toMatch(/https/);
		expect(parseUploadArgs(['x.pmtiles', '--version', 'a\nb'], env)).toMatch(/one line/);
		expect(parseUploadArgs(['x.pmtiles', '--version'], env)).toMatch(/needs a value/);
		expect(parseUploadArgs(['--terrain'], env)).toMatch(/name the archive/);
		expect(parseUploadArgs(['a', 'b'], env)).toMatch(/one archive/);
	});

	it('hashes a file as sha256sum does, and the fonts by their listing, wherever they sit', async () => {
		const { archive } = scratch();
		expect(await hashFile(archive)).toEqual({ sha256: sha('the terrain archive'), bytes: 19 });
		const a = mkdtempSync(join(tmpdir(), 'wm-fonts-a-'));
		const b = mkdtempSync(join(tmpdir(), 'wm-fonts-b-'));
		for (const d of [a, b]) {
			mkdirSync(join(d, 'Noto Sans Regular'));
			writeFileSync(join(d, 'Noto Sans Regular', '0-255.pbf'), 'glyphs');
			writeFileSync(join(d, 'OFL.txt'), 'licence');
		}
		const da = await fontsDigest(fontObjects(a));
		expect(da).toEqual({ sha256: sha(`fonts/Noto Sans Regular/0-255.pbf ${sha('glyphs')}\nfonts/OFL.txt ${sha('licence')}\n`), bytes: 13 });
		expect(await fontsDigest(fontObjects(b))).toEqual(da);
		writeFileSync(join(b, 'OFL.txt'), 'another licence');
		expect((await fontsDigest(fontObjects(b))).sha256).not.toBe(da.sha256);
	});

	it('names an original by its archive, then its version (else the day), then its file', () => {
		expect(originalKey('terrain', '/c/planet extract.pmtiles', '0.0.13', TODAY)).toBe('originals/terrain/0.0.13-planet-extract.pmtiles');
		expect(originalKey('water', '/c/occurrence_20E_30S_v1_5_2024.tif', null, TODAY)).toBe('originals/water/20261027-occurrence_20E_30S_v1_5_2024.tif');
		expect(originalKey('fonts', '/c/x.tar.gz', '../../etc', TODAY)).toMatch(/^originals\/fonts\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
	});

	it('asks the upstream once, politely, for its ETag and Last-Modified; a 403 stops it; another failure records them unknown', async () => {
		const ok = fakeHead();
		expect(await headUpstream('https://example.com/planet.pmtiles', ok.head)).toEqual({ etag: '"v1"', lastModified: '2026-10-20T08:00:00Z', note: null });
		expect(ok.calls).toEqual([{ url: 'https://example.com/planet.pmtiles', ua: USER_AGENT }]);
		const refused = fakeHead(403);
		await expect(headUpstream('https://example.com/x', refused.head)).rejects.toBeInstanceOf(UpstreamRefused);
		expect(refused.calls).toHaveLength(1);
		expect(await headUpstream('https://example.com/x', fakeHead(404).head)).toMatchObject({ etag: null, lastModified: null, note: expect.stringMatching(/404/) });
		const down: HeadFetch = async () => {
			throw new Error('ECONNRESET');
		};
		expect(await headUpstream('https://example.com/x', down)).toMatchObject({ etag: null, note: expect.stringMatching(/didn't answer/) });
	});

	it('locally: puts the archive in the tiles bucket and the originals in the reference bucket under originals/, and records what it hashed', async () => {
		const { archive, original } = scratch();
		const { head, calls } = fakeHead();
		const plan = await planUpload(args({ path: archive, version: '0.0.13', originals: [original] }), { head, today: TODAY });
		expect(calls.map((c) => c.url)).toEqual([TILE_ARCHIVES.terrain.upstream]);
		expect(plan.provenance).toEqual({
			archive: 'terrain',
			sha256: sha('the terrain archive'),
			bytes: 19,
			upstream: { url: TILE_ARCHIVES.terrain.upstream, version: '0.0.13', etag: '"v1"', lastModified: '2026-10-20T08:00:00Z' },
			originals: [{ key: 'originals/terrain/0.0.13-planet-extract.pmtiles', sha256: sha('the original download'), bytes: 21 }]
		});
		expect(plan.record).toBeNull();
		const s3 = fakeStore();
		await executePlan(plan, s3.store, { local: true });
		expect(s3.buckets).toEqual([
			{ bucket: 'tiles', publicRead: true },
			{ bucket: REFERENCE_BUCKET, publicRead: false }
		]);
		expect(s3.objects.map((o) => [o.bucket, o.key, o.bytes.toString()]).sort()).toEqual([
			['tiles', 'terrain.pmtiles', 'the terrain archive'],
			[REFERENCE_BUCKET, 'originals/terrain/0.0.13-planet-extract.pmtiles', 'the original download']
		]);
	});

	it('in production: tiles/ in the tiles bucket, originals/ in the reference bucket, and the provenance file last, its hash the load’s input', async () => {
		const { archive, original } = scratch();
		const plan = await planUpload(args({ path: archive, version: '0.0.13', originals: [original], production: { tilesBucket: 'wm-tiles', referenceBucket: 'wm-reference' } }), {
			head: fakeHead().head,
			today: TODAY
		});
		expect(plan.record?.key).toBe('reference/tiles/terrain-20261027.json');
		const s3 = fakeStore();
		await executePlan(plan, s3.store, { local: false });
		expect(s3.buckets).toEqual([]);
		const put = s3.objects.map((o) => [o.bucket, o.key, o.cacheControl]);
		expect(put.slice(0, 2)).toEqual(
			expect.arrayContaining([
				['wm-tiles', 'tiles/terrain.pmtiles', 'public, max-age=86400'],
				['wm-reference', 'originals/terrain/0.0.13-planet-extract.pmtiles', undefined]
			])
		);
		// Last, once the files it names are there.
		expect(put[2]).toEqual(['wm-reference', 'reference/tiles/terrain-20261027.json', undefined]);
		const file = s3.objects.at(-1)!.bytes;
		expect(sha(file)).toBe(plan.record!.sha256);
		// The file is what the `tiles` load parses, and says what was planned.
		expect(parseTileProvenance(JSON.parse(file.toString()))).toEqual(plan.provenance);
	});

	it('with --no-head asks nothing, and the upstream is the archive’s own (the basemap’s names its build)', async () => {
		const { dir } = scratch();
		const basemap = join(dir, 'south-africa.pmtiles');
		writeFileSync(basemap, 'tiles');
		const { head, calls } = fakeHead();
		const plan = await planUpload(args({ archive: 'basemap', path: basemap, version: '20261026', head: false }), { head, today: TODAY });
		expect(calls).toEqual([]);
		expect(plan.provenance.upstream).toEqual({ url: 'https://build.protomaps.com/20261026.pmtiles', version: '20261026', etag: null, lastModified: null });
		expect(plan.notes).toContainEqual(expect.stringMatching(/no original download kept/));
	});

	it('a 403 from the upstream stops the plan before anything is uploaded', async () => {
		const { archive } = scratch();
		await expect(planUpload(args({ path: archive, version: '0.0.13' }), { head: fakeHead(403).head, today: TODAY })).rejects.toBeInstanceOf(UpstreamRefused);
	});

	it('a later upload of the same bytes reuses the sidecar without asking again; changed bytes don’t', async () => {
		const { archive, original } = scratch();
		const first = await planUpload(args({ path: archive, version: '0.0.13', originals: [original] }), { head: fakeHead().head, today: TODAY });
		writeSidecar(args({ path: archive }), first.provenance, first.originalPaths);
		expect(existsSync(sidecarPath(archive))).toBe(true);
		const again = fakeHead();
		const second = await planUpload(args({ path: archive }), { head: again.head, today: TODAY });
		expect(again.calls).toEqual([]);
		expect(second.provenance).toEqual(first.provenance);
		expect(second.puts.map((p) => p.key)).toContain('originals/terrain/0.0.13-planet-extract.pmtiles');
		writeFileSync(archive, 'a different build');
		const unasked = fakeHead();
		const third = await planUpload(args({ path: archive }), { head: unasked.head, today: TODAY });
		expect(third.provenance.upstream.version).toBeNull();
		// No version or file named: nothing to ask the upstream about this download.
		expect(unasked.calls).toEqual([]);
		expect(JSON.parse(readFileSync(sidecarPath(archive), 'utf8')).sha256).toBe(sha('the terrain archive'));
	});

	it('the fonts: every glyph file under tiles/fonts/ in production, a week’s cache, and their listing’s digest recorded', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-fonts-'));
		mkdirSync(join(dir, 'Noto Sans Regular'));
		writeFileSync(join(dir, 'Noto Sans Regular', '0-255.pbf'), 'glyphs');
		writeFileSync(join(dir, 'OFL.txt'), 'licence');
		const ref = 'a'.repeat(40);
		const plan = await planUpload(args({ archive: 'fonts', path: dir, version: ref, production: { tilesBucket: 'wm-tiles', referenceBucket: 'wm-reference' } }), {
			head: fakeHead().head,
			today: TODAY
		});
		expect(plan.puts.filter((p) => p.bucket === 'wm-tiles').map((p) => [p.key, p.cacheControl])).toEqual([
			['tiles/fonts/Noto Sans Regular/0-255.pbf', 'public, max-age=604800'],
			['tiles/fonts/OFL.txt', 'public, max-age=604800']
		]);
		expect(plan.provenance.sha256).toBe((await fontsDigest(fontObjects(dir))).sha256);
		expect(plan.provenance.upstream.url).toBe(`https://codeload.github.com/protomaps/basemaps-assets/tar.gz/${ref}`);
	});
});

