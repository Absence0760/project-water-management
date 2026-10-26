import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApanDailyFingerprint } from '@water-management/engine';
import { apanFingerprint, forgetApanFingerprints } from './apanFingerprint';

// The app's API instance reads SvelteKit's env; these tests pass their own fetch.
vi.mock('#lib/api/index.js', () => ({ api: {} }));

const fp = (n: number) => ({ digest: `d${n}` }) as unknown as ApanDailyFingerprint;

describe('apanFingerprint (issue #586 round 3)', () => {
	beforeEach(forgetApanFingerprints);

	it('fetches a version of the series once, however often it is asked for', async () => {
		const fetch = vi.fn(async () => fp(1));
		const meta = { id: 's1', updatedAt: '2026-10-01T00:00:00Z' };
		const [a, b] = await Promise.all([apanFingerprint('p1', meta, fetch), apanFingerprint('p1', meta, fetch)]);
		expect(await apanFingerprint('p1', meta, fetch)).toBe(a);
		expect(b).toBe(a);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('fetches again for a new version, another series or another project', async () => {
		const fetch = vi.fn(async () => fp(fetch.mock.calls.length));
		await apanFingerprint('p1', { id: 's1', updatedAt: 'a' }, fetch);
		await apanFingerprint('p1', { id: 's1', updatedAt: 'b' }, fetch);
		await apanFingerprint('p1', { id: 's2', updatedAt: 'b' }, fetch);
		await apanFingerprint('p2', { id: 's2', updatedAt: 'b' }, fetch);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it('forgets a failed fetch, so the next ask tries again', async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(fp(2));
		const meta = { id: 's1', updatedAt: 'a' };
		await expect(apanFingerprint('p1', meta, fetch)).rejects.toThrow('offline');
		expect(await apanFingerprint('p1', meta, fetch)).toEqual(fp(2));
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
