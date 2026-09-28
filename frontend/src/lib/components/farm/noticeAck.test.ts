// The notice acknowledgement kept on the phone when "I understand" is pressed
// without a signal (issue #74): it counts only for the same user and version,
// and a send's outcome decides whether it is kept.
import { describe, expect, it } from 'vitest';
import { clearPendingAck, flushOutcome, hasPendingAck, PENDING_ACK_KEY, savePendingAck } from './noticeAck';

function memory() {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('the kept acknowledgement', () => {
	it('counts for the same user and version only, and holds nothing but those', () => {
		const s = memory();
		expect(hasPendingAck('u1', '2026-09-01', s)).toBe(false);
		expect(savePendingAck('u1', '2026-09-01', s)).toBe(true);
		expect(hasPendingAck('u1', '2026-09-01', s)).toBe(true);
		// Another account on the phone, or a newer notice, sees the notice.
		expect(hasPendingAck('u2', '2026-09-01', s)).toBe(false);
		expect(hasPendingAck('u1', '2026-10-01', s)).toBe(false);
		expect(JSON.parse(s.m.get(PENDING_ACK_KEY)!)).toEqual({ userId: 'u1', version: '2026-09-01' });
		clearPendingAck(s);
		expect(hasPendingAck('u1', '2026-09-01', s)).toBe(false);
	});

	it('treats missing, blocked or garbled storage as nothing kept', () => {
		expect(savePendingAck('u1', 'v', null)).toBe(false);
		expect(hasPendingAck('u1', 'v', null)).toBe(false);
		const throwing = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		};
		expect(savePendingAck('u1', 'v', throwing)).toBe(false);
		expect(hasPendingAck('u1', 'v', throwing)).toBe(false);
		expect(() => clearPendingAck(throwing)).not.toThrow();
		const s = memory();
		s.setItem(PENDING_ACK_KEY, '{not json');
		expect(hasPendingAck('u1', 'v', s)).toBe(false);
	});
});

describe('sending it', () => {
	it('drops it once recorded or refused, keeps it without a signal or on a server failure', () => {
		expect(flushOutcome(null)).toBe('recorded');
		expect(flushOutcome({ status: 0 })).toBe('keep');
		expect(flushOutcome({ status: 503 })).toBe('keep');
		expect(flushOutcome(new Error('x'))).toBe('keep');
		// The notice changed since (409 farm_notice_changed), or the session is gone: the notice shows again.
		expect(flushOutcome({ status: 409, code: 'farm_notice_changed' })).toBe('refused');
		expect(flushOutcome({ status: 401 })).toBe('refused');
	});
});
