import { describe, expect, it, vi } from 'vitest';
import { loadOnce, peek, prefetch } from './lazy';

describe('loadOnce', () => {
	it('imports once however many callers ask, and peek sees the result', async () => {
		const load = vi.fn(async () => ({ default: 'Panel' }));
		expect(peek(load)).toBeUndefined();
		const [a, b] = await Promise.all([loadOnce(load), loadOnce(load)]);
		expect(a).toBe('Panel');
		expect(b).toBe('Panel');
		expect(await loadOnce(load)).toBe('Panel');
		expect(peek(load)).toBe('Panel');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('forgets a failed import so the next attempt fetches again', async () => {
		const load = vi
			.fn<() => Promise<{ default: string }>>()
			.mockRejectedValueOnce(new Error('chunk gone'))
			.mockResolvedValueOnce({ default: 'Panel' });
		await expect(loadOnce(load)).rejects.toThrow('chunk gone');
		expect(peek(load)).toBeUndefined();
		expect(await loadOnce(load)).toBe('Panel');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('keeps loaders apart', async () => {
		const one = async () => ({ default: 1 });
		const two = async () => ({ default: 2 });
		expect(await loadOnce(one)).toBe(1);
		expect(await loadOnce(two)).toBe(2);
	});
});

describe('prefetch', () => {
	it('warms the same promise the real load then uses', async () => {
		const load = vi.fn(async () => ({ default: 'Panel' }));
		prefetch(load);
		expect(await loadOnce(load)).toBe('Panel');
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed warm-up (no unhandled rejection); the real load reports it', async () => {
		const load = vi.fn(async (): Promise<{ default: string }> => {
			throw new Error('offline');
		});
		prefetch(load);
		await expect(loadOnce(load)).rejects.toThrow('offline');
	});
});
