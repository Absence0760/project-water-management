// Upload a map tile archive and record where it came from (issue #288,
// #604 R3-D; docs/maps.md § Basemap, docs/deployment.md § Map tiles and §
// Reference datasets). bin/tiles-dev.sh runs it after each fetch:
//
//   tsx scripts/tiles-upload.ts [--terrain | --water | --fonts] <file.pmtiles | dir> [provenance flags]
//   tsx scripts/tiles-upload.ts --production --tiles-bucket <b> --reference-bucket <r> [--terrain | --water | --fonts] <path> [provenance flags]
//   tsx scripts/tiles-upload.ts --env <file> [--terrain]
//
// The archives (TILE_ARCHIVES, geo/referenceOrigin.ts): the basemap
// (`south-africa.pmtiles`), the relief's DEM (--terrain, `terrain.pmtiles`,
// docs/maps.md § Relief), tracing a dam's water occurrence (--water,
// `water.pmtiles`, the backend's WATER_URL; docs/maps.md § Assisted drawing),
// and the labels' glyph ranges (--fonts <dir>: every `<fontstack>/<range>.pbf`
// under <dir> to `fonts/<fontstack>/<range>.pbf`, with the font licence,
// OFL.txt, beside them; docs/maps.md § Labels).
//
// Provenance flags (docs/deployment.md § Reference datasets, Refreshing a dataset):
//   --version <v>       the upstream's version: a build date, a commit, a release
//   --upstream <url>    the upstream file (default: the archive's, TILE_ARCHIVES)
//   --original <file>   an original download to keep (repeatable): uploaded to
//                       the reference bucket as originals/<archive>/<version>-<file>
//   --no-head           don't ask the upstream for its ETag and Last-Modified
//                       (asked only with --version or --upstream)
//   --dry-run           upload and record nothing: print what would be
//
// Each upload hashes the archive (SHA-256; the fonts: of their listing) and,
// unless --no-head, makes one HEAD request of the upstream (one descriptive
// User-Agent; a 403 stops before anything is uploaded, never retried). What
// it learns is kept beside the file as `<path>.provenance.json`, so a later
// upload of the same bytes (`pnpm dev:tiles:up` re-uploading a cached file)
// records the same provenance without the flags.
//
// Locally (the default) it uploads to MinIO (`tiles`, public-read, as the map
// reads it by HTTP Range; originals to the private `reference` bucket) and
// records the provenance in this checkout's dev database as the schema owner
// (reference_load, kind 'tiles'). It refuses STORAGE=s3.
//
// With --production it uploads with your own AWS session (AWS_PROFILE; no
// workflow or Lambda can write these buckets) to the tiles bucket under
// tiles/ and the reference bucket under originals/, writes the provenance
// file to reference/tiles/<archive>-<date>.json, and prints the
// load-reference.yml run that records it (the database is in a private VPC)
// and the CloudFront invalidation. **An upload is itself the release** of
// the archive (docs/deployment.md § Map tiles): mind the licence step first.
//
// With --env it uploads nothing: it sets PUBLIC_TILES_URL and
// PUBLIC_TILES_GLYPHS_URL (and, with a trailing --terrain, PUBLIC_TERRAIN_URL)
// in <file> (the frontend's gitignored .env.development.local; `pnpm
// dev:tiles:up`), keeping every other line, and prints whether it changed.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import pg from 'pg';
import { loadDevEnv } from '../src/config/devEnv.js';
import {
	recordTileProvenance,
	TILE_ARCHIVES,
	tileProvenanceFile,
	type OriginalFile,
	type TileArchive,
	type TileProvenance,
	type Upstream
} from '../src/geo/referenceOrigin.js';

export const TILES_BUCKET = 'tiles';
/** The local MinIO bucket that stands in for the reference bucket (private: no policy). */
export const REFERENCE_BUCKET = 'water-reference';
export const TILES_KEY = 'south-africa.pmtiles';
/** The relief's elevation tiles (Terrarium PMTiles). */
export const TERRAIN_KEY = 'terrain.pmtiles';
/** The water occurrence tracing a dam reads (Terrarium PMTiles; the API reads it, not the browser). */
export const WATER_KEY = 'water.pmtiles';
/** Where the glyph ranges go in the bucket. */
export const FONTS_PREFIX = 'fonts';

/** One descriptive User-Agent for the HEAD of an upstream (docs/data-sources.md § The polite-client checklist). */
export const USER_AGENT = 'water-management-tiles-upload/1 (+https://github.com/Absence0760/project-water-management)';

/** The largest object one PutObject takes; past it, use `aws s3 cp` (multipart) and record with --dry-run's file. */
export const MAX_PUT_BYTES = 5 * 1024 ** 3;

/** The bucket policy: anyone may GET an object (Range reads included), nothing else. */
export function publicReadPolicy(bucket = TILES_BUCKET): string {
	return JSON.stringify({
		Version: '2012-10-17',
		Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }]
	});
}

const base = (endpoint: string) => `${endpoint.replace('127.0.0.1', 'localhost').replace(/\/$/, '')}/${TILES_BUCKET}`;

/** The URL the frontend reads (PUBLIC_TILES_URL), from the MinIO endpoint. */
export const tilesUrl = (endpoint = process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002') => `${base(endpoint)}/${TILES_KEY}`;

/** The relief's URL the frontend reads (PUBLIC_TERRAIN_URL), from the MinIO endpoint. */
export const terrainUrl = (endpoint = process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002') => `${base(endpoint)}/${TERRAIN_KEY}`;

/** The glyphs URL template the frontend reads (PUBLIC_TILES_GLYPHS_URL), from the MinIO endpoint. */
export const glyphsUrl = (endpoint = process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002') => `${base(endpoint)}/${FONTS_PREFIX}/{fontstack}/{range}.pbf`;

/** A glyph range's file name, as MapLibre asks for it: `0-255.pbf`, 256 code points from a multiple of 256. */
export function isRangeFile(name: string): boolean {
	const m = /^(\d+)-(\d+)\.pbf$/.exec(name);
	return !!m && Number(m[1]) % 256 === 0 && Number(m[2]) === Number(m[1]) + 255 && Number(m[2]) <= 65535;
}

/**
 * The objects a fonts directory uploads as: each `<fontstack>/<range>.pbf`
 * (a font stack is a directory directly under `dir`), and the licence file
 * at the top. Anything else is left out, so a stray file never reaches the bucket.
 */
export function fontObjects(dir: string): { path: string; key: string; contentType: string }[] {
	const out: { path: string; key: string; contentType: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isFile() && entry.name === 'OFL.txt') out.push({ path: join(dir, entry.name), key: `${FONTS_PREFIX}/OFL.txt`, contentType: 'text/plain; charset=utf-8' });
		if (!entry.isDirectory()) continue;
		for (const f of readdirSync(join(dir, entry.name)).sort()) {
			if (isRangeFile(f)) out.push({ path: join(dir, entry.name, f), key: `${FONTS_PREFIX}/${entry.name}/${f}`, contentType: 'application/x-protobuf' });
		}
	}
	return out;
}

/**
 * `text` (an env file) with each of `vars` set: a line `KEY=…` (the last, if
 * repeated) gets the value, a missing key is appended, every other line is kept.
 */
export function withEnv(text: string, vars: Record<string, string>): { text: string; changed: boolean } {
	const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
	for (const [key, value] of Object.entries(vars)) {
		let at = -1;
		lines.forEach((l, i) => {
			if (l.replace(/^\s*(export\s+)?/, '').startsWith(`${key}=`)) at = i;
		});
		if (at >= 0) lines[at] = `${key}=${value}`;
		else lines.push(`${key}=${value}`);
	}
	const out = lines.length ? `${lines.join('\n')}\n` : '';
	return { text: out, changed: out !== text };
}

/**
 * The frontend's env lines for the local map. The relief's DEM is optional and
 * large (dev:tiles:terrain), so its URL is included only with `terrain`
 * (bin/tiles-dev.sh up passes it when MinIO serves the DEM).
 */
export function tilesEnv(terrain: boolean): Record<string, string> {
	const vars: Record<string, string> = { PUBLIC_TILES_URL: tilesUrl(), PUBLIC_TILES_GLYPHS_URL: glyphsUrl() };
	if (terrain) vars.PUBLIC_TERRAIN_URL = terrainUrl();
	return vars;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface UploadArgs {
	archive: TileArchive;
	/** The archive file, or the fonts directory. */
	path: string;
	production: { tilesBucket: string; referenceBucket: string } | null;
	version: string | null;
	upstream: string | null;
	originals: string[];
	head: boolean;
	dryRun: boolean;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The upload's arguments, paths resolved from the folder the command was typed in; a string is the problem. */
export function parseUploadArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): UploadArgs | string {
	const cwd = env.INIT_CWD ?? process.cwd();
	let archive: TileArchive = 'basemap';
	let path: string | null = null;
	let tilesBucket: string | null = null;
	let referenceBucket: string | null = null;
	let production = false;
	let version: string | null = null;
	let upstream: string | null = null;
	const originals: string[] = [];
	let head = true;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const value = () => {
			const v = argv[++i];
			if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
			return v;
		};
		try {
			if (a === '--terrain') archive = 'terrain';
			else if (a === '--water') archive = 'water';
			else if (a === '--fonts') archive = 'fonts';
			else if (a === '--production') production = true;
			else if (a === '--tiles-bucket') tilesBucket = value();
			else if (a === '--reference-bucket') referenceBucket = value();
			else if (a === '--version') version = value();
			else if (a === '--upstream') upstream = value();
			else if (a === '--original') originals.push(resolve(cwd, value()));
			else if (a === '--no-head') head = false;
			else if (a === '--dry-run') dryRun = true;
			else if (a.startsWith('--')) return `unknown flag ${a}`;
			else if (path === null) path = resolve(cwd, a);
			else return 'one archive (or fonts directory) at a time';
		} catch (e) {
			return (e as Error).message;
		}
	}
	if (!path) return 'name the archive (or the fonts directory)';
	if (version !== null && (version.length > 100 || /[\u0000-\u001f]/.test(version) || !version.trim())) return '--version is one line of at most 100 characters';
	if (upstream !== null && !/^https:\/\/[^\s]{1,490}$/.test(upstream)) return '--upstream is an https:// URL';
	if (production) {
		if (!tilesBucket || !referenceBucket) return '--production needs --tiles-bucket and --reference-bucket (terraform output tiles_bucket, reference_bucket)';
		if (!BUCKET.test(tilesBucket) || !BUCKET.test(referenceBucket)) return 'a bucket name is 3–63 lower-case letters, digits, dots and dashes';
	} else if (tilesBucket || referenceBucket) return '--tiles-bucket and --reference-bucket go with --production';
	return { archive, path, production: production ? { tilesBucket: tilesBucket!, referenceBucket: referenceBucket! } : null, version, upstream, originals, head, dryRun };
}

/** A file's SHA-256 and size, read as a stream (an archive is gigabytes). */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
	const h = createHash('sha256');
	let bytes = 0;
	for await (const chunk of createReadStream(path)) {
		h.update(chunk as Buffer);
		bytes += (chunk as Buffer).byteLength;
	}
	return { sha256: h.digest('hex'), bytes };
}

/**
 * The fonts' digest: the SHA-256 of their listing, one `<key> <sha256>` line
 * per file in key order, so the same glyphs hash the same wherever they sit.
 */
export async function fontsDigest(objects: { path: string; key: string }[]): Promise<{ sha256: string; bytes: number }> {
	const lines: string[] = [];
	let bytes = 0;
	for (const o of [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
		const f = await hashFile(o.path);
		lines.push(`${o.key} ${f.sha256}\n`);
		bytes += f.bytes;
	}
	return { sha256: createHash('sha256').update(lines.join('')).digest('hex'), bytes };
}

/** A version or date as a key's prefix: letters, digits, dots, dashes and underscores only. */
const keyPart = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'x';

/** Where an original download is kept: originals/<archive>/<version, else the day>-<its file name>. */
export function originalKey(archive: TileArchive, file: string, version: string | null, today: string): string {
	const name = keyPart(basename(file)).slice(0, 120);
	return `originals/${archive}/${keyPart(version ?? today.replace(/-/g, ''))}-${name}`;
}

/** The upstream URL to ask: the flag, else the archive's own (the basemap's names its build: <date>.pmtiles). */
export function upstreamUrl(archive: TileArchive, given: string | null, version: string | null): string {
	if (given) return given;
	if (archive === 'basemap' && version && /^\d{8}$/.test(version)) return `https://build.protomaps.com/${version}.pmtiles`;
	if (archive === 'fonts' && version && /^[0-9a-f]{40}$/.test(version)) return `${TILE_ARCHIVES.fonts.upstream}${version}`;
	return TILE_ARCHIVES[archive].upstream;
}

export type HeadFetch = (url: string, init: { method: 'HEAD'; headers: Record<string, string>; redirect: 'follow' }) => Promise<{ status: number; url: string; headers: { get(name: string): string | null } }>;

/** The upstream refused us: the run stops before uploading anything, and is not retried. */
export class UpstreamRefused extends Error {}

/**
 * One HEAD of the upstream for its ETag and Last-Modified. A 403 throws
 * (UpstreamRefused); any other failure records them unknown, with a note.
 */
export async function headUpstream(url: string, fetchFn: HeadFetch = fetch as unknown as HeadFetch): Promise<{ etag: string | null; lastModified: string | null; note: string | null }> {
	let res;
	try {
		res = await fetchFn(url, { method: 'HEAD', headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
	} catch (e) {
		return { etag: null, lastModified: null, note: `the upstream didn't answer (${(e as Error).message}): ETag and Last-Modified not recorded` };
	}
	if (res.status === 403) throw new UpstreamRefused(`${url} answered 403: the upstream refuses us. Stopped before uploading; don't retry, find out why (docs/data-sources.md § The rule).`);
	if (!res.url.startsWith('https://')) return { etag: null, lastModified: null, note: 'the upstream redirected off HTTPS: ETag and Last-Modified not recorded' };
	if (res.status < 200 || res.status > 299) return { etag: null, lastModified: null, note: `the upstream answered ${res.status}: ETag and Last-Modified not recorded` };
	const etag = res.headers.get('etag')?.trim() || null;
	const lm = res.headers.get('last-modified');
	const t = lm ? Date.parse(lm) : NaN;
	return {
		etag: etag && etag.length <= 200 && !/[\u0000-\u001f]/.test(etag) ? etag : null,
		lastModified: Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.000Z$/, 'Z'),
		note: null
	};
}

/** The sidecar a file's provenance is kept in, beside it: `<path>.provenance.json`. */
export const sidecarPath = (path: string) => `${path.replace(/\/+$/, '')}.provenance.json`;

/** A sidecar's provenance when it describes these bytes (same archive and hash), else null. */
export function readSidecar(path: string, archive: TileArchive, sha256: string): (TileProvenance & { originalPaths?: string[] }) | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(sidecarPath(path), 'utf8'));
	} catch {
		return null;
	}
	const p = raw as TileProvenance & { originalPaths?: string[] };
	return p && p.archive === archive && p.sha256 === sha256 && p.upstream && Array.isArray(p.originals) ? p : null;
}

/** One object to put. */
export interface Put {
	bucket: string;
	key: string;
	/** A local file, or bytes (the provenance file). */
	from: { path: string } | { bytes: Buffer };
	bytes: number;
	contentType: string;
	cacheControl?: string;
}

export interface UploadPlan {
	provenance: TileProvenance;
	/** The local files kept as originals (the sidecar remembers them for the next upload). */
	originalPaths: string[];
	puts: Put[];
	/** Production: the provenance file's key and SHA-256 in the reference bucket (load-reference.yml's inputs). */
	record: { key: string; sha256: string } | null;
	notes: string[];
}

export interface PlanDeps {
	head?: HeadFetch;
	/** `YYYY-MM-DD` (UTC): the day an original without a version is named by. */
	today?: string;
}

/**
 * What an upload puts where, and the provenance it records. Reads and hashes
 * the files and (unless --no-head) asks the upstream once; uploads nothing.
 */
export async function planUpload(args: UploadArgs, deps: PlanDeps = {}): Promise<UploadPlan> {
	const today = deps.today ?? new Date().toISOString().slice(0, 10);
	const notes: string[] = [];
	const prod = args.production;
	const tilesBucket = prod ? prod.tilesBucket : TILES_BUCKET;
	const referenceBucket = prod ? prod.referenceBucket : REFERENCE_BUCKET;
	// Production serves the archives under tiles/ (the site's /tiles/*); MinIO's bucket is itself named tiles.
	const tileKey = (key: string) => (prod ? `tiles/${key}` : key);
	const puts: Put[] = [];
	let digest: { sha256: string; bytes: number };
	if (args.archive === 'fonts') {
		const objects = fontObjects(args.path);
		if (!objects.some((o) => o.key.endsWith('.pbf'))) throw new Error(`No glyph ranges (<fontstack>/<n>-<n+255>.pbf) under ${args.path}.`);
		for (const o of objects)
			puts.push({ bucket: tilesBucket, key: tileKey(o.key), from: { path: o.path }, bytes: statSync(o.path).size, contentType: o.contentType, cacheControl: prod ? 'public, max-age=604800' : undefined });
		digest = await fontsDigest(objects);
	} else {
		const key = TILE_ARCHIVES[args.archive].key.replace(/^tiles\//, '');
		digest = await hashFile(args.path);
		if (digest.bytes > MAX_PUT_BYTES) throw new Error(`${args.path} is over 5 GiB, more than one PutObject takes: upload it with aws s3 cp (multipart).`);
		puts.push({ bucket: tilesBucket, key: tileKey(key), from: { path: args.path }, bytes: digest.bytes, contentType: 'application/vnd.pmtiles', cacheControl: prod ? 'public, max-age=86400' : undefined });
	}
	// The flags win; else a sidecar that describes these very bytes; else unknown.
	const flagged = args.version !== null || args.upstream !== null || args.originals.length > 0;
	const kept = flagged ? null : readSidecar(args.path, args.archive, digest.sha256);
	let upstream: Upstream;
	let originalPaths: string[];
	if (kept) {
		notes.push(`provenance from ${sidecarPath(args.path)} (the same bytes as last time)`);
		upstream = kept.upstream;
		originalPaths = (kept.originalPaths ?? []).filter((path) => {
			const there = existsSync(path);
			if (!there) notes.push(`the original ${path} is gone: not kept this time`);
			return there;
		});
	} else {
		const url = upstreamUrl(args.archive, args.upstream, args.version);
		upstream = { url, version: args.version, etag: null, lastModified: null };
		// Asked only when the operator named the version or the file: a HEAD of a bare default says nothing about this download.
		if (args.head && (args.version !== null || args.upstream !== null)) {
			const h = await headUpstream(url, deps.head);
			if (h.note) notes.push(h.note);
			upstream = { ...upstream, etag: h.etag, lastModified: h.lastModified };
		}
		originalPaths = args.originals;
	}
	const originals: OriginalFile[] = [];
	for (const path of originalPaths) {
		const f = await hashFile(path);
		if (f.bytes > MAX_PUT_BYTES) throw new Error(`${path} is over 5 GiB: keep it with aws s3 cp (multipart).`);
		const key = originalKey(args.archive, path, upstream.version, today);
		if (originals.some((o) => o.key === key)) throw new Error(`two originals would be kept as ${key}: rename one`);
		originals.push({ key, sha256: f.sha256, bytes: f.bytes });
		puts.push({ bucket: referenceBucket, key, from: { path }, bytes: f.bytes, contentType: 'application/octet-stream' });
	}
	const provenance: TileProvenance = { archive: args.archive, sha256: digest.sha256, bytes: digest.bytes, upstream, originals };
	let record: UploadPlan['record'] = null;
	if (prod) {
		const bytes = Buffer.from(`${JSON.stringify(tileProvenanceFile(provenance), null, 2)}\n`);
		record = { key: `reference/tiles/${args.archive}-${today.replace(/-/g, '')}.json`, sha256: createHash('sha256').update(bytes).digest('hex') };
		puts.push({ bucket: referenceBucket, key: record.key, from: { bytes }, bytes: bytes.byteLength, contentType: 'application/json' });
	}
	if (!originals.length) notes.push('no original download kept (--original <file>): the dataset can be re-derived only from the upstream');
	return { provenance, originalPaths, puts, record, notes };
}

/** The S3 calls an upload makes (a fake in the tests). */
export interface TileStore {
	/** Make the bucket if missing; `publicRead` sets the read-anyone policy (local MinIO's tiles bucket only). */
	ensureBucket(bucket: string, publicRead: boolean): Promise<void>;
	put(p: { bucket: string; key: string; body: Readable | Buffer; bytes: number; contentType: string; cacheControl?: string }): Promise<void>;
}

/** Put every object of the plan, a few at a time (hundreds of glyph files; MinIO on a laptop). */
export async function executePlan(plan: UploadPlan, store: TileStore, opts: { local: boolean }): Promise<void> {
	if (opts.local) {
		await store.ensureBucket(TILES_BUCKET, true);
		if (plan.puts.some((p) => p.bucket === REFERENCE_BUCKET)) await store.ensureBucket(REFERENCE_BUCKET, false);
	}
	// The archive and the originals first; the provenance file alone after them, so it never names a file that isn't there yet.
	const put = (p: Put) =>
		store.put({
			bucket: p.bucket,
			key: p.key,
			body: 'path' in p.from ? createReadStream(p.from.path) : p.from.bytes,
			bytes: p.bytes,
			contentType: p.contentType,
			cacheControl: p.cacheControl
		});
	const isRecord = (p: Put) => p.key === plan.record?.key;
	const first = plan.puts.filter((p) => !isRecord(p));
	for (let i = 0; i < first.length; i += 16) await Promise.all(first.slice(i, i + 16).map(put));
	for (const p of plan.puts.filter(isRecord)) await put(p);
}

/** The provenance as the operator reads it. */
export function describeProvenance(p: TileProvenance): string {
	const u = p.upstream;
	return [
		`${p.archive} (${TILE_ARCHIVES[p.archive].key}): SHA-256 ${p.sha256}, ${p.bytes} bytes`,
		`  upstream ${u.url ?? 'unknown'}, version ${u.version ?? 'unknown'}, ETag ${u.etag ?? 'unknown'}, Last-Modified ${u.lastModified ?? 'unknown'}`,
		`  licence ${TILE_ARCHIVES[p.archive].licence}`,
		...p.originals.map((o) => `  original ${o.key}: SHA-256 ${o.sha256}, ${o.bytes} bytes`)
	].join('\n');
}

/** Keep the provenance beside the file, for the next upload of the same bytes. */
export function writeSidecar(args: UploadArgs, p: TileProvenance, originalPaths: string[]): void {
	writeFileSync(sidecarPath(args.path), `${JSON.stringify({ ...p, originalPaths }, null, 2)}\n`);
}

function s3Store(sdk: typeof import('@aws-sdk/client-s3'), s3: InstanceType<typeof import('@aws-sdk/client-s3').S3Client>): TileStore {
	return {
		async ensureBucket(bucket, publicRead) {
			try {
				await s3.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
			} catch {
				await s3.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
			}
			if (publicRead) await s3.send(new sdk.PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
		},
		async put(p) {
			await s3.send(new sdk.PutObjectCommand({ Bucket: p.bucket, Key: p.key, Body: p.body, ContentLength: p.bytes, ContentType: p.contentType, CacheControl: p.cacheControl }));
		}
	};
}

async function main(argv: string[]): Promise<number> {
	if (argv[0] === '--env') {
		if (!argv[1]) {
			console.error('usage: tsx scripts/tiles-upload.ts --env <file> [--terrain]');
			return 2;
		}
		const path = resolve(process.env.INIT_CWD ?? process.cwd(), argv[1]);
		// Read it straight away (no exists-then-read race): a missing file is an empty one.
		let before = '';
		try {
			before = readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		const { text, changed } = withEnv(before, tilesEnv(argv[2] === '--terrain'));
		if (changed) writeFileSync(path, text);
		console.log(changed ? `Set the tiles URLs in ${path}: restart pnpm dev.` : `${path} already has the tiles URLs.`);
		return 0;
	}
	const args = parseUploadArgs(argv);
	if (typeof args === 'string') {
		console.error(
			`${args}\nusage: tsx scripts/tiles-upload.ts [--production --tiles-bucket <b> --reference-bucket <r>] [--terrain | --water | --fonts] <file.pmtiles | dir> [--version <v>] [--upstream <url>] [--original <file>]… [--no-head] [--dry-run]\n       tsx scripts/tiles-upload.ts --env <file> [--terrain]`
		);
		return 2;
	}
	if (!args.production && (process.env.STORAGE ?? 'local').trim() === 's3') {
		console.error('STORAGE=s3: this uploads to the local MinIO; production takes --production with your own AWS session.');
		return 2;
	}
	const plan = await planUpload(args);
	for (const n of plan.notes) console.warn(`note: ${n}`);
	if (args.dryRun) {
		console.log(`Dry run: nothing uploaded or recorded. Would put:`);
		for (const p of plan.puts) console.log(`  s3://${p.bucket}/${p.key} (${p.bytes} bytes)`);
		console.log(`Would record:\n${describeProvenance(plan.provenance)}`);
		if (plan.record) console.log(`Provenance file ${plan.record.key}, SHA-256 ${plan.record.sha256}:\n${JSON.stringify(tileProvenanceFile(plan.provenance), null, 2)}`);
		return 0;
	}
	const sdk = await import('@aws-sdk/client-s3');
	const s3 = args.production
		? // Your own session: AWS_PROFILE (and AWS_REGION) as for `aws s3 cp`.
			new sdk.S3Client({})
		: new sdk.S3Client({
				endpoint: process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002',
				region: process.env.S3_REGION?.trim() || 'us-east-1',
				forcePathStyle: true,
				// DEV-ONLY MinIO root credentials (docker-compose.yml).
				credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || 'minioadmin', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || 'minioadmin' }
			});
	await executePlan(plan, s3Store(sdk, s3), { local: !args.production });
	writeSidecar(args, plan.provenance, plan.originalPaths);
	console.log(`Uploaded ${plan.puts.length} object(s).\n${describeProvenance(plan.provenance)}`);
	if (args.production) {
		const r = plan.record!;
		console.log(
			[
				'Record it in the production database (approve it in the production environment):',
				`  gh workflow run load-reference.yml -f kind=tiles -f key=${r.key} -f sha256=${r.sha256} -f dataset=${args.archive}`,
				'Then, since CloudFront keeps byte ranges of the old archive:',
				`  aws cloudfront create-invalidation --distribution-id <cloudfront_distribution_id> --paths '/tiles/*'`
			].join('\n')
		);
		return 0;
	}
	const line =
		args.archive === 'terrain'
			? `PUBLIC_TERRAIN_URL=${terrainUrl()}`
			: args.archive === 'water'
				? `WATER_URL=${base(process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002')}/${WATER_KEY} (backend/.env.development.local)`
				: args.archive === 'fonts'
					? `PUBLIC_TILES_GLYPHS_URL=${glyphsUrl()}`
					: `PUBLIC_TILES_URL=${tilesUrl()}`;
	console.log(line);
	const url = process.env.MIGRATION_DATABASE_URL;
	if (!url) {
		console.error('Not recorded: MIGRATION_DATABASE_URL is not set.');
		return 1;
	}
	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
	} catch (e) {
		// The map works without it; say so plainly rather than fail the upload that did happen.
		console.warn(`Not recorded in the dev database (${(e as Error).message}): pnpm dev:db:up, then run this again to record it.`);
		return 0;
	}
	try {
		const replaced = await recordTileProvenance(client, plan.provenance);
		console.log(`Recorded in reference_load (kind tiles, dataset ${args.archive})${replaced ? `, replacing the record of ${replaced.loadedAt}` : ''}.`);
	} finally {
		await client.end();
	}
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	loadDevEnv();
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err.message);
			process.exit(1);
		}
	);
}
