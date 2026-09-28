// "I understand" pressed without a signal (issue #74, after #47): the farm
// notice's acknowledgement is recorded by POST /auth/me/farm-notice, which
// needs a connection. Without one the press is kept here, on the phone, for
// this user and this notice version; the gate then shows the figures (the
// saved copy) and the page sends it once the signal is back. The server
// stamps the time when it arrives (093's app_user_farm_notice_stamp), never
// the phone's.
//
// It holds a user id and a version date, nothing else. It counts only for
// the same user and the version this build shows: another account on the
// phone, or a new notice version, finds none and sees the notice. Every
// storage access is wrapped, as in savedCopy.ts: no storage just means the
// press isn't kept, and the notice shows again.
import { classify } from './load';

export const PENDING_ACK_KEY = 'wm.farm.notice-ack.v1';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(s?: Storage | null): Storage | null {
	if (s !== undefined) return s;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

interface Pending {
	userId: string;
	version: string;
}

function read(s: Storage): Pending | null {
	try {
		const raw = s.getItem(PENDING_ACK_KEY);
		if (!raw) return null;
		const v = JSON.parse(raw) as Pending;
		return v && typeof v.userId === 'string' && typeof v.version === 'string' ? v : null;
	} catch {
		return null;
	}
}

/** Whether this user pressed "I understand" on this version on this phone, and it isn't recorded yet. */
export function hasPendingAck(userId: string, version: string, s?: Storage | null): boolean {
	const st = storage(s);
	const p = st && read(st);
	return !!p && p.userId === userId && p.version === version;
}

/** Keep a press made without a signal. false when storage can't hold it (the notice then stays). */
export function savePendingAck(userId: string, version: string, s?: Storage | null): boolean {
	const st = storage(s);
	if (!st) return false;
	try {
		st.setItem(PENDING_ACK_KEY, JSON.stringify({ userId, version } satisfies Pending));
		return true;
	} catch {
		return false;
	}
}

export function clearPendingAck(s?: Storage | null): void {
	try {
		storage(s)?.removeItem(PENDING_ACK_KEY);
	} catch {
		// Blocked storage: nothing was kept.
	}
}

/**
 * What to do after sending a kept press: `recorded` (the server has it, drop
 * it here), `keep` (still no signal, or the server failed: try again later),
 * or `refused` (a 4xx, e.g. 409 farm_notice_changed: drop it, and the notice
 * shows again).
 */
export function flushOutcome(e: unknown | null): 'recorded' | 'keep' | 'refused' {
	if (e === null) return 'recorded';
	if (classify(e) === 'offline') return 'keep';
	const status = e && typeof e === 'object' && 'status' in e ? (e as { status: unknown }).status : null;
	return typeof status === 'number' && status >= 400 && status < 500 ? 'refused' : 'keep';
}
