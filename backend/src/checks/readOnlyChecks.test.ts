// The read-only production checks' event and registry (no database): an
// event names a check and carries nothing else, so no SQL can come from it.
// Running them, and that they can't write: readOnlyChecks.db.test.ts.
import { describe, expect, it } from 'vitest';
import { CHECKS, CheckError, parseCheckRequest } from './readOnlyChecks.js';

const code = (f: () => unknown) => {
	try {
		f();
	} catch (e) {
		return e instanceof CheckError ? [e.code, e.publicReason] : ['not a CheckError', String(e)];
	}
	return ['accepted', null];
};

describe('parseCheckRequest', () => {
	it('accepts each registered name, alone', () => {
		for (const name of Object.keys(CHECKS)) expect(parseCheckRequest({ check: name })).toBe(name);
	});

	it('refuses an unknown name with the stable code and the list of checks', () => {
		for (const check of ['nope', 'UNIT-RAIN-REFERENCE-RUNS', '', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
			const [c, reason] = code(() => parseCheckRequest({ check }));
			expect([check, c]).toEqual([check, 'refused']);
			expect(reason).toBe('check must be one of unit-rain-reference-runs, pre-213-cap-runs');
		}
	});

	it('takes no SQL: a query as the name, or as any other field, is refused', () => {
		for (const event of [
			{ check: 'SELECT email FROM app_user' },
			{ check: { sql: 'SELECT 1' } },
			{ check: ['unit-rain-reference-runs'] },
			{ check: 'unit-rain-reference-runs', sql: 'DELETE FROM model_run' },
			{ check: 'unit-rain-reference-runs', params: ['x'] },
			{ check: 'unit-rain-reference-runs', load: {} },
			{ sql: 'SELECT 1' }
		]) {
			expect(code(() => parseCheckRequest(event))[0]).toBe('refused');
		}
	});

	it('refuses a non-object event', () => {
		for (const event of [null, undefined, 'unit-rain-reference-runs', 1, []]) expect(code(() => parseCheckRequest(event))[0]).toBe('refused');
	});
});

describe('the registry', () => {
	it('every check is one SELECT with no parameters and no second statement', () => {
		for (const [name, c] of Object.entries(CHECKS)) {
			expect([name, /^\s*(SELECT|WITH)\b/i.test(c.sql)]).toEqual([name, true]);
			expect([name, /;|\$\d/.test(c.sql)]).toEqual([name, false]);
			expect([name, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|CALL)\b/i.test(c.sql)]).toEqual([name, false]);
		}
	});

	it('answers with ids, versions, modes, dates and flags only: no column that could be personal data or a figure', () => {
		const allowed = /^(id|run_id|project_id|engine_version|created_at|run_created_at|at|kind|mode|current)$/;
		for (const [name, c] of Object.entries(CHECKS)) expect([name, c.columns.filter((col) => !allowed.test(col))]).toEqual([name, []]);
	});
});
