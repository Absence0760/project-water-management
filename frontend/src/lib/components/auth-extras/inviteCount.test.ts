import { beforeEach, describe, expect, it, vi } from 'vitest';

const mine = vi.fn<() => Promise<unknown[]>>();
vi.mock('$lib/api', () => ({ api: { invites: { mine: () => mine() } } }));

const { invitesChanged, loadPendingInvites, pendingInvites } = await import('./inviteCount.svelte');

describe('the pending-invitations count (InvitesBanner, issue #136)', () => {
	beforeEach(() => {
		mine.mockReset();
		pendingInvites.user = null;
		pendingInvites.count = 0;
	});

	it('reads the count once per account, and again for another account', async () => {
		mine.mockResolvedValue([{}, {}]);
		await loadPendingInvites('u1');
		await loadPendingInvites('u1');
		expect(mine).toHaveBeenCalledTimes(1);
		expect(pendingInvites).toEqual({ user: 'u1', count: 2 });
		mine.mockResolvedValue([]);
		await loadPendingInvites('u2');
		expect(pendingInvites).toEqual({ user: 'u2', count: 0 });
		expect(mine).toHaveBeenCalledTimes(2);
	});

	it('reads again after a change, keeping the shown count until the new one arrives', async () => {
		mine.mockResolvedValue([{}, {}]);
		await loadPendingInvites('u1');
		let resolve!: (v: unknown[]) => void;
		mine.mockReturnValue(new Promise((r) => (resolve = r)));
		invitesChanged();
		expect(pendingInvites.count).toBe(2);
		resolve([{}]);
		await vi.waitFor(() => expect(pendingInvites.count).toBe(1));
	});

	it('keeps the count it had when the read fails, and does nothing before any account', async () => {
		mine.mockResolvedValue([{}]);
		await loadPendingInvites('u1');
		mine.mockRejectedValue(new Error('offline'));
		invitesChanged();
		await vi.waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
		expect(pendingInvites.count).toBe(1);
		pendingInvites.user = null;
		invitesChanged();
		expect(mine).toHaveBeenCalledTimes(2);
	});
});
