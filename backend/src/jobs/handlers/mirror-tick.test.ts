// fetchManifest's one request per product (handlers/mirror-tick.ts): a
// conditional GET on S3 (If-None-Match with the ETag already handled, a 304
// is "unchanged"), a missing manifest as null, and any other failure thrown.
// The file:// path is covered by mirror-tick.db.test.ts.
import { describe, expect, it } from 'vitest';
import { fetchManifest } from './mirror-tick.js';

const env = { MIRROR_URL: 's3://wm-mirror-test/copy', CHIRPS_SOURCE: 'mirror' };
type Sent = { input: { Bucket: string; Key: string; IfNoneMatch?: string } };

function fakeS3(answer: (input: Sent['input']) => unknown) {
	const sent: Sent['input'][] = [];
	return {
		sent,
		s3: {
			async send(command: unknown) {
				const input = (command as Sent).input;
				sent.push(input);
				return answer(input);
			}
		}
	};
}
const body = (text: string) => ({ ETag: '"e1"', Body: { transformToByteArray: async () => new TextEncoder().encode(text) } });
const fail = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('fetchManifest on S3', () => {
	it('GETs the product’s manifest, then asks with If-None-Match and takes a 304 as unchanged', async () => {
		const { s3, sent } = fakeS3((input) => {
			if (input.IfNoneMatch === '"e1"') throw fail('NotModified', 304);
			return body('{"product":"sat"}');
		});
		const first = await fetchManifest('sat', undefined, { s3, env });
		expect(first).toMatchObject({ tag: '"e1"' });
		expect(new TextDecoder().decode((first as { bytes: Uint8Array }).bytes)).toBe('{"product":"sat"}');
		expect(sent[0]).toEqual({ Bucket: 'wm-mirror-test', Key: 'copy/sat/manifest.json' });
		expect(await fetchManifest('sat', '"e1"', { s3, env })).toBe('unchanged');
		expect(sent[1]).toEqual({ Bucket: 'wm-mirror-test', Key: 'copy/sat/manifest.json', IfNoneMatch: '"e1"' });
		// Positive control: another tag known (the manifest moved) reads it again.
		expect(await fetchManifest('sat', '"e0"', { s3, env })).toMatchObject({ tag: '"e1"' });
	});

	it('a missing manifest is null; any other failure is thrown', async () => {
		expect(await fetchManifest('prelim', undefined, { s3: fakeS3(() => Promise.reject(fail('NoSuchKey', 404))).s3, env })).toBeNull();
		await expect(fetchManifest('rnl', undefined, { s3: fakeS3(() => Promise.reject(fail('AccessDenied', 403))).s3, env })).rejects.toThrow('AccessDenied');
	});
});
