import { describe, expect, it } from 'vitest';
import type { Invite } from '$lib/api/types';
import { daysLeft, expiryText, resendWasMailed, upsertInvite } from './invites';

const inv = (id: string, email: string, extra: Partial<Invite> = {}): Invite => ({
	id,
	email,
	role: 'viewer',
	invitedBy: 'Ann',
	createdAt: '2026-09-20T00:00:00Z',
	expiresAt: '2026-09-27T00:00:00Z',
	expired: false,
	...extra
});

describe('upsertInvite', () => {
	it('adds new invites first and replaces one for the same id or address', () => {
		const a = inv('a', 'a@x.org');
		const b = inv('b', 'b@x.org');
		expect(upsertInvite([a], b).map((x) => x.id)).toEqual(['b', 'a']);
		expect(upsertInvite([a, b], { ...a, role: 'editor' })).toEqual([{ ...a, role: 'editor' }, b]);
		expect(upsertInvite([a, b], inv('a2', 'A@X.org')).map((x) => x.id)).toEqual(['a2', 'b']);
	});
});

describe('expiry', () => {
	const now = Date.parse('2026-09-23T12:00:00Z');
	it('counts whole days left, rounding up', () => {
		expect(daysLeft('2026-09-30T12:00:00Z', now)).toBe(7);
		expect(daysLeft('2026-09-30T11:00:00Z', now)).toBe(7);
		expect(daysLeft('2026-09-23T11:00:00Z', now)).toBe(0);
	});
	it('describes the expiry in words', () => {
		expect(expiryText({ expiresAt: '2026-09-29T12:00:00Z', expired: false }, now)).toBe('expires in 6 days');
		expect(expiryText({ expiresAt: '2026-09-24T01:00:00Z', expired: false }, now)).toBe('expires within a day');
		expect(expiryText({ expiresAt: '2026-09-22T12:00:00Z', expired: true }, now)).toBe('expired');
		// The server's flag wins even if the clocks disagree.
		expect(expiryText({ expiresAt: '2026-09-29T12:00:00Z', expired: true }, now)).toBe('expired');
	});
});

describe('resendWasMailed', () => {
	it('is true only when the expiry moved out', () => {
		expect(resendWasMailed({ expiresAt: '2026-09-27T00:00:00Z' }, { expiresAt: '2026-09-30T00:00:00Z' })).toBe(true);
		expect(resendWasMailed({ expiresAt: '2026-09-27T00:00:00Z' }, { expiresAt: '2026-09-27T00:00:00Z' })).toBe(false);
	});
});
