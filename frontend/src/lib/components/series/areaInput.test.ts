// The Data tab's model input cache (issue #553 round 5): one fetch shared, a failure retried, and an answer that
// arrives after the inputs changed never kept. Synthetic input only.
import { describe, expect, it } from 'vitest';
import type { ModelInput } from '@water-management/engine';
import { ModelInputCache } from './areaInput';

const input = (tag: string) => ({ settings: {}, model: { nodes: [] }, series: {}, tag }) as unknown as ModelInput;
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

describe('ModelInputCache', () => {
	it('two callers at once share one fetch, and the input is kept', async () => {
		let calls = 0;
		const cache = new ModelInputCache(async () => (calls++, input('a')));
		const [x, y] = await Promise.all([cache.get(), cache.get()]);
		expect(x).toBe(y);
		expect(await cache.get()).toBe(x);
		expect(calls).toBe(1);
	});

	it('a failed fetch is retried by the next caller', async () => {
		let calls = 0;
		const cache = new ModelInputCache(async () => {
			calls++;
			if (calls === 1) throw new Error('offline');
			return input('b');
		});
		await expect(cache.get()).rejects.toThrow('offline');
		expect(await cache.get()).toMatchObject({ tag: 'b' });
		expect(calls).toBe(2);
	});

	it('invalidate drops the input and makes an answer in flight stale: it is not kept, and the next get fetches again', async () => {
		const first = deferred<ModelInput>();
		const fetches = [first.promise, Promise.resolve(input('new'))];
		const cache = new ModelInputCache(() => fetches.shift()!);
		const gen = cache.generation;
		const old = cache.get();
		cache.invalidate();
		expect(cache.current(gen)).toBe(false);
		first.resolve(input('old'));
		expect(await old).toMatchObject({ tag: 'old' });
		expect(await cache.get()).toMatchObject({ tag: 'new' });
		expect(cache.current(cache.generation)).toBe(true);
	});
});
