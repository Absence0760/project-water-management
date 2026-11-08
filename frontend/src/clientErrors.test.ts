import { describe, expect, it } from 'vitest';
import { buildReport, describeThrown, errorId, LIMITS, pageError, shouldReport, truncate } from './clientErrors';

describe('truncate', () => {
	it('keeps a string at the limit, and cuts a longer one to the limit with an ellipsis', () => {
		expect(truncate('abcde', 5)).toBe('abcde');
		expect(truncate('abcdef', 5)).toBe('abcd…');
		expect(truncate('abcdef', 5)).toHaveLength(5);
	});
});

describe('errorId', () => {
	it('is the first 8 hex digits of the UUID, lower case', () => {
		expect(errorId('0A1B2C3D-4e5f-4000-8000-000000000000')).toBe('0a1b2c3d');
		expect(errorId(crypto.randomUUID())).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe('describeThrown', () => {
	it('reads an Error', () => {
		const e = new TypeError('boom');
		expect(describeThrown(e)).toEqual({ name: 'TypeError', message: 'boom', stack: e.stack });
	});

	it("reads Kit's error() body and anything else thrown", () => {
		expect(describeThrown({ status: 404, message: 'Not Found' })).toEqual({ name: 'Error', message: 'Not Found', stack: '' });
		expect(describeThrown('plain string')).toEqual({ name: 'string', message: 'plain string', stack: '' });
		expect(describeThrown(undefined)).toEqual({ name: 'undefined', message: 'undefined', stack: '' });
	});

	it('never throws, even for a value that refuses to be a string', () => {
		const hostile = { toString: () => { throw new Error('no'); } };
		expect(describeThrown(hostile)).toEqual({ name: 'unknown', message: 'An error that could not be described', stack: '' });
	});
});

describe('buildReport', () => {
	it('sends the id, status, error, path and version', () => {
		const e = new RangeError('Invalid time value');
		expect(buildReport({ id: '0a1b2c3d', status: 500, thrown: e, path: '/projects/p1/calibration?tab=x', version: '1762400000000' })).toEqual({
			id: '0a1b2c3d',
			status: 500,
			name: 'RangeError',
			message: 'Invalid time value',
			stack: e.stack,
			path: '/projects/p1/calibration?tab=x',
			version: '1762400000000'
		});
	});

	it("cuts every field to the API's limits", () => {
		const e = new Error('m'.repeat(2000));
		e.name = 'N'.repeat(1000);
		e.stack = 's'.repeat(10_000);
		const r = buildReport({ id: '0a1b2c3d', status: 500, thrown: e, path: '/'.repeat(2000), version: 'v'.repeat(500) });
		expect(r.name).toHaveLength(LIMITS.name);
		expect(r.message).toHaveLength(LIMITS.message);
		expect(r.stack).toHaveLength(LIMITS.stack);
		expect(r.path).toHaveLength(LIMITS.path);
		expect(r.version).toHaveLength(LIMITS.version);
	});

	it('sends 500 for a status the API would refuse', () => {
		expect(buildReport({ id: '0a1b2c3d', status: 42.5, thrown: 'x', path: '/', version: '' }).status).toBe(500);
		expect(buildReport({ id: '0a1b2c3d', status: 999, thrown: 'x', path: '/', version: '' }).status).toBe(500);
	});
});

describe('shouldReport and pageError', () => {
	it('reports a crash and shows its own message with the id', () => {
		const caught = { kind: 'unknown' as const, error: new TypeError("Cannot read properties of undefined (reading 'split')") };
		expect(shouldReport(caught)).toBe(true);
		expect(pageError(caught, '0a1b2c3d')).toEqual({ status: 500, message: "Cannot read properties of undefined (reading 'split')", id: '0a1b2c3d' });
	});

	it('cuts a long crash message, and says Internal Error for one without a message', () => {
		expect(pageError({ kind: 'unknown', error: new Error('x'.repeat(2000)) }, 'id').message).toHaveLength(LIMITS.message);
		expect(pageError({ kind: 'unknown', error: new Error('  ') }, 'id').message).toBe('Internal Error');
	});

	it("doesn't report a 404, and shows Kit's own message for it with no id (the log never saw it)", () => {
		const caught = { kind: 'framework' as const, error: { status: 404, message: 'Not Found' } };
		expect(shouldReport(caught)).toBe(false);
		expect(pageError(caught, '0a1b2c3d')).toEqual({ status: 404, message: 'Not Found' });
	});

	it('reports a 5xx thrown with error()', () => {
		expect(shouldReport({ kind: 'app', error: { status: 503, message: 'Down' } })).toBe(true);
		expect(pageError({ kind: 'app', error: { status: 503, message: 'Down' } }, 'abcdef01')).toEqual({ status: 503, message: 'Down', id: 'abcdef01' });
		expect(shouldReport({ kind: 'app', error: { status: 403, message: 'No' } })).toBe(false);
	});
});
