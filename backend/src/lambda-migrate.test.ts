import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MigrateError } from '../scripts/migrate.js';
import { failureSummary, handler } from './lambda-migrate.js';

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

	it('the bundle carries the reference loaders but no raster code (geo/loadCropland.ts, the feeds’ GeoTIFF reader)', async () => {
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
		expect(inputs.filter((f) => /geo\/loadCropland\.ts$|feeds\/sources\/tiff\.ts$/.test(f))).toEqual([]);
	}, 60_000);
});
