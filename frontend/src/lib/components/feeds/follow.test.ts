import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller, fetchOutcome, FOLLOW_DELAYS_MS, outcomeMessage, STILL_WAITING } from './follow';

describe('fetchOutcome: has the followed fetch run?', () => {
	const feed = { enabled: true, lastAttemptAt: '2026-10-26T08:00:00Z', consecutiveFailures: 0 };
	it('waits while lastAttemptAt is what it was when Run now was pressed', () => {
		expect(fetchOutcome('2026-10-26T08:00:00Z', feed)).toBe('waiting');
		expect(fetchOutcome(null, { ...feed, lastAttemptAt: null })).toBe('waiting');
	});
	it('is done, or failed, once a result moved it', () => {
		expect(fetchOutcome(null, feed)).toBe('done');
		expect(fetchOutcome('2026-10-25T08:00:00Z', feed)).toBe('done');
		expect(fetchOutcome('2026-10-25T08:00:00Z', { ...feed, consecutiveFailures: 2 })).toBe('failed');
	});
	it('is gone when the feed was removed or switched off meanwhile', () => {
		expect(fetchOutcome(null, undefined)).toBe('gone');
		expect(fetchOutcome(null, { ...feed, enabled: false })).toBe('gone');
	});
});

describe('outcomeMessage', () => {
	const f = { targetKind: 'rain_chirps_mm', targetName: '', lastError: 'the source is unreachable: HTTP 502' };
	it('says the row’s health after a fetch that worked', () => {
		expect(outcomeMessage('done', f, 'OK; newest data 25 Oct 2026, checked 26 Oct 2026.', null)).toBe(
			'Fetch done: Rainfall — CHIRPS. OK; newest data 25 Oct 2026, checked 26 Oct 2026.'
		);
	});
	it('says why it failed and when it tries again', () => {
		expect(outcomeMessage('failed', f, 'ignored', 'It tries again after 10:13.')).toBe('Fetch failed: Rainfall — CHIRPS: the source is unreachable: HTTP 502. It tries again after 10:13.');
		expect(outcomeMessage('failed', { ...f, lastError: null }, 'ignored', null)).toBe('Fetch failed: Rainfall — CHIRPS: unknown error.');
	});
});

describe('createPoller', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('polls on the schedule until the poll says nothing is left', async () => {
		let left = 3;
		const poll = vi.fn(async () => --left > 0);
		const onGiveUp = vi.fn();
		const p = createPoller({ poll, onGiveUp, delays: [100, 100, 100, 100, 100] });
		p.start();
		expect(poll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(99);
		expect(poll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(poll).toHaveBeenCalledTimes(3);
		expect(onGiveUp).not.toHaveBeenCalled();
		expect(p.active).toBe(false);
	});

	it('gives up once the cap runs out, after the last poll', async () => {
		const poll = vi.fn(async () => true);
		const onGiveUp = vi.fn();
		const p = createPoller({ poll, onGiveUp, delays: [10, 20, 30] });
		p.start();
		await vi.advanceTimersByTimeAsync(59);
		expect(poll).toHaveBeenCalledTimes(2);
		expect(onGiveUp).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(poll).toHaveBeenCalledTimes(3);
		expect(onGiveUp).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(poll).toHaveBeenCalledTimes(3);
	});

	it('the default cap is modest: about two minutes, never faster than every 2 s', () => {
		const total = FOLLOW_DELAYS_MS.reduce((a, b) => a + b, 0);
		expect(total).toBe(120_000);
		expect(Math.min(...FOLLOW_DELAYS_MS)).toBe(2_000);
		expect(STILL_WAITING).toBe('The fetch is still waiting to run. Refresh status will show it once it has.');
	});

	it('a failed poll keeps the schedule going', async () => {
		const poll = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(false);
		const p = createPoller({ poll, onGiveUp: vi.fn(), delays: [10, 10, 10] });
		p.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(poll).toHaveBeenCalledTimes(2);
		expect(p.active).toBe(false);
	});

	it('doesn’t poll while the page is hidden, and polls at once when it shows again', async () => {
		let hidden = false;
		const poll = vi.fn(async () => true);
		const p = createPoller({ poll, onGiveUp: vi.fn(), delays: [100, 100, 100], hidden: () => hidden });
		p.start();
		hidden = true;
		p.pause();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(poll).not.toHaveBeenCalled();
		hidden = false;
		p.resume();
		await vi.advanceTimersByTimeAsync(0);
		expect(poll).toHaveBeenCalledTimes(1);
		// Then on with the schedule.
		await vi.advanceTimersByTimeAsync(100);
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it('stops for good (the panel unmounting), even mid-poll, and start() can’t revive it', async () => {
		let release!: (v: boolean) => void;
		const poll = vi.fn(() => new Promise<boolean>((r) => (release = r)));
		const onGiveUp = vi.fn();
		const p = createPoller({ poll, onGiveUp, delays: [10, 10] });
		p.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(poll).toHaveBeenCalledTimes(1);
		p.stop();
		release(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(poll).toHaveBeenCalledTimes(1);
		p.start();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(onGiveUp).not.toHaveBeenCalled();
	});

	it('start() again restarts the schedule from its first wait', async () => {
		const poll = vi.fn(async () => true);
		const p = createPoller({ poll, onGiveUp: vi.fn(), delays: [10, 1_000, 1_000] });
		p.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(poll).toHaveBeenCalledTimes(1);
		p.start();
		await vi.advanceTimersByTimeAsync(10);
		expect(poll).toHaveBeenCalledTimes(2);
	});
});
