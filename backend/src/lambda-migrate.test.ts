import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrateError } from '../scripts/migrate.js';
import { failureSummary, handler, isMissingObject, ownerUrl, scramSha256Verifier } from './lambda-migrate.js';

// The master secret as Secrets Manager returns it; each test sets its text.
const secret = vi.hoisted(() => ({ text: '' }));
vi.mock('./config/secretsManager.js', () => ({ getSecretString: async () => secret.text }));

// The deploy workflow prints a failed run's summary to a public Actions log,
// so it must carry codes and names only, never the error's text.
const SECRET_TEXT = 'duplicate key value violates unique constraint: Key (email)=(someone@example.org)';
const context = { logGroupName: '/aws/lambda/wm-migrate', logStreamName: '2026/09/28/[$LATEST]abc123', awsRequestId: 'req-1' };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('failureSummary', () => {
	it('a failed migration: its code, the file, what was applied and pending, and where the log is', () => {
		const err = new MigrateError(`migration 002_b.sql failed: ${SECRET_TEXT}`, 'migration_failed', ['002_b.sql'], ['001_a.sql'], ['002_b.sql', '003_c.sql']);
		const summary = failureSummary(err, context);
		expect(summary).toEqual({
			code: 'migration_failed',
			migrations: ['002_b.sql'],
			applied: ['001_a.sql'],
			pending: ['002_b.sql', '003_c.sql'],
			logGroup: '/aws/lambda/wm-migrate',
			logStream: '2026/09/28/[$LATEST]abc123',
			requestId: 'req-1'
		});
		expect(JSON.stringify(summary)).not.toContain('someone@example.org');
	});

	it('any other error is setup_failed, with no names and none of its text', () => {
		const summary = failureSummary(new Error(`connect failed: ${SECRET_TEXT}`), context);
		expect(summary).toMatchObject({ code: 'setup_failed', migrations: [], applied: [], pending: [] });
		expect(JSON.stringify(summary)).not.toContain('email');
	});

	it('without a Lambda context the log location is null, not made up', () => {
		expect(failureSummary(new Error('x'))).toMatchObject({ logGroup: null, logStream: null, requestId: null });
	});
});

describe('handler', () => {
	it('fails with the summary as its message and logs the real error (CloudWatch only)', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', '');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = await handler({}, context).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const { message, stack } = err as Error;
		expect(JSON.parse(message)).toMatchObject({ code: 'setup_failed', logStream: context.logStreamName });
		expect(message).not.toContain('MASTER_SECRET_ARN');
		expect(stack).not.toContain('MASTER_SECRET_ARN');
		expect(String(logged.mock.calls[0]?.[1])).toContain('MASTER_SECRET_ARN is not set');
	});
});

describe('a reference load (docs/deployment.md § Reference datasets)', () => {
	it('a blocked kind is refused before anything is read, with a fixed reason in the summary', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', '');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = await handler({ load: { kind: 'dam-register', key: 'reference/dam-register/x.json', sha256: 'a'.repeat(64), dataset: 'DSO' } }, context).catch((e: Error) => e);
		const summary = JSON.parse((err as Error).message);
		expect(summary).toMatchObject({ code: 'refused', logStream: context.logStreamName });
		expect(summary.reason).toMatch(/dam-register is blocked in production/);
	});

	it('a load event never migrates: a well-formed load fails on its own path (here the file read), not on the migrations', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { loadReference } = await import('./lambda-migrate.js');
		const err = await loadReference({ kind: 'rivers', key: 'reference/rivers/r.geojson', sha256: 'a'.repeat(64), dataset: 'HydroRIVERS-v10', source: 's' }, context, async () => null).catch((e: Error) => e);
		expect(JSON.parse((err as Error).message)).toMatchObject({ code: 'not_found', reason: 'no object at that key in the reference bucket' });
	});

	it('the bundle carries the reference loaders but no raster or HDF5 code (geo/loadCropland.ts, the feeds’ GeoTIFF reader, geo/loadEvaporation.ts and h5wasm)', async () => {
		const { build } = await import('esbuild');
		const out = await build({
			entryPoints: [fileURLToPath(new URL('./lambda-migrate.ts', import.meta.url))],
			bundle: true,
			platform: 'node',
			format: 'esm',
			external: ['@aws-sdk/*'],
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const inputs = Object.keys(out.metafile.inputs);
		expect(inputs.some((f) => f.endsWith('src/geo/referenceLoad.ts'))).toBe(true);
		expect(inputs.some((f) => f.endsWith('src/geo/croplandGrid.ts'))).toBe(true);
		expect(inputs.some((f) => f.endsWith('src/geo/evaporationGrid.ts'))).toBe(true);
		expect(inputs.filter((f) => /geo\/loadCropland\.ts$|feeds\/sources\/tiff\.ts$|geo\/loadEvaporation\.ts$|h5wasm/.test(f))).toEqual([]);
	}, 60_000);
});

describe('isMissingObject: S3 answers a GetObject-only role 403 for a missing key', () => {
	it('NoSuchKey and AccessDenied (and their status codes) are a missing object; anything else is an error', () => {
		expect(isMissingObject(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(true);
		expect(isMissingObject(Object.assign(new Error('x'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }))).toBe(true);
		expect(isMissingObject({ $metadata: { httpStatusCode: 404 } })).toBe(true);
		expect(isMissingObject(Object.assign(new Error('x'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } }))).toBe(false);
		expect(isMissingObject(new Error('socket hang up'))).toBe(false);
		expect(isMissingObject(undefined)).toBe(false);
	});
});

describe('the migrate run before it touches the database', () => {
	/** The handler's failure: the summary it throws and the error it logged for CloudWatch. */
	async function failure() {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = (await handler({}, context).catch((e: Error) => e)) as Error;
		return { summary: JSON.parse(err.message) as { code: string }, message: err.message, logged: String(logged.mock.calls[0]?.[1]) };
	}
	const GOOD = 'A'.repeat(24);

	it('a master secret that isn’t JSON fails without quoting it', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', 'arn:secret');
		secret.text = 'password=hunter2-not-json';
		const { summary, message, logged } = await failure();
		expect(summary.code).toBe('setup_failed');
		expect(logged).toContain('master secret is not JSON');
		expect(logged + message).not.toContain('hunter2');
	});

	it('a master secret without a username or password fails', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', 'arn:secret');
		for (const text of ['{"username":"water"}', '{"password":"x"}', '{}']) {
			secret.text = text;
			expect((await failure()).logged).toContain('master secret is missing username/password');
			vi.restoreAllMocks();
		}
	});

	it('names a missing DB_HOST or DB_NAME', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', 'arn:secret');
		secret.text = JSON.stringify({ username: 'water', password: 'pw' });
		vi.stubEnv('DB_NAME', 'water');
		expect((await failure()).logged).toContain('DB_HOST is not set');
		vi.restoreAllMocks();
		vi.stubEnv('DB_HOST', 'db.internal');
		vi.stubEnv('DB_NAME', '');
		expect((await failure()).logged).toContain('DB_NAME is not set');
	});

	it('refuses a WATER_APP_PASSWORD shorter than 24 or not alphanumeric, before connecting', async () => {
		vi.stubEnv('MASTER_SECRET_ARN', 'arn:secret');
		secret.text = JSON.stringify({ username: 'water', password: 'pw' });
		// Port 1: a connection attempt would fail with ECONNREFUSED, not this.
		vi.stubEnv('DB_HOST', '127.0.0.1');
		vi.stubEnv('DB_PORT', '1');
		vi.stubEnv('DB_NAME', 'water');
		for (const pw of ['A'.repeat(23), `${'A'.repeat(23)}!`, `${GOOD} `, '']) {
			vi.stubEnv('WATER_APP_PASSWORD', pw);
			const { logged } = await failure();
			expect(logged).toContain(pw ? 'WATER_APP_PASSWORD must be 24+ alphanumeric characters' : 'WATER_APP_PASSWORD is not set');
			vi.restoreAllMocks();
		}
	});
});

describe('ownerUrl', () => {
	it('verifies the server’s certificate, encodes the credentials and defaults the port to 5432', () => {
		vi.stubEnv('DB_HOST', 'db.internal');
		vi.stubEnv('DB_NAME', 'water');
		const url = new URL(ownerUrl({ username: 'wa ter', password: 'p@ss/w:rd' }));
		expect(url.searchParams.get('sslmode')).toBe('verify-full');
		expect([decodeURIComponent(url.username), decodeURIComponent(url.password), url.hostname, url.port || '5432', url.pathname]).toEqual(['wa ter', 'p@ss/w:rd', 'db.internal', '5432', '/water']);
		vi.stubEnv('DB_PORT', '6543');
		expect(new URL(ownerUrl({ username: 'u', password: 'p' })).port).toBe('6543');
	});
});

describe('scramSha256Verifier', () => {
	it('writes the pg_authid format, is the same for the same salt and differs for another (Postgres accepts it: lambda-migrate.db.test.ts)', () => {
		const salt = Buffer.alloc(16, 7);
		const v = scramSha256Verifier('pencil', salt);
		expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
		expect(v.split('$')[1]).toBe(`4096:${salt.toString('base64')}`);
		expect(scramSha256Verifier('pencil', salt)).toBe(v);
		expect(scramSha256Verifier('pencil', Buffer.alloc(16, 8))).not.toBe(v);
		expect(scramSha256Verifier('pencil')).not.toBe(scramSha256Verifier('pencil'));
		expect(v).not.toContain('pencil');
	});
});
