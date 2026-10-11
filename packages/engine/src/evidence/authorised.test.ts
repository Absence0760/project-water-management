// The full-authorised-use board's mix and its fixed rows (licensing build
// item 8; docs/model.md §2.14a). Invented volumes.
import { describe, expect, it } from 'vitest';
import { authorisedMix, authorisedUnavailable, foldedMix } from './authorised';

/** `n` holders' volumes of one kind on one source, `total` m³ a year between them. */
const held = (authorisation: string | null, total: number, n = 5, waterSource = 'surface', tag = authorisation ?? 'none') =>
	Array.from({ length: n }, (_, i) => ({ volumeM3PerYear: total / n, authorisation, waterSource, holder: `${tag}-${waterSource}-${i}` }));

describe('authorisedMix (the full mix: editors, owners, the authority, the PDF)', () => {
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
		expect(mix.folded).toBeUndefined();
	});

	it('counts no storage-only registration (s21b) and no empty volume; none at all is null', () => {
		expect(authorisedMix([{ volumeM3PerYear: 100, authorisation: 'licence', waterUse: '21b' }])).toBeNull();
		expect(authorisedMix([{ volumeM3PerYear: 0, authorisation: 'licence' }])).toBeNull();
		expect(authorisedMix([])).toBeNull();
		expect(authorisedMix([{ volumeM3PerYear: 9, authorisation: 'licence', waterUse: '21a' }])!.totalM3PerYear).toBe(9);
		expect(foldedMix([{ volumeM3PerYear: 100, authorisation: 'licence', waterUse: '21b' }])).toBeNull();
	});
});

describe('foldedMix (a viewer kept from each registered volume: evidence-17, #523 G1, D3)', () => {
	it('shows each way of holding 5 or more hold, and pools the rest in "other" when the pool has 5 or more', () => {
		const mix = foldedMix([...held('registration', 500), ...held('licence', 70, 1), ...held('existing_lawful_use', 30, 3), ...held('general_authorisation', 8, 2)])!;
		expect(mix.rows).toEqual([
			{ authorisation: 'registration', volumeM3PerYear: 500, entitlement: false },
			{ authorisation: 'other', volumeM3PerYear: 108, entitlement: false }
		]);
		expect(mix).toMatchObject({ totalM3PerYear: 608, entitlementM3PerYear: 0, folded: true });
		expect(mix.leftOutHolders).toBeUndefined();
		expect(mix.someLeftOut).toBeUndefined();
	});

	it('merges a pool of fewer than 5 into the smallest row that isn’t an entitlement, so the total stays the sources’ and no difference gives it', () => {
		// Many registrations, a few claimed uses, and one licence: the licence holder's volume must not come out.
		const entries = [...held('registration', 600, 6), ...held('existing_lawful_use_claimed', 90, 5), ...held('licence', 70, 1)];
		const mix = foldedMix(entries)!;
		expect(mix.rows).toEqual([
			{ authorisation: 'registration', volumeM3PerYear: 600, entitlement: false },
			{ authorisation: 'existing_lawful_use_claimed', volumeM3PerYear: 160, entitlement: false, withOthers: true }
		]);
		// The viewer's per-source total (app_allocation_volumes, ≥ 5 holders) less the mix's total gives nothing.
		const sourceTotal = entries.reduce((s, e) => s + e.volumeM3PerYear, 0);
		expect(sourceTotal - mix.totalM3PerYear).toBeCloseTo(0, 9);
		// Nor any row less a known figure: 70 appears in no row and no total.
		expect(JSON.stringify(mix)).not.toMatch(/(^|\D)70(\D|$)/);
		// With only entitlements shown, the pool goes into the smallest, which is no longer one.
		const lic = foldedMix([...held('licence', 300), ...held('existing_lawful_use', 200), ...held('registration', 9, 2)])!;
		expect(lic.rows).toEqual([
			{ authorisation: 'licence', volumeM3PerYear: 300, entitlement: true },
			{ authorisation: 'existing_lawful_use', volumeM3PerYear: 209, entitlement: false, withOthers: true }
		]);
		expect(lic.entitlementM3PerYear).toBe(300);
	});

	it('leaves out a water source fewer than 5 hold, saying how many only when 5 or more, else only that some were', () => {
		const few = foldedMix([...held('licence', 500), ...held('licence', 40, 2, 'groundwater')])!;
		expect(few.rows).toEqual([{ authorisation: 'licence', volumeM3PerYear: 500, entitlement: true }]);
		expect([few.totalM3PerYear, few.someLeftOut, few.leftOutHolders]).toEqual([500, true, undefined]);
		// One holder alone: nothing shown, and no count of 1.
		const one = foldedMix(Array.from({ length: 5 }, () => ({ volumeM3PerYear: 10, authorisation: 'licence', waterSource: 'surface', holder: 'same' })))!;
		expect(one.rows).toEqual([]);
		expect(one.leftOutHolders).toBeUndefined();
		expect(one.someLeftOut).toBe(true);
		// Two sources of 3 holders each, beside a kept one: 6 left out, counted.
		const six = foldedMix([...held('registration', 100), ...held('licence', 10, 3, 'groundwater'), ...held('licence', 10, 3, 'other')])!;
		expect(six.leftOutHolders).toBe(6);
		expect(six.someLeftOut).toBeUndefined();
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
