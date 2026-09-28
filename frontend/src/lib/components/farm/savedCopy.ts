// The saved copy on the phone (docs/design/farmer-view.md §9): the last good
// FarmView per user and farm, kept in localStorage so the next visit shows it
// at once (with "Updating…" or the offline strip) and a dropped signal after
// load still shows something.
//
// It holds only what the farmer may see anyway. It is cleared on sign-out, on
// a 403 or 404 for that farm, when a different user signs in on the phone,
// and after 30 days unused. "Don't keep a copy on this phone" (the farm
// Menu) turns it off and clears it, for a phone shared with a foreman or
// family. Every storage access is wrapped: private windows, full or blocked
// storage and a missing localStorage all just mean "no copy".
//
// The volume-unit choice lives here too, until the account preference
// (app_user.volume_unit, WP-2.5) exists.
import type { FarmView } from '@water-management/engine';
import type { VolumeUnit } from './format';

// v3: FarmView's notice became one map by language (issue #58); v2 had noticeEn / noticeAf (WP-2.5).
// An older copy is dropped, never shown without its notice.
export const SAVED_KEY = 'wm.farm.saved.v3';
const OLD_SAVED_KEYS = ['wm.farm.saved.v1', 'wm.farm.saved.v2'];
export const NO_COPY_KEY = 'wm.farm.no-copy';
export const UNIT_KEY = 'wm.farm.unit';
/** A copy nobody has opened for this long is dropped. */
export const SAVED_MAX_AGE_MS = 30 * 86_400_000;

export interface SavedEntry {
	view: FarmView;
	/** When the copy was fetched (ms since epoch): the offline strip's "saved at". */
	savedAt: number;
	/** When the copy was last shown. */
	usedAt: number;
}

interface Store {
	userId: string;
	entries: Record<string, SavedEntry>;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(s?: Storage | null): Storage | null {
	if (s !== undefined) return s;
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

const key = (projectId: string, nodeId: string) => `${projectId}/${nodeId}`;

/** Remove copies kept under an older format (they'd hold a farm's figures past sign-out otherwise). */
function dropOld(s: Storage): void {
	for (const k of OLD_SAVED_KEYS) s.removeItem(k);
}

function load(s: Storage): Store | null {
	try {
		dropOld(s);
		const raw = s.getItem(SAVED_KEY);
		if (!raw) return null;
		const v = JSON.parse(raw) as Store;
		return v && typeof v.userId === 'string' && v.entries && typeof v.entries === 'object' ? v : null;
	} catch {
		return null;
	}
}

function save(s: Storage, store: Store): void {
	try {
		if (Object.keys(store.entries).length) s.setItem(SAVED_KEY, JSON.stringify(store));
		else s.removeItem(SAVED_KEY);
	} catch {
		// Full or blocked storage: no copy this time.
	}
}

/** Drop entries unused for 30 days. */
function prune(store: Store, now: number): boolean {
	let changed = false;
	for (const [k, e] of Object.entries(store.entries)) {
		if (!e || typeof e.usedAt !== 'number' || now - e.usedAt > SAVED_MAX_AGE_MS) {
			delete store.entries[k];
			changed = true;
		}
	}
	return changed;
}

/** Whether this phone keeps copies (the Menu's "Don't keep a copy on this phone" turns it off). */
export function keepsCopy(s?: Storage | null): boolean {
	const st = storage(s);
	if (!st) return false;
	try {
		return st.getItem(NO_COPY_KEY) !== '1';
	} catch {
		return false;
	}
}

/** Turn copies on or off; off clears every copy at once. */
export function setKeepsCopy(keep: boolean, s?: Storage | null): void {
	const st = storage(s);
	if (!st) return;
	try {
		if (keep) st.removeItem(NO_COPY_KEY);
		else {
			st.setItem(NO_COPY_KEY, '1');
			st.removeItem(SAVED_KEY);
			dropOld(st);
		}
	} catch {
		// Nothing to do: storage is unavailable.
	}
}

/**
 * The saved copy of this farm for this user, marked as used now; null when
 * there is none. A store written for another user is cleared first.
 */
export function readSaved(userId: string, projectId: string, nodeId: string, now = Date.now(), s?: Storage | null): SavedEntry | null {
	const st = storage(s);
	if (!st || !keepsCopy(st)) return null;
	const store = load(st);
	if (!store) return null;
	if (store.userId !== userId) {
		clearAllSaved(st);
		return null;
	}
	let changed = prune(store, now);
	const e = store.entries[key(projectId, nodeId)] ?? null;
	if (e) {
		e.usedAt = now;
		changed = true;
	}
	if (changed) save(st, store);
	return e;
}

/**
 * The farm of this project whose copy was shown last, for a visit without
 * `?node=` (a farmer with one farm): the page can show its copy before the
 * farm list answers. null when there's none or it belongs to another user.
 */
export function latestSavedNode(userId: string, projectId: string, s?: Storage | null): string | null {
	const st = storage(s);
	if (!st || !keepsCopy(st)) return null;
	const store = load(st);
	if (!store || store.userId !== userId) return null;
	let best: [string, number] | null = null;
	for (const [k, e] of Object.entries(store.entries)) {
		if (!k.startsWith(`${projectId}/`) || typeof e?.usedAt !== 'number') continue;
		if (!best || e.usedAt > best[1]) best = [k.slice(projectId.length + 1), e.usedAt];
	}
	return best?.[0] ?? null;
}

/** Keep `view` as the copy of this farm (a no-op when copies are off). */
export function writeSaved(userId: string, projectId: string, nodeId: string, view: FarmView, now = Date.now(), s?: Storage | null): void {
	const st = storage(s);
	if (!st || !keepsCopy(st)) return;
	const prev = load(st);
	const store: Store = prev && prev.userId === userId ? prev : { userId, entries: {} };
	prune(store, now);
	store.entries[key(projectId, nodeId)] = { view, savedAt: now, usedAt: now };
	save(st, store);
}

/** Forget one farm's copy (a 403 or 404 for it), or every farm of a project when `nodeId` is omitted. */
export function clearSaved(projectId: string, nodeId?: string, s?: Storage | null): void {
	const st = storage(s);
	if (!st) return;
	const store = load(st);
	if (!store) return;
	for (const k of Object.keys(store.entries)) {
		if (nodeId ? k === key(projectId, nodeId) : k.startsWith(`${projectId}/`)) delete store.entries[k];
	}
	save(st, store);
}

/** Forget every copy (sign-out). */
export function clearAllSaved(s?: Storage | null): void {
	const st = storage(s);
	if (!st) return;
	try {
		st.removeItem(SAVED_KEY);
		dropOld(st);
	} catch {
		// Storage unavailable: nothing was kept.
	}
}

/** The farmer's volume unit on this phone; m³ by default (FV-D3). */
export function readUnit(s?: Storage | null): VolumeUnit {
	const st = storage(s);
	try {
		return st?.getItem(UNIT_KEY) === 'ML' ? 'ML' : 'm3';
	} catch {
		return 'm3';
	}
}

export function writeUnit(unit: VolumeUnit, s?: Storage | null): void {
	const st = storage(s);
	try {
		st?.setItem(UNIT_KEY, unit);
	} catch {
		// Not saved: the switch still works for this visit.
	}
}
