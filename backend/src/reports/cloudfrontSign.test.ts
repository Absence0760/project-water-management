// CloudFront signed URLs for report downloads (cloudfrontSign.ts, storage.ts
// downloadUrl with REPORT_DOWNLOADS=cloudfront). The key pair is generated per
// run: no private key is ever committed.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertKeyPair, cannedPolicy, cloudFrontBase64, signCloudFrontUrl } from './cloudfrontSign.js';
import { assertDownloadSigner, DOWNLOAD_URL_TTL_SECONDS, downloadUrl, reportDownloads, reportKey } from './storage.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
});
const other = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
const signer = { keyPairId: 'K2JCJMDEHXQW5F', privateKey };

/** Undo CloudFront's URL-safe base64. */
const fromCloudFrontBase64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');

/** Split a signed URL into the resource CloudFront rebuilds and its signing parameters. */
function parse(signed: string) {
	const m = /^(.*)[?&]Expires=(\d+)&Signature=([A-Za-z0-9~_-]+)&Key-Pair-Id=([A-Z0-9]+)&Hash-Algorithm=(SHA1|SHA256)$/.exec(signed);
	expect(m, signed).not.toBeNull();
	return { resource: m![1]!, expires: Number(m![2]), signature: m![3]!, keyPairId: m![4]!, hash: m![5]! };
}

/** Verify the way CloudFront does: rebuild the canned policy from the URL and check it against the public key. */
const verifies = (signed: string, key = publicKey) => {
	const p = parse(signed);
	return createVerify('RSA-SHA256').update(cannedPolicy(p.resource, p.expires)).verify(key, fromCloudFrontBase64(p.signature));
};

describe('signCloudFrontUrl', () => {
	const url = 'https://water.example.org/reports/a/b.pdf?response-content-disposition=attachment%3B%20filename%3D%22x.pdf%22';

	it('appends Expires, Signature, Key-Pair-Id and Hash-Algorithm=SHA256 after the existing query', () => {
		const signed = signCloudFrontUrl(url, 1_767_290_400, signer);
		const p = parse(signed);
		expect(p.resource).toBe(url);
		expect(signed.startsWith(`${url}&Expires=1767290400&Signature=`)).toBe(true);
		expect(p.keyPairId).toBe('K2JCJMDEHXQW5F');
		expect(p.hash).toBe('SHA256');
		expect(p.signature).not.toMatch(/[+=/]/);
		// Without a query the parameters start one.
		expect(signCloudFrontUrl('https://water.example.org/reports/a/b.pdf', 1, signer)).toMatch(/\.pdf\?Expires=1&Signature=/);
	});

	it('the canned policy is exact, whitespace-free JSON over the full URL (query included) and the expiry', () => {
		expect(cannedPolicy(url, 1_767_290_400)).toBe(`{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":1767290400}}}]}`);
		expect(cloudFrontBase64(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-~~-');
		expect(cloudFrontBase64(Buffer.from([0xff]))).toBe('~w__');
	});

	it('verifies with the public key; a changed URL, expiry or key does not (positive control first)', () => {
		const signed = signCloudFrontUrl(url, 1_767_290_400, signer);
		expect(verifies(signed)).toBe(true);
		expect(verifies(signed.replace('x.pdf', 'y.pdf'))).toBe(false);
		expect(verifies(signed.replace('Expires=1767290400', 'Expires=1767290401'))).toBe(false);
		expect(verifies(signed.replace('/reports/a/', '/reports/c/'))).toBe(false);
		expect(verifies(signed, other.publicKey)).toBe(false);
	});

	it('refuses what CloudFront would misread: http, a wildcard path, its own parameters, a bad expiry or key id', () => {
		expect(() => signCloudFrontUrl('http://water.example.org/reports/a.pdf', 1, signer)).toThrow(/https/);
		expect(() => signCloudFrontUrl('https://water.example.org/reports/*.pdf', 1, signer)).toThrow(/wildcard/);
		expect(() => signCloudFrontUrl(`${url}&Expires=9`, 1, signer)).toThrow(/Expires/);
		expect(() => signCloudFrontUrl(url, 1.5, signer)).toThrow(/epoch/);
		expect(() => signCloudFrontUrl(url, 1, { ...signer, keyPairId: 'k-lower' })).toThrow(/public key id/);
	});
});

describe('assertKeyPair: the sops private key must pair with the public key Terraform trusts', () => {
	// openssl genpkey writes PKCS#8; the same key as PKCS#1 must pass too.
	const pkcs8 = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

	it('accepts a matching pair (positive control), in PKCS#1 or PKCS#8', () => {
		expect(() => assertKeyPair(privateKey, publicKey)).not.toThrow();
		expect(() => assertKeyPair(pkcs8.privateKey, pkcs8.publicKey)).not.toThrow();
	});

	it('refuses a private key from another pair, never quoting either key', () => {
		let message = '';
		try {
			assertKeyPair(privateKey, other.publicKey);
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/CLOUDFRONT_PRIVATE_KEY is not the private half of CLOUDFRONT_PUBLIC_KEY/);
		expect(message).not.toContain('-----');
	});

	it('refuses what is not a key at all, naming which', () => {
		expect(() => assertKeyPair('REPLACE_ME', publicKey)).toThrow(/CLOUDFRONT_PRIVATE_KEY is not a readable private key/);
		expect(() => assertKeyPair(privateKey, 'REPLACE_ME')).toThrow(/CLOUDFRONT_PUBLIC_KEY is not a readable public key/);
		expect(() => assertKeyPair(privateKey, '')).toThrow(/CLOUDFRONT_PUBLIC_KEY/);
	});
});

describe('assertDownloadSigner (the API cold-start check)', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('checks the pair only when signing CloudFront URLs', () => {
		vi.stubEnv('REPORT_DOWNLOADS', 'presigned');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', '');
		expect(() => assertDownloadSigner()).not.toThrow();
		vi.stubEnv('REPORT_DOWNLOADS', 'cloudfront');
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', privateKey);
		vi.stubEnv('CLOUDFRONT_PUBLIC_KEY', publicKey);
		expect(() => assertDownloadSigner()).not.toThrow();
		vi.stubEnv('CLOUDFRONT_PUBLIC_KEY', other.publicKey);
		expect(() => assertDownloadSigner()).toThrow(/not the private half/);
	});
});

describe('downloadUrl with REPORT_DOWNLOADS=cloudfront', () => {
	afterEach(() => vi.unstubAllEnvs());
	const projectId = '11111111-2222-4333-8444-555555555555';
	const reportId = '66666666-7777-4888-8999-aaaaaaaaaaaa';

	function cloudfront() {
		vi.stubEnv('REPORT_DOWNLOADS', 'cloudfront');
		vi.stubEnv('SITE_URL', 'https://water.example.org/');
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', signer.keyPairId);
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', privateKey);
	}

	it('signs the site’s own /reports/<project>/<report>.pdf, named for download, for one minute', async () => {
		cloudfront();
		const now = Date.UTC(2026, 8, 28, 12, 0, 0, 400);
		const signed = await downloadUrl(reportKey(projectId, reportId), 'upper-catchment-report-2026-09-28.pdf', undefined, now);
		const p = parse(signed);
		expect(p.resource).toBe(
			`https://water.example.org/reports/${projectId}/${reportId}.pdf?response-content-disposition=attachment%3B%20filename%3D%22upper-catchment-report-2026-09-28.pdf%22`
		);
		expect(p.expires).toBe(Math.floor(now / 1000) + DOWNLOAD_URL_TTL_SECONDS);
		expect(DOWNLOAD_URL_TTL_SECONDS).toBe(60);
		expect(verifies(signed)).toBe(true);
		// Never S3's own signature: the transfer goes through CloudFront, not the bucket.
		expect(signed).not.toMatch(/X-Amz-|amazonaws\.com/);
	});

	it('a fresh URL per call: a later click gets a later expiry', async () => {
		cloudfront();
		const key = reportKey(projectId, reportId);
		const a = parse(await downloadUrl(key, 'r.pdf', undefined, 1_000_000_000_000));
		const b = parse(await downloadUrl(key, 'r.pdf', undefined, 1_000_000_061_000));
		expect(b.expires - a.expires).toBe(61);
	});

	it('refuses to sign without the key pair (fails closed, never falls back to S3)', async () => {
		cloudfront();
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', '');
		await expect(downloadUrl(reportKey(projectId, reportId), 'r.pdf')).rejects.toThrow(/CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY/);
		vi.stubEnv('CLOUDFRONT_PRIVATE_KEY', privateKey);
		vi.stubEnv('CLOUDFRONT_KEY_PAIR_ID', ' ');
		await expect(downloadUrl(reportKey(projectId, reportId), 'r.pdf')).rejects.toThrow(/CLOUDFRONT_KEY_PAIR_ID/);
	});

	it('REPORT_DOWNLOADS defaults to presigned (local, no cloud account) and refuses an unknown value', () => {
		expect(reportDownloads(undefined)).toBe('presigned');
		expect(reportDownloads(' ')).toBe('presigned');
		expect(reportDownloads('cloudfront')).toBe('cloudfront');
		expect(() => reportDownloads('s3')).toThrow(/unknown REPORT_DOWNLOADS/);
	});
});
