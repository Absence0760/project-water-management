import { afterEach, describe, expect, it } from 'vitest';
import type { ShareLink } from '$lib/api/types';
import { EXPIRY_CHOICES, linkRow, linkState, linkTarget, revokeQuestion, sortLinks } from './shareLinks';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const link = (over: Partial<ShareLink> = {}): ShareLink => ({
	id: 'a',
	label: 'Catchment forum',
	createdAt: '2026-09-24T22:30:00Z',
	createdBy: 'Jo Owner',
	expiresAt: '2026-10-24T22:30:00Z',
	revokedAt: null,
	targetKind: null,
	targetId: null,
	target: null,
	mine: true,
	revokedBy: null,
	lastUsedAt: null,
	...over
});

describe('linkState', () => {
	it('is live until it expires, and withdrawn once revoked whatever the date', () => {
		expect(linkState(link(), NOW)).toBe('live');
		expect(linkState(link({ expiresAt: '2026-09-25T12:00:00Z' }), NOW)).toBe('expired');
		expect(linkState(link({ revokedAt: '2026-09-25T10:00:00Z' }), NOW)).toBe('revoked');
		expect(linkState(link({ revokedAt: '2026-09-01T10:00:00Z', expiresAt: '2026-09-02T00:00:00Z' }), NOW)).toBe('revoked');
	});
});

describe('linkRow', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('writes dates where the owner is (a skewed zone moves the day)', () => {
		process.env.TZ = 'Africa/Johannesburg';
		expect(linkRow(link({ lastUsedAt: '2026-09-25T05:42:00Z' }), NOW)).toEqual({
			id: 'a',
			label: 'Catchment forum',
			state: 'live',
			created: '2026-09-25 by Jo Owner',
			ends: '2026-10-25',
			lastUsed: '2026-09-25 07:42',
			opens: 'The published baseline',
			opensNothing: null,
			canRevoke: true
		});
		process.env.TZ = 'Pacific/Pago_Pago';
		expect(linkRow(link(), NOW)).toMatchObject({ created: '2026-09-24 by Jo Owner', ends: '2026-10-24', lastUsed: 'Never' });
	});

	it('says who withdrew it, and offers no revoke on a dead link', () => {
		process.env.TZ = 'UTC';
		expect(linkRow(link({ revokedAt: '2026-09-25T10:00:00Z', revokedBy: 'Sam Owner' }), NOW)).toMatchObject({ state: 'revoked', ends: 'Withdrawn 2026-09-25 by Sam Owner', canRevoke: false });
		expect(linkRow(link({ revokedAt: '2026-09-25T10:00:00Z', revokedBy: null, createdBy: null }), NOW)).toMatchObject({ ends: 'Withdrawn 2026-09-25', created: '2026-09-24' });
		expect(linkRow(link({ expiresAt: '2026-09-20T00:00:00Z' }), NOW)).toMatchObject({ state: 'expired', canRevoke: false });
	});
});

describe('the list', () => {
	it('puts live links first, keeping the API’s order within each group', () => {
		const links = [link({ id: '1', revokedAt: '2026-09-25T00:00:00Z' }), link({ id: '2' }), link({ id: '3', expiresAt: '2026-09-01T00:00:00Z' }), link({ id: '4' })];
		expect(sortLinks(links, NOW).map((l) => l.id)).toEqual(['2', '4', '1', '3']);
	});

	it('offers lifetimes the API accepts, and asks before a revoke', () => {
		for (const c of EXPIRY_CHOICES) expect(c.days >= 1 && c.days <= 365).toBe(true);
		expect(revokeQuestion('Forum')).toContain('“Forum”');
		expect(revokeQuestion('Forum', 'Application “Raise”')).toContain('“Forum” (application “Raise”)?');
	});
});

describe('what a link opens', () => {
	const app = (target: ShareLink['target']) => link({ targetKind: 'scenario', targetId: 's1', target });

	it('names the baseline or the application, and opens while the application is submitted or decided', () => {
		expect(linkTarget(link())).toEqual({ opens: 'The published baseline', opensNothing: null });
		expect(linkTarget(app({ name: 'Raise my dam', status: 'submitted' }))).toEqual({ opens: 'Application “Raise my dam”', opensNothing: null });
		expect(linkTarget(app({ name: 'Raise my dam', status: 'decided' })).opensNothing).toBeNull();
	});

	it('says why a live link opens nothing: its application withdrawn, or one the owner can no longer read', () => {
		expect(linkTarget(app({ name: 'Raise my dam', status: 'withdrawn' }))).toMatchObject({ opens: 'Application “Raise my dam”', opensNothing: expect.stringMatching(/withdrawn/) });
		expect(linkTarget(app(null))).toMatchObject({ opens: 'An application you can’t open', opensNothing: expect.stringMatching(/opens nothing/) });
		// The row carries both.
		expect(linkRow(app({ name: 'X', status: 'withdrawn' }), NOW)).toMatchObject({ state: 'live', opens: 'Application “X”', canRevoke: true });
	});
});
