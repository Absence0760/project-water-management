import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendTimer } from './resendTimer.svelte';

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
afterEach(() => vi.useRealTimers());

describe('resendTimer', () => {
	it('starts at 0 (a send may go), counts down whole seconds from the clock, and ends at 0', () => {
		const t = resendTimer();
		expect(t.left).toBe(0);
		t.start(60);
		expect(t.left).toBe(60);
		vi.advanceTimersByTime(1500);
		expect(t.left).toBe(59);
		vi.advanceTimersByTime(58_500);
		expect(t.left).toBe(0);
		vi.advanceTimersByTime(5000);
		expect(t.left).toBe(0);
	});

	it('restarting takes the new count (the server’s 429 seconds), and stop leaves it to the clock', () => {
		const t = resendTimer();
		t.start(60);
		vi.advanceTimersByTime(10_000);
		t.start(12);
		expect(t.left).toBe(12);
		t.stop();
		vi.advanceTimersByTime(12_000);
		expect(t.left).toBe(0);
		t.start(-5);
		expect(t.left).toBe(0);
	});
});
