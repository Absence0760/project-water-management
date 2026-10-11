// The full-authorised-use board's mix and its fixed rows (licensing build
// item 8; docs/model.md §2.14a). Invented volumes.
import { describe, expect, it } from 'vitest';
import { authorisedMix, authorisedUnavailable } from './authorised';

/** `n` holders' volumes of one kind on one source, `total` m³ a year between them. */
const held = (authorisation: string | null, total: number, n = 5, waterSource = 'surface', tag = authorisation ?? 'none') =>
	Array.from({ length: n }, (_, i) => ({ volumeM3PerYear: total / n, authorisation, waterSource, holder: `${tag}-${waterSource}-${i}` }));

describe('authorisedMix', () => {
	it('sums the volumes by how they are held, entitlements first, and says which are an entitlement', () => {
		const mix = authorisedMix([
			...held('registration', 100),
			...held('licence', 50),
			...held('existing_lawful_use', 25),
			...held('existing_lawful_use_claimed', 10),
			...held('registration', 5, 5, 'surface', 'reg2'),
			...held('schedule_1', 7),
			...held('general_authorisation', 3),
			// A volume whose row is gone, or holds a value the app doesn't know: unknown, never an entitlement.
			...held(null, 2)
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
		expect(mix).toMatchObject({ folded: true, leftOutHolders: 0 });
	});

	it('gives no fewer than 5 holders’ volume (issue #523 G1, D3): a way of holding held by fewer is pooled in "other", left out with the pool below 5', () => {
		// One licence holder and 3 verified existing lawful users: pooled, 4 holders, so left out with the totals.
		const small = authorisedMix([...held('registration', 500), ...held('licence', 70, 1), ...held('existing_lawful_use', 30, 3)])!;
		expect(small.rows).toEqual([{ authorisation: 'registration', volumeM3PerYear: 500, entitlement: false }]);
		expect([small.totalM3PerYear, small.entitlementM3PerYear, small.leftOutHolders]).toEqual([500, 0, 4]);
		// With 2 general authorisations as well, the pool has 6 holders: one "other" row, never an entitlement.
		const pooled = authorisedMix([...held('registration', 500), ...held('licence', 70, 1), ...held('existing_lawful_use', 30, 3), ...held('general_authorisation', 8, 2)])!;
		expect(pooled.rows).toEqual([
			{ authorisation: 'registration', volumeM3PerYear: 500, entitlement: false },
			{ authorisation: 'other', volumeM3PerYear: 108, entitlement: false }
		]);
		expect([pooled.totalM3PerYear, pooled.entitlementM3PerYear, pooled.leftOutHolders]).toEqual([608, 0, 0]);
		// One holder with five volumes is one holder.
		const one = authorisedMix(Array.from({ length: 5 }, () => ({ volumeM3PerYear: 10, authorisation: 'licence', waterSource: 'surface', holder: 'same' })))!;
		expect(one.rows).toEqual([]);
		expect(one.leftOutHolders).toBe(1);
	});

	it('leaves out a water source fewer than 5 hold, so no row less the viewer’s other totals gives it', () => {
		const mix = authorisedMix([...held('licence', 500), ...held('licence', 40, 2, 'groundwater')])!;
		expect(mix.rows).toEqual([{ authorisation: 'licence', volumeM3PerYear: 500, entitlement: true }]);
		expect([mix.totalM3PerYear, mix.leftOutHolders]).toEqual([500, 2]);
	});

	it('counts no storage-only registration (s21b) and no empty volume; none at all is null', () => {
		expect(authorisedMix([{ volumeM3PerYear: 100, authorisation: 'licence', waterUse: '21b' }])).toBeNull();
		expect(authorisedMix([{ volumeM3PerYear: 0, authorisation: 'licence' }])).toBeNull();
		expect(authorisedMix([])).toBeNull();
		expect(authorisedMix(held('licence', 9).map((e) => ({ ...e, waterUse: '21a' })))!.totalM3PerYear).toBe(9);
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
