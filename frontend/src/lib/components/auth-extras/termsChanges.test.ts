// The re-acceptance step's "what changed" lines (termsChanges.ts).
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { changesSince, TERMS_CHANGES } from './termsChanges';

const CHANGES = [
	{ version: '2026-10-03', items: ['map data'] },
	{ version: '2026-10-02', items: ['lawful bases', 'restores'] }
];

describe('changesSince', () => {
	it('lists every change after the version accepted, newest first, so a version between deploys is never hidden', () => {
		expect(changesSince(CHANGES, '2026-10-01')).toEqual(['map data', 'lawful bases', 'restores']);
		expect(changesSince(CHANGES, '2026-10-02')).toEqual(['map data']);
		expect(changesSince(CHANGES, '2026-10-03')).toEqual([]);
	});

	it('lists them all for an account that accepted none', () => {
		expect(changesSince(CHANGES, null)).toEqual(['map data', 'lawful bases', 'restores']);
	});
});

describe('TERMS_CHANGES', () => {
	it('starts with the version in force, newest first, with no version empty', () => {
		expect(TERMS_CHANGES[0]!.version).toBe(LEGAL_VERSION);
		for (let i = 1; i < TERMS_CHANGES.length; i++) expect(TERMS_CHANGES[i]!.version < TERMS_CHANGES[i - 1]!.version).toBe(true);
		for (const c of TERMS_CHANGES) expect(c.items.length, c.version).toBeGreaterThan(0);
	});
});
