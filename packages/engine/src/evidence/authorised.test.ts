// The full-authorised-use board's mix and its fixed rows (licensing build
// item 8; docs/model.md §2.14a). Invented volumes.
import { describe, expect, it } from 'vitest';
import { authorisedMix, authorisedUnavailable } from './authorised';

describe('authorisedMix', () => {
	it('sums the volumes by how they are held, entitlements first, and says which are an entitlement', () => {
		const mix = authorisedMix([
			{ volumeM3PerYear: 100, authorisation: 'registration' },
			{ volumeM3PerYear: 50, authorisation: 'licence' },
			{ volumeM3PerYear: 25, authorisation: 'existing_lawful_use' },
			{ volumeM3PerYear: 10, authorisation: 'existing_lawful_use_claimed' },
			{ volumeM3PerYear: 5, authorisation: 'registration' },
			{ volumeM3PerYear: 7, authorisation: 'schedule_1' },
			{ volumeM3PerYear: 3, authorisation: 'general_authorisation' },
			// A volume whose row is gone, or holds a value the app doesn't know: unknown, never an entitlement.
			{ volumeM3PerYear: 2, authorisation: null }
		])!;
		expect(mix.rows).toEqual([
			{ authorisation: 'licence', volumeM3PerYear: 50, entitlement: true },
			{ authorisation: 'existing_lawful_use', volumeM3PerYear: 25, entitlement: true },
			{ authorisation: 'registration', volumeM3PerYear: 105, entitlement: false },
			{ authorisation: 'existing_lawful_use_claimed', volumeM3PerYear: 10, entitlement: false },
			{ authorisation: 'general_authorisation', volumeM3PerYear: 3, entitlement: false },
			{ authorisation: 'schedule_1', volumeM3PerYear: 7, entitlement: false },
			{ authorisation: 'unknown', volumeM3PerYear: 2, entitlement: false }
		]);
		expect(mix.entitlementM3PerYear).toBe(75);
		expect(mix.totalM3PerYear).toBe(202);
	});

	it('counts no storage-only registration (s21b) and no empty volume; none at all is null', () => {
		expect(authorisedMix([{ volumeM3PerYear: 100, authorisation: 'licence', waterUse: '21b' }])).toBeNull();
		expect(authorisedMix([{ volumeM3PerYear: 0, authorisation: 'licence' }])).toBeNull();
		expect(authorisedMix([])).toBeNull();
		expect(authorisedMix([{ volumeM3PerYear: 9, authorisation: 'licence', waterUse: '21a' }])!.totalM3PerYear).toBe(9);
	});
});

describe('authorisedUnavailable', () => {
	it('is a fixed row with why, and no board or mix', () => {
		expect(authorisedUnavailable('notBuilt')).toEqual({ status: 'notBuilt', detail: null, board: null, mix: null, builtAt: null, engineVersion: null });
		expect(authorisedUnavailable('stale', 'run on engine 1.0.0', { builtAt: '2026-10-01T00:00:00Z', engineVersion: '1.0.0' })).toMatchObject({
			status: 'stale',
			detail: 'run on engine 1.0.0',
			builtAt: '2026-10-01T00:00:00Z',
			engineVersion: '1.0.0'
		});
	});
});
