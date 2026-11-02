import { describe, expect, it } from 'vitest';
import { latestCall, latestOnly } from './latest';

/** A promise answered by hand, so a test chooses which request comes back first. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

describe('latestOnly', () => {
	it('keeps each check true only until a later request begins', () => {
		const latest = latestOnly();
		const a = latest.begin();
		expect(a()).toBe(true);
		const b = latest.begin();
		expect([a(), b()]).toEqual([false, true]);
	});
});

describe('latestCall (latest wins)', () => {
	it('drops an earlier call that answers after a later one', async () => {
		const pending: Record<string, ReturnType<typeof deferred<string>>> = {};
		const load = latestCall((key: string) => (pending[key] = deferred<string>()).promise);
		const first = load('A');
		const second = load('B');
		pending.B!.resolve('B');
		expect(await second).toEqual({ current: true, value: 'B' });
		pending.A!.resolve('A');
		expect(await first).toEqual({ current: false });
	});

	it('drops an earlier call’s failure too, and throws the latest one’s', async () => {
		const pending: Record<string, ReturnType<typeof deferred<string>>> = {};
		const load = latestCall((key: string) => (pending[key] = deferred<string>()).promise);
		const first = load('A');
		const second = load('B');
		pending.A!.reject(new Error('offline'));
		expect(await first).toEqual({ current: false });
		pending.B!.reject(new Error('down'));
		await expect(second).rejects.toThrow('down');
	});

	it('a call on its own is current, and so is the next one after it finished', async () => {
		const load = latestCall(async (n: number) => n * 2);
		expect(await load(1)).toEqual({ current: true, value: 2 });
		expect(await load(2)).toEqual({ current: true, value: 4 });
	});
});
