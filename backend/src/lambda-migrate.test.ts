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
