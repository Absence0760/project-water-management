// Where rendered PDFs live (STORAGE; docs/run-locally.md § Reports,
// docs/deployment.md § Reports). One S3 API for both:
//
//   local — default. MinIO from docker-compose (`pnpm dev:s3:up`) at
//           S3_ENDPOINT, with its throwaway root credentials. The bucket is
//           created on first use. No AWS account.
//   s3    — production: the private reports bucket (REPORTS_BUCKET, SSE,
//           7-day lifecycle; infra/reports.tf), credentials from the Lambda's
//           role, the region from its environment.
//
// A PDF's key is derived from its ids (reportKey), never stored or taken from
// a message, so nothing can point a download at another project's file.
// Downloads are short-lived signed URLs, minted per click by the auth-checked
// GET /projects/:id/reports/:jobId/pdf (a 302), so the only lasting handle on
// a PDF is that route, behind the session, the WAF and the project's
// membership (docs/security.md § Reports). REPORT_DOWNLOADS picks the signer:
//
//   presigned  — default. A pre-signed S3 GET on the storage above (MinIO
//                locally): no AWS account, no CloudFront.
//   cloudfront — production: a CloudFront signed URL on the site's own
//                origin (SITE_URL/reports/…), which CloudFront serves from the
//                private bucket through its origin access control, behind the
//                WAF (infra/reports.tf). Signed with the private key of the
//                distribution's trusted key group (CLOUDFRONT_KEY_PAIR_ID,
//                CLOUDFRONT_PRIVATE_KEY from the API's runtime secret). The
//                API itself can't read the bucket.
//
// The AWS SDK is imported lazily, like the mail and queue transports.
import type { S3Client } from '@aws-sdk/client-s3';
import { signCloudFrontUrl } from './cloudfrontSign.js';

export const STORAGES = ['local', 's3'] as const;
export type Storage = (typeof STORAGES)[number];

export function storageKind(value: string | undefined = process.env.STORAGE): Storage {
	const v = value?.trim() || 'local';
	if (!(STORAGES as readonly string[]).includes(v)) throw new Error(`unknown STORAGE "${v}" (expected ${STORAGES.join(', ')})`);
	return v as Storage;
}

export const REPORT_DOWNLOADS = ['presigned', 'cloudfront'] as const;
export type ReportDownloads = (typeof REPORT_DOWNLOADS)[number];

export function reportDownloads(value: string | undefined = process.env.REPORT_DOWNLOADS): ReportDownloads {
	const v = value?.trim() || 'presigned';
	if (!(REPORT_DOWNLOADS as readonly string[]).includes(v)) throw new Error(`unknown REPORT_DOWNLOADS "${v}" (expected ${REPORT_DOWNLOADS.join(', ')})`);
	return v as ReportDownloads;
}

/**
 * Signed download links last this long (seconds): long enough for the
 * browser to follow the API's redirect and start the download (S3 and CloudFront check the
 * expiry when the GET starts, not while it streams), short enough that a
 * leaked or logged link is useless almost at once.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 60;
/** The bucket's lifecycle deletes PDFs after this many days (infra/reports.tf); rows go a day later. */
export const REPORT_RETENTION_DAYS = 7;

export const reportsBucket = () => process.env.REPORTS_BUCKET?.trim() || 'water-reports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The object key of a report's PDF. */
export function reportKey(projectId: string, reportId: string): string {
	if (!UUID.test(projectId) || !UUID.test(reportId)) throw new Error('reportKey: ids must be UUIDs');
	return `reports/${projectId.toLowerCase()}/${reportId.toLowerCase()}.pdf`;
}

/** A download file name from a project's name: letters, digits and dashes only. */
export function reportFileName(projectName: string, date: string): string {
	const slug = projectName
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.slice(0, 60)
		.toLowerCase();
	return `${slug || 'catchment'}-report-${date}.pdf`;
}

let client: Promise<{ s3: S3Client; sdk: typeof import('@aws-sdk/client-s3') }> | undefined;
let bucketReady: Promise<void> | undefined;

function s3() {
	client ??= import('@aws-sdk/client-s3').then((sdk) => {
		if (storageKind() === 's3') return { s3: new sdk.S3Client({}), sdk };
		// MinIO: path-style addressing, its root credentials (DEV-ONLY, docker-compose.yml).
		return {
			s3: new sdk.S3Client({
				endpoint: process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002',
				region: process.env.S3_REGION?.trim() || 'us-east-1',
				forcePathStyle: true,
				credentials: {
					accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || 'minioadmin',
					secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || 'minioadmin'
				}
			}),
			sdk
		};
	});
	return client;
}

/** Locally, create the bucket once if MinIO doesn't have it (production's comes from Terraform). */
async function ensureBucket(): Promise<void> {
	if (storageKind() === 's3') return;
	bucketReady ??= (async () => {
		const { s3: c, sdk } = await s3();
		try {
			await c.send(new sdk.HeadBucketCommand({ Bucket: reportsBucket() }));
		} catch {
			await c.send(new sdk.CreateBucketCommand({ Bucket: reportsBucket() })).catch((err: { name?: string }) => {
				if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
			});
		}
	})().catch((err) => {
		bucketReady = undefined;
		throw err;
	});
	return bucketReady;
}

/** Store a PDF (server-side encrypted in production by the bucket's default). */
export async function putPdf(key: string, body: Uint8Array): Promise<void> {
	await ensureBucket();
	const { s3: c, sdk } = await s3();
	await c.send(new sdk.PutObjectCommand({ Bucket: reportsBucket(), Key: key, Body: body, ContentType: 'application/pdf' }));
}

/**
 * A signed GET for a PDF, downloaded under `fileName` (REPORT_DOWNLOADS picks
 * S3 or CloudFront). Signing is local: no request is made.
 */
export async function downloadUrl(key: string, fileName: string, expiresIn = DOWNLOAD_URL_TTL_SECONDS, now = Date.now()): Promise<string> {
	const disposition = `attachment; filename="${fileName}"`;
	if (reportDownloads() === 'cloudfront') {
		const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID?.trim() ?? '';
		const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY ?? '';
		if (!keyPairId || !privateKey.trim()) throw new Error('REPORT_DOWNLOADS=cloudfront needs CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY');
		const site = (process.env.SITE_URL || 'http://localhost:7777').trim().replace(/\/+$/, '');
		// The bucket's key is the path (the /reports/* behaviour), and S3 sets the
		// file name from the forwarded query; the signature covers both.
		const url = `${site}/${key}?response-content-disposition=${encodeURIComponent(disposition)}`;
		return signCloudFrontUrl(url, Math.floor(now / 1000) + expiresIn, { keyPairId, privateKey });
	}
	const { s3: c, sdk } = await s3();
	const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
	return getSignedUrl(
		c,
		new sdk.GetObjectCommand({ Bucket: reportsBucket(), Key: key, ResponseContentDisposition: disposition }),
		{ expiresIn }
	);
}

/** Delete a PDF (local purge; production's lifecycle rule does this). Missing is fine. */
export async function deletePdf(key: string): Promise<void> {
	const { s3: c, sdk } = await s3();
	await c.send(new sdk.DeleteObjectCommand({ Bucket: reportsBucket(), Key: key }));
}

/** Tests: forget the client, so a changed environment takes effect. */
export function resetStorageClient(): void {
	client = undefined;
	bucketReady = undefined;
}
