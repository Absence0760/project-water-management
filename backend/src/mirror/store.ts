// Where the mirror lives (MIRROR_URL): a local directory (`file:///abs/path`)
// in dev, CI and e2e, the private versioned bucket (`s3://bucket[/prefix]`) in
// production. Either way a zarrita store: get(key) → bytes or undefined, and
// set(key, bytes) for the writers.
//
// The S3 store goes through @aws-sdk/client-s3 (already a backend dependency,
// imported lazily so a bundle that never opens an s3:// mirror never loads
// it); no other S3 library.
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import FileSystemStore from '@zarrita/storage/fs';
import type { AbsolutePath, AsyncMutable } from '@zarrita/storage';
import * as zarr from 'zarrita';

/** A mirror store: what zarrita reads and writes through. */
export type MirrorStore = AsyncMutable;

/** The subset of S3Client the store sends through (an injected client in tests). */
export interface S3Sender {
	send(command: unknown): Promise<unknown>;
}

/**
 * The bucket as a zarrita store. A missing key (NoSuchKey, 404) is undefined:
 * an unwritten chunk is all fill (NaN), and a missing manifest or zarr.json is
 * a product not in the copy yet. Every other failure throws.
 */
export class S3Store implements AsyncMutable {
	readonly bucket: string;
	readonly prefix: string;
	#client: Promise<{ s3: S3Sender; sdk: typeof import('@aws-sdk/client-s3') }>;

	constructor(bucket: string, prefix = '', client?: S3Sender) {
		this.bucket = bucket;
		this.prefix = prefix.replace(/^\/+|\/+$/g, '');
		this.#client = import('@aws-sdk/client-s3').then((sdk) => ({ s3: client ?? new sdk.S3Client({}), sdk }));
	}

	key(path: AbsolutePath): string {
		const rel = path.replace(/^\/+/, '');
		return this.prefix ? `${this.prefix}/${rel}` : rel;
	}

	async get(path: AbsolutePath): Promise<Uint8Array | undefined> {
		const { s3, sdk } = await this.#client;
		try {
			const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.key(path) }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
			return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
		} catch (err) {
			const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
			if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return undefined;
			throw err;
		}
	}

	async set(path: AbsolutePath, value: Uint8Array): Promise<void> {
		const { s3, sdk } = await this.#client;
		await s3.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.key(path), Body: value }));
	}

	/** Remove an object (the daily ingest drops a preliminary day's chunks once its finals land). S3 answers a missing key with success too. */
	async delete(path: AbsolutePath): Promise<void> {
		const { s3, sdk } = await this.#client;
		await s3.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(path) }));
	}
}

/** MIRROR_URL is neither file:///… nor s3://bucket[/prefix]. */
export class MirrorUrlError extends Error {
	override readonly name = 'MirrorUrlError';
}

/** The store MIRROR_URL names. */
export function openStore(url: string, opts: { s3?: S3Sender } = {}): MirrorStore {
	registerNodeGzip();
	if (url.startsWith('file://')) {
		let dir: string;
		try {
			dir = fileURLToPath(url);
		} catch {
			throw new MirrorUrlError('MIRROR_URL file://… needs an absolute path (file:///abs/path)');
		}
		return new FileSystemStore(dir);
	}
	const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(url);
	if (m) return new S3Store(m[1]!, m[2] ?? '', opts.s3);
	throw new MirrorUrlError('MIRROR_URL must be file:///abs/path or s3://bucket[/prefix]');
}

/**
 * gzip over node:zlib. zarrita 0.7.5's own gzip codec only decodes (encode
 * throws UnsupportedError), so the writers need this one (Round 0 check 5).
 * It decodes too, synchronously, which is the faster path in Node.
 */
export class NodeGzip {
	readonly kind = 'bytes_to_bytes';
	readonly level: number;
	constructor(level = 6) {
		this.level = level;
	}
	static fromConfig(c?: { level?: number }) {
		return new NodeGzip(c?.level ?? 6);
	}
	encode(bytes: Uint8Array): Uint8Array {
		return new Uint8Array(gzipSync(bytes, { level: this.level }));
	}
	decode(bytes: Uint8Array): Uint8Array {
		return new Uint8Array(gunzipSync(bytes));
	}
}

let registered = false;
/** Register NodeGzip as zarrita's `gzip` codec, once, before any array is opened. */
export function registerNodeGzip(): void {
	if (registered) return;
	zarr.registry.set('gzip', async () => NodeGzip as never);
	registered = true;
}
