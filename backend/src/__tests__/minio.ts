// Whether MinIO (the local object store, `pnpm dev:s3:up`) is running, for a
// test that needs it (docs/testing.md § Tests that need a service or a
// browser): locally a test skips without it, with a warning naming the
// command; under CI (process.env.CI) a missing MinIO throws, so the job can't
// go green on a check it never ran. CI's db-test job starts MinIO.

export const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:9002';

/** True when MinIO answers its health check; throws under CI when it doesn't. `what` names the tests, for the messages. */
export async function minioUp(what: string): Promise<boolean> {
	const up = await fetch(`${S3_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);
	if (!up && process.env.CI) throw new Error(`${what}: MinIO is not reachable at ${S3_ENDPOINT} under CI; the job must start it (.github/workflows/ci.yml db-test)`);
	if (!up) console.warn(`${what} skipped: MinIO is not running at ${S3_ENDPOINT} (pnpm dev:s3:up)`);
	return up;
}
