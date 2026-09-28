import { describe, expect, it } from 'vitest';
import { vaalbankFixture } from './fixture';
import {
	clearAllSaved,
	clearSaved,
	keepsCopy,
	latestSavedNode,
	NO_COPY_KEY,
	readSaved,
	readUnit,
	SAVED_KEY,
	SAVED_MAX_AGE_MS,
	setKeepsCopy,
	writeSaved,
	writeUnit
} from './savedCopy';

function memory() {
	const m = new Map<string, string>();
	return {
		m,
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k)
	};
}

const T0 = Date.UTC(2024, 0, 19, 5, 42);
const view = vaalbankFixture();

describe('the saved copy (§9)', () => {
	it('keeps the last good view per user and farm, and shows it with when it was saved', () => {
		const s = memory();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(readSaved('u1', 'p', 'n1', T0 + 1000, s)).toEqual({ view, savedAt: T0, usedAt: T0 + 1000 });
		expect(readSaved('u1', 'p', 'n2', T0, s)).toBeNull();
		expect(readSaved('u1', 'q', 'n1', T0, s)).toBeNull();
	});

	it('finds the farm of a project shown last, for a visit without ?node=', () => {
		const s = memory();
		expect(latestSavedNode('u1', 'p', s)).toBeNull();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		writeSaved('u1', 'p', 'n2', view, T0 + 5, s);
		writeSaved('u1', 'q', 'n3', view, T0 + 9, s);
		expect(latestSavedNode('u1', 'p', s)).toBe('n2');
		readSaved('u1', 'p', 'n1', T0 + 10, s);
		expect(latestSavedNode('u1', 'p', s)).toBe('n1');
		expect(latestSavedNode('u2', 'p', s)).toBeNull();
	});

	it('is cleared when a different user signs in on the phone', () => {
		const s = memory();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(readSaved('u2', 'p', 'n1', T0, s)).toBeNull();
		expect(s.m.has(SAVED_KEY)).toBe(false);
		// and a write by the new user starts afresh
		writeSaved('u1', 'p', 'n1', view, T0, s);
		writeSaved('u2', 'p', 'n2', view, T0, s);
		expect(readSaved('u2', 'p', 'n1', T0, s)).toBeNull();
		expect(readSaved('u2', 'p', 'n2', T0, s)).not.toBeNull();
	});

	it('drops a copy unused for 30 days, and each showing restarts the clock', () => {
		const s = memory();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(readSaved('u1', 'p', 'n1', T0 + SAVED_MAX_AGE_MS - 1, s)).not.toBeNull();
		expect(readSaved('u1', 'p', 'n1', T0 + 2 * SAVED_MAX_AGE_MS - 2, s)).not.toBeNull();
		expect(readSaved('u1', 'p', 'n1', T0 + 3 * SAVED_MAX_AGE_MS, s)).toBeNull();
		expect(s.m.has(SAVED_KEY)).toBe(false);
	});

	it('forgets one farm (403/404), a project, or everything (sign-out)', () => {
		const s = memory();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		writeSaved('u1', 'p', 'n2', view, T0, s);
		writeSaved('u1', 'q', 'n3', view, T0, s);
		clearSaved('p', 'n1', s);
		expect(readSaved('u1', 'p', 'n1', T0, s)).toBeNull();
		expect(readSaved('u1', 'p', 'n2', T0, s)).not.toBeNull();
		clearSaved('p', undefined, s);
		expect(readSaved('u1', 'p', 'n2', T0, s)).toBeNull();
		expect(readSaved('u1', 'q', 'n3', T0, s)).not.toBeNull();
		clearAllSaved(s);
		expect(s.m.has(SAVED_KEY)).toBe(false);
	});

	it('keeps nothing once "Don’t keep a copy on this phone" is chosen, and clears what was kept', () => {
		const s = memory();
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(keepsCopy(s)).toBe(true);
		setKeepsCopy(false, s);
		expect(s.m.get(NO_COPY_KEY)).toBe('1');
		expect(s.m.has(SAVED_KEY)).toBe(false);
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(s.m.has(SAVED_KEY)).toBe(false);
		setKeepsCopy(true, s);
		writeSaved('u1', 'p', 'n1', view, T0, s);
		expect(readSaved('u1', 'p', 'n1', T0, s)).not.toBeNull();
	});

	it('drops a copy kept in an older format (one notice; English and Afrikaans fields) rather than show it, and never leaves it behind', () => {
		for (const old of ['wm.farm.saved.v1', 'wm.farm.saved.v2']) {
			const s = memory();
			s.m.set(old, JSON.stringify({ userId: 'u1', entries: { 'p/n1': { view, savedAt: T0, usedAt: T0 } } }));
			expect(readSaved('u1', 'p', 'n1', T0, s)).toBeNull();
			expect(s.m.has(old)).toBe(false);
			s.m.set(old, '{}');
			clearAllSaved(s);
			expect(s.m.has(old)).toBe(false);
			s.m.set(old, '{}');
			setKeepsCopy(false, s);
			expect(s.m.has(old)).toBe(false);
		}
	});

	it('treats broken, blocked or missing storage as "no copy"', () => {
		const s = memory();
		s.m.set(SAVED_KEY, '{not json');
		expect(readSaved('u1', 'p', 'n1', T0, s)).toBeNull();
		const throwing = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {
				throw new Error('SecurityError');
			}
		};
		expect(() => writeSaved('u1', 'p', 'n1', view, T0, throwing)).not.toThrow();
		expect(readSaved('u1', 'p', 'n1', T0, throwing)).toBeNull();
		expect(() => clearAllSaved(throwing)).not.toThrow();
		expect(() => setKeepsCopy(false, throwing)).not.toThrow();
		expect(readSaved('u1', 'p', 'n1', T0, null)).toBeNull();
		expect(() => writeSaved('u1', 'p', 'n1', view, T0, null)).not.toThrow();
	});
});

describe('the volume unit', () => {
	it('defaults to m³ and remembers ML', () => {
		const s = memory();
		expect(readUnit(s)).toBe('m3');
		writeUnit('ML', s);
		expect(readUnit(s)).toBe('ML');
		writeUnit('m3', s);
		expect(readUnit(s)).toBe('m3');
		expect(readUnit(null)).toBe('m3');
	});
});
