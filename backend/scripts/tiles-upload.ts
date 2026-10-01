// Put a PMTiles basemap into the local MinIO for the catchment map (issue
// #288; docs/maps.md § Basemap). bin/tiles-dev.sh runs it after `fetch`:
//
//   tsx scripts/tiles-upload.ts <file.pmtiles>
//   tsx scripts/tiles-upload.ts --fonts <dir>
//   tsx scripts/tiles-upload.ts --env <file>
//
// It creates the `tiles` bucket, lets anyone read its objects (MinIO is
// loopback-only; the map reads the file with HTTP Range from the browser) and
// uploads the file as `south-africa.pmtiles`. With --fonts it uploads the
// labels' glyph ranges instead (#326 A6, docs/maps.md § Labels): every
// `<fontstack>/<range>.pbf` under <dir> to `fonts/<fontstack>/<range>.pbf`,
// with the font licence (OFL.txt) beside them, so the map's glyphs URL is
// `…/tiles/fonts/{fontstack}/{range}.pbf`. With --env it uploads nothing: it
// sets PUBLIC_TILES_URL and PUBLIC_TILES_GLYPHS_URL in <file> (the frontend's
// gitignored .env.development.local; `pnpm dev:tiles:up`), keeping every other
// line, and prints whether it changed. Local only: it refuses
// STORAGE=s3 (production's tiles go to S3 behind CloudFront, a deployment
// step, docs/deployment.md).
import { config } from 'dotenv';
import { createReadStream, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const TILES_BUCKET = 'tiles';
export const TILES_KEY = 'south-africa.pmtiles';
/** Where the glyph ranges go in the bucket. */
export const FONTS_PREFIX = 'fonts';

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

async function main(args: string[]): Promise<number> {
	if (args[0] === '--env') {
		if (!args[1]) {
			console.error('usage: tsx scripts/tiles-upload.ts --env <file>');
			return 2;
		}
		const path = resolve(process.env.INIT_CWD ?? process.cwd(), args[1]);
		// Read it straight away (no exists-then-read race): a missing file is an empty one.
		let before = '';
		try {
			before = readFileSync(path, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		const { text, changed } = withEnv(before, { PUBLIC_TILES_URL: tilesUrl(), PUBLIC_TILES_GLYPHS_URL: glyphsUrl() });
		if (changed) writeFileSync(path, text);
		console.log(changed ? `Set the tiles URLs in ${path}: restart pnpm dev.` : `${path} already has the tiles URLs.`);
		return 0;
	}
	const fonts = args[0] === '--fonts';
	const file = fonts ? args[1] : args[0];
	if (!file) {
		console.error('usage: tsx scripts/tiles-upload.ts <file.pmtiles> | --fonts <dir> | --env <file>');
		return 2;
	}
	if ((process.env.STORAGE ?? 'local').trim() === 's3') {
		console.error('STORAGE=s3: this uploads to the local MinIO only.');
		return 2;
	}
	const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
	const sdk = await import('@aws-sdk/client-s3');
	const s3 = new sdk.S3Client({
		endpoint: process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002',
		region: process.env.S3_REGION?.trim() || 'us-east-1',
		forcePathStyle: true,
		// DEV-ONLY MinIO root credentials (docker-compose.yml).
		credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || 'minioadmin', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || 'minioadmin' }
	});
	try {
		await s3.send(new sdk.HeadBucketCommand({ Bucket: TILES_BUCKET }));
	} catch {
		await s3.send(new sdk.CreateBucketCommand({ Bucket: TILES_BUCKET }));
	}
	await s3.send(new sdk.PutBucketPolicyCommand({ Bucket: TILES_BUCKET, Policy: publicReadPolicy() }));
	if (fonts) {
		const objects = fontObjects(path);
		if (!objects.some((o) => o.key.endsWith('.pbf'))) {
			console.error(`No glyph ranges (<fontstack>/<n>-<n+255>.pbf) under ${path}.`);
			return 1;
		}
		// A few at a time: hundreds of small files, and MinIO on a laptop.
		for (let i = 0; i < objects.length; i += 16) {
			await Promise.all(
				objects
					.slice(i, i + 16)
					.map((o) => s3.send(new sdk.PutObjectCommand({ Bucket: TILES_BUCKET, Key: o.key, Body: createReadStream(o.path), ContentLength: statSync(o.path).size, ContentType: o.contentType })))
			);
		}
		const stacks = new Set(objects.filter((o) => o.key.endsWith('.pbf')).map((o) => o.key.split('/')[1]));
		console.log(`Uploaded ${objects.length} files (${[...stacks].join(', ')}).\nPUBLIC_TILES_GLYPHS_URL=${glyphsUrl()}`);
		return 0;
	}
	await s3.send(
		new sdk.PutObjectCommand({
			Bucket: TILES_BUCKET,
			Key: TILES_KEY,
			Body: createReadStream(path),
			ContentLength: statSync(path).size,
			ContentType: 'application/vnd.pmtiles'
		})
	);
	console.log(`Uploaded ${path} (${(statSync(path).size / 1024 / 1024).toFixed(0)} MB).\nPUBLIC_TILES_URL=${tilesUrl()}`);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	config({ path: ['.env.development.local', '.env.development'] });
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err.message);
			process.exit(1);
		}
	);
}
