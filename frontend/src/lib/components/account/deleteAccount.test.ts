import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { soleHoldingsOf } from './deleteAccount';

const refused = (details: unknown, code = 'account_sole_holder', status = 409) => new ApiError(status, 'x', details, code);

describe('soleHoldingsOf', () => {
	it('reads the projects and teams a refused deletion names', () => {
		const details = { projects: [{ id: 'p1', name: 'Kloof' }], teams: [{ id: 't1', name: 'Hydro', extra: true }] };
		expect(soleHoldingsOf(refused(details))).toEqual({ projects: [{ id: 'p1', name: 'Kloof' }], teams: [{ id: 't1', name: 'Hydro' }] });
	});

	it('is null for any other failure, or a body it can’t trust (the generic message shows instead)', () => {
		expect(soleHoldingsOf(new Error('x'))).toBeNull();
		expect(soleHoldingsOf(refused({ projects: [], teams: [] }, 'wrong_current_password', 403))).toBeNull();
		expect(soleHoldingsOf(refused({ projects: [{ id: 'p1', name: 'Kloof' }], teams: [] }, 'other'))).toBeNull();
		expect(soleHoldingsOf(refused({ projects: [], teams: [] }))).toBeNull();
		expect(soleHoldingsOf(refused({ projects: [{ id: 1, name: 'Kloof' }], teams: [] }))).toBeNull();
		expect(soleHoldingsOf(refused(undefined))).toBeNull();
	});
});
