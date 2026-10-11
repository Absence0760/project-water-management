// The shared explanations switch (explain.svelte.ts): off until ticked, remembered under one key, the same
// value for every form that reads it, and still a switch when storage throws (private mode).
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

function storage(start: Record<string, string> = {}) {
	const m = new Map(Object.entries(start));
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('explainSwitch', () => {
	it('starts off, remembers a tick under wm.settings.explain, and is one value for every reader', async () => {
		const s = storage();
		vi.stubGlobal('localStorage', s);
		const { explainSwitch, EXPLAIN_KEY } = await import('./explain.svelte');
		expect(EXPLAIN_KEY).toBe('wm.settings.explain');
		expect(explainSwitch.on).toBe(false);
		const seen: boolean[] = [];
		const stop = $effect.root(() => {
			$effect(() => {
				seen.push(explainSwitch.on);
			});
		});
		flushSync();
		explainSwitch.set(true);
		flushSync();
		expect(seen).toEqual([false, true]);
		expect(s.m.get(EXPLAIN_KEY)).toBe('1');
		explainSwitch.set(false);
		expect(s.m.get(EXPLAIN_KEY)).toBe('0');
		stop();
	});

	it('reads a remembered tick, and holds for the visit when storage throws', async () => {
		vi.stubGlobal('localStorage', storage({ 'wm.settings.explain': '1' }));
		expect((await import('./explain.svelte')).explainSwitch.on).toBe(true);
		vi.resetModules();
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('denied');
			}
		});
		const { explainSwitch } = await import('./explain.svelte');
		expect(explainSwitch.on).toBe(false);
		explainSwitch.set(true);
		expect(explainSwitch.on).toBe(true);
	});
});
