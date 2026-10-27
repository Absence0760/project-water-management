import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { MirrorUrlError, NodeGzip, openStore, S3Store } from './store.js';

/** An in-memory S3: GetObject answers NoSuchKey for a missing key, as S3 does. */
function fakeS3() {
	const objects = new Map<string, Uint8Array>();
	const sent: string[] = [];
	return {
		objects,
		sent,
		async send(cmd: unknown) {
			if (cmd instanceof PutObjectCommand) {
				sent.push(`put ${cmd.input.Bucket}/${cmd.input.Key}`);
				objects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, cmd.input.Body as Uint8Array);
				return {};
			}
			if (cmd instanceof GetObjectCommand) {
				sent.push(`get ${cmd.input.Bucket}/${cmd.input.Key}`);
				const v = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
				if (!v) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
				return { Body: { transformToByteArray: async () => v } };
			}
			throw new Error('unexpected command');
		}
	};
}

describe('openStore (MIRROR_URL)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'mirror-store-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('opens a local directory from file:///abs/path, missing keys as undefined', async () => {
		const store = openStore(pathToFileURL(dir).href);
		expect(await store.get('/rnl/zarr.json')).toBeUndefined();
		await store.set('/rnl/zarr.json', new Uint8Array([1, 2, 3]));
		expect(Array.from((await store.get('/rnl/zarr.json'))!)).toEqual([1, 2, 3]);
	});

	it('opens s3://bucket[/prefix] as an S3Store', () => {
		const s = openStore('s3://wm-prod-mirror/env/a', { s3: fakeS3() });
		expect(s).toBeInstanceOf(S3Store);
		expect((s as S3Store).bucket).toBe('wm-prod-mirror');
		expect((s as S3Store).key('/rnl/zarr.json')).toBe('env/a/rnl/zarr.json');
		expect((openStore('s3://wm-prod-mirror', { s3: fakeS3() }) as S3Store).key('/rnl/zarr.json')).toBe('rnl/zarr.json');
	});

	it('refuses any other URL', () => {
		for (const url of ['', 'http://example.com/m', 's3://', 's3://UPPER', 'file://relative/path', '/abs/path']) {
			expect(() => openStore(url), url).toThrow(MirrorUrlError);
		}
	});
});

describe('S3Store', () => {
	it('gets what it set, under its prefix, and a missing key as undefined', async () => {
		const s3 = fakeS3();
		const store = new S3Store('b-mirror', 'p', s3);
		expect(await store.get('/rnl/c/0/0/0/0')).toBeUndefined();
		await store.set('/rnl/c/0/0/0/0', new Uint8Array([9]));
		expect(await store.get('/rnl/c/0/0/0/0')).toEqual(new Uint8Array([9]));
		expect(s3.sent).toEqual(['get b-mirror/p/rnl/c/0/0/0/0', 'put b-mirror/p/rnl/c/0/0/0/0', 'get b-mirror/p/rnl/c/0/0/0/0']);
	});

	it('throws any failure other than a missing key (never reads it as all-NaN)', async () => {
		const store = new S3Store('b-mirror', '', {
			send: async () => {
				throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
			}
		});
		await expect(store.get('/rnl/zarr.json')).rejects.toThrow('denied');
	});
});

describe('NodeGzip', () => {
	it('round-trips bytes through node:zlib gzip', () => {
		const codec = NodeGzip.fromConfig({ level: 6 });
		const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
		const packed = codec.encode(bytes);
		expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
		expect(codec.decode(packed)).toEqual(bytes);
	});
});
