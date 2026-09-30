// What the storage module sends to S3 (MinIO locally), with the client
// stubbed: an evidence pack's PDF goes to its own bucket under its derived
// key, carrying its SHA-256 (116_pack_render; the real round trip through
// MinIO is the pack e2e's). No network.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent, failHead } = vi.hoisted(() => ({ sent: [] as { name: string; input: Record<string, unknown> }[], failHead: { on: false } }));
vi.mock('@aws-sdk/client-s3', async (orig) => {
	const sdk = await orig<typeof import('@aws-sdk/client-s3')>();
	class S3Client {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			sent.push({ name: command.constructor.name, input: command.input });
			if (command.constructor.name === 'HeadBucketCommand' && failHead.on) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
			return {};
		}
	}
	return { ...sdk, S3Client };
});

const { packPdfKey, putPackPdf, putPdf, resetStorageClient } = await import('./storage.js');

const P = '11111111-1111-4111-8111-111111111111';
const K = '33333333-3333-4333-8333-333333333333';
const pdf = Buffer.from('%PDF-1.7 an issued pack');
const sha = createHash('sha256').update(pdf).digest('hex');

beforeEach(() => {
	sent.length = 0;
	failHead.on = false;
	resetStorageClient();
});
afterEach(() => vi.unstubAllEnvs());

describe('putPackPdf', () => {
	it('puts the PDF into the packs bucket under its key, with its SHA-256 for S3 to check (production)', async () => {
		vi.stubEnv('STORAGE', 's3');
		vi.stubEnv('PACKS_BUCKET', 'water-management-packs-000000000000');
		vi.stubEnv('REPORTS_BUCKET', 'water-management-reports-000000000000');
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		expect(sent).toEqual([
			{
				name: 'PutObjectCommand',
				input: {
					Bucket: 'water-management-packs-000000000000',
					Key: `packs/${P}/${K}/${sha}.pdf`,
					Body: pdf,
					ContentType: 'application/pdf',
					// x-amz-checksum-sha256 is the base64 of the digest's bytes.
					ChecksumSHA256: createHash('sha256').update(pdf).digest('base64')
				}
			}
		]);
	});

	it('refuses a hash that is not a lowercase hex SHA-256 before any request', async () => {
		vi.stubEnv('STORAGE', 's3');
		await expect(putPackPdf(packPdfKey(P, K, sha), pdf, sha.toUpperCase())).rejects.toThrow('SHA-256');
		await expect(putPackPdf(packPdfKey(P, K, sha), pdf, 'x')).rejects.toThrow('SHA-256');
		expect(sent).toEqual([]);
	});

	it('locally, creates the packs bucket once in MinIO, apart from the reports bucket', async () => {
		vi.stubEnv('STORAGE', 'local');
		vi.stubEnv('PACKS_BUCKET', '');
		vi.stubEnv('REPORTS_BUCKET', '');
		failHead.on = true;
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		await putPackPdf(packPdfKey(P, K, sha), pdf, sha);
		await putPdf(`reports/${P}/${K}.pdf`, pdf);
		expect(sent.map((c) => `${c.name} ${c.input.Bucket}`)).toEqual([
			'HeadBucketCommand water-packs',
			'CreateBucketCommand water-packs',
			'PutObjectCommand water-packs',
			'PutObjectCommand water-packs',
			'HeadBucketCommand water-reports',
			'CreateBucketCommand water-reports',
			'PutObjectCommand water-reports'
		]);
	});
});
