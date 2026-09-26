import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteCounts } from '$lib/api/types';

const counts = vi.fn(async (projectId: string): Promise<NoteCounts> => ({ project: projectId.length, nodes: {}, runs: {}, settings: {} }));
vi.mock('$lib/api', () => ({ api: { notes: { counts: (id: string) => counts(id) } } }));

const { clearNoteCounts, noteCounts } = await import('./counts.svelte');

beforeEach(() => {
	clearNoteCounts();
	counts.mockClear();
});

describe('noteCounts', () => {
	it('shares one instance and one load between every badge of a project', async () => {
		const a = noteCounts('p1');
		expect(noteCounts('p1')).toBe(a);
		await Promise.all([a.ensure(), noteCounts('p1').ensure()]);
		expect(counts).toHaveBeenCalledTimes(1);
		expect(a.counts?.project).toBe(2);
	});

	it("drops a project's counts when another project is opened, so the cache never grows", async () => {
		const a = noteCounts('p1');
		await a.ensure();
		const b = noteCounts('p2');
		expect(b).not.toBe(a);
		expect(b.projectId).toBe('p2');
		// Back to the first project: a fresh instance, loaded again, not the first visit's numbers.
		const again = noteCounts('p1');
		expect(again).not.toBe(a);
		expect(again.counts).toBeNull();
		await again.ensure();
		expect(counts).toHaveBeenCalledTimes(2);
	});

	it('forgets the counts on sign-out, so the next account loads its own', async () => {
		const a = noteCounts('p1');
		await a.ensure();
		clearNoteCounts();
		const next = noteCounts('p1');
		expect(next).not.toBe(a);
		await next.ensure();
		expect(counts).toHaveBeenCalledTimes(2);
	});

	it('shows a failed load as `failed`, not as a thrown error', async () => {
		counts.mockRejectedValueOnce(new Error('offline'));
		const a = noteCounts('p3');
		await a.ensure();
		expect(a.failed).toBe(true);
		expect(a.counts).toBeNull();
	});
});
