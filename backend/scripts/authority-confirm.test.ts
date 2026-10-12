// The operator's confirmation script (pnpm dev:authority:confirm, 233_authority_delegates): what it takes and refuses.
// The confirmation itself is authority_confirm_by_operator, tested in projects/authority-delegates.db.test.ts.
import { describe, expect, it } from 'vitest';
import { parseArgs } from './authority-confirm.js';

const P = '0f6f7c1e-3a52-4e3b-9d2a-6a1f0d1c2b3a';

describe('parseArgs', () => {
	it('takes a project id, an address and the authority’s reference, in any order', () => {
		expect(parseArgs([P, 'Lead@Example.com', '--reference', 'CMA letter 2026/14'])).toEqual({ projectId: P, email: 'lead@example.com', reference: 'CMA letter 2026/14' });
		expect(parseArgs(['--reference', 'DWS 1', P, 'a@example.com'])).toEqual({ projectId: P, email: 'a@example.com', reference: 'DWS 1' });
	});

	it('refuses a confirmation without the reference, or with a bad id or address', () => {
		expect(parseArgs([P, 'a@example.com'])).toMatch(/--reference/);
		expect(parseArgs([P, 'a@example.com', '--reference', '  '])).toMatch(/--reference/);
		expect(parseArgs(['not-a-uuid', 'a@example.com', '--reference', 'x'])).toMatch(/project’s id/);
		expect(parseArgs([P, 'nobody', '--reference', 'x'])).toMatch(/email/);
		expect(parseArgs([P, 'a@example.com', 'extra', '--reference', 'x'])).toMatch(/unexpected/);
		expect(parseArgs([P, 'a@example.com', '--reference', 'x'.repeat(201)])).toMatch(/200/);
	});
});
