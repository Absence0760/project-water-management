import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitMetricLine, lambdaJsonLogs, logEvent } from './logEvent.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// What Lambda's Node runtime client (aws-lambda-ric LogPatch) makes of a
// console call under the JSON log format: exactly one argument becomes
// `message` as is, anything else a util.format string. Reproduced here so the
// test reads the line the way the CloudWatch metric filters do.
function lambdaJsonRecord(level: string, args: unknown[]): Record<string, unknown> {
	const message = args.length === 1 ? args[0] : args.map(String).join(' ');
	return JSON.parse(JSON.stringify({ timestamp: '2026-09-29T00:00:00.000Z', level, requestId: 'r1', message }));
}

describe('lambdaJsonLogs', () => {
	it('follows AWS_LAMBDA_LOG_FORMAT, case-insensitively, as the runtime client does', () => {
		expect(lambdaJsonLogs({ AWS_LAMBDA_LOG_FORMAT: 'JSON' })).toBe(true);
		expect(lambdaJsonLogs({ AWS_LAMBDA_LOG_FORMAT: 'json' })).toBe(true);
		expect(lambdaJsonLogs({ AWS_LAMBDA_LOG_FORMAT: 'Text' })).toBe(false);
		expect(lambdaJsonLogs({})).toBe(false);
	});
});

describe('logEvent', () => {
	it('off Lambda, writes one JSON string per line at the given console level', () => {
		vi.stubEnv('AWS_LAMBDA_LOG_FORMAT', '');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		logEvent('error', { event: 'mail_send_failed', kind: 'alert', error: 'Throttling' });
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'mail_send_failed', kind: 'alert', error: 'Throttling' }));
	});

	it('under the JSON log format, passes one object, so the event lands at $.message.event (the alarm filters, infra/alarms.tf)', () => {
		vi.stubEnv('AWS_LAMBDA_LOG_FORMAT', 'JSON');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logEvent('warn', { event: 'login_failed', route: '/auth/login', reason: 'bad_password' });
		expect(warn).toHaveBeenCalledTimes(1);
		const args = warn.mock.calls[0]!;
		expect(args).toHaveLength(1);
		const record = lambdaJsonRecord('WARN', args);
		expect((record.message as { event: string }).event).toBe('login_failed');
		expect(record.message).toEqual({ event: 'login_failed', route: '/auth/login', reason: 'bad_password' });
	});

	it('under the JSON log format, a JSON string would be unreachable by a JSON filter (why the object form)', () => {
		const record = lambdaJsonRecord('ERROR', [JSON.stringify({ event: 'unhandled_error' })]);
		expect(typeof record.message).toBe('string');
	});

	it.each([
		['info', 'info'],
		['warn', 'warn'],
		['error', 'error']
	] as const)('level %s goes to console.%s (which the runtime records at that level)', (level, method) => {
		vi.stubEnv('AWS_LAMBDA_LOG_FORMAT', 'JSON');
		const spy = vi.spyOn(console, method).mockImplementation(() => {});
		logEvent(level, { event: 'x' });
		expect(spy).toHaveBeenCalledWith({ event: 'x' });
	});
});

describe('emitMetricLine', () => {
	it('writes the line to stdout with a newline, bypassing the console wrapper', () => {
		vi.stubEnv('AWS_LAMBDA_LOG_FORMAT', 'JSON');
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		emitMetricLine('{"_aws":{}}');
		expect(write).toHaveBeenCalledWith('{"_aws":{}}\n');
		expect(info).not.toHaveBeenCalled();
	});
});
