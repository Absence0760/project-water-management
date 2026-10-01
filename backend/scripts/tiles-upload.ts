// Put a PMTiles basemap into the local MinIO for the catchment map (issue
// #288; docs/maps.md § Basemap). bin/tiles-dev.sh runs it after `fetch`:
//
//   tsx scripts/tiles-upload.ts <file.pmtiles>
//
// It creates the `tiles` bucket, lets anyone read its objects (MinIO is
// loopback-only; the map reads the file with HTTP Range from the browser) and
// uploads the file as `south-africa.pmtiles`. Local only: it refuses
// STORAGE=s3 (production's tiles go to S3 behind CloudFront, a deployment
// step, docs/deployment.md).
import { config } from 'dotenv';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const TILES_BUCKET = 'tiles';
export const TILES_KEY = 'south-africa.pmtiles';

/** The bucket policy: anyone may GET an object (Range reads included), nothing else. */
export function publicReadPolicy(bucket = TILES_BUCKET): string {
	return JSON.stringify({
		Version: '2012-10-17',
		Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }]
	});
}

/** The URL the frontend reads (PUBLIC_TILES_URL), from the MinIO endpoint. */
export const tilesUrl = (endpoint = process.env.S3_ENDPOINT?.trim() || 'http://127.0.0.1:9002') =>
	`${endpoint.replace('127.0.0.1', 'localhost').replace(/\/$/, '')}/${TILES_BUCKET}/${TILES_KEY}`;

async function main(file: string | undefined): Promise<number> {
	if (!file) {
		console.error('usage: tsx scripts/tiles-upload.ts <file.pmtiles>');
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
	main(process.argv[2]).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err.message);
			process.exit(1);
		}
	);
}
