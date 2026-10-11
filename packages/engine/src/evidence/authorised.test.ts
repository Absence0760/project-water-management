// The full-authorised-use board's mix and its fixed rows (licensing build
// item 8; docs/model.md §2.14a). Invented volumes.
import { describe, expect, it } from 'vitest';
import { authorisedMix, authorisedUnavailable, foldedMix, isMixShares, mixShares } from './authorised';

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

describe('foldedMix (a viewer kept from each registered volume: evidence-18, #523 G1/H/J, D3)', () => {
	/** No m³ anywhere in a share-only mix: no volume field, no total, no figure of the entries' volumes. */
	const noM3 = (mix: object, volumes: readonly number[]) => {
		const text = JSON.stringify(mix);
		expect(text).not.toMatch(/M3|volume|total/i);
		for (const v of volumes) expect(text).not.toMatch(new RegExp(`(^|\\D)${v}(\\D|$)`));
	};

	it('shows each way of holding 5 or more hold as a whole-percent share, and pools the rest in "other" when the pool has 5 or more', () => {
		const mix = foldedMix([...held('registration', 500), ...held('licence', 70, 1), ...held('existing_lawful_use', 30, 3), ...held('general_authorisation', 8, 2)])!;
		// 500 and 108 (70 + 30 + 8) of 608.
		expect(mix.rows).toEqual([
			{ authorisation: 'registration', sharePct: 82, entitlement: false },
			{ authorisation: 'other', sharePct: 18, entitlement: false }
		]);
		expect(mix).toMatchObject({ entitlementPct: 0, folded: true, shares: true });
		expect(mix.leftOutHolders).toBeUndefined();
		expect(mix.someLeftOut).toBeUndefined();
		noM3(mix, [500, 108, 608, 70]);
	});

	it('merges a pool of fewer than 5 into the smallest row that isn’t an entitlement, and gives no m³ to difference', () => {
		// Many registrations, a few claimed uses, and one licence: the licence holder's volume must not come out.
		const entries = [...held('registration', 600, 6), ...held('existing_lawful_use_claimed', 90, 5), ...held('licence', 70, 1)];
		const mix = foldedMix(entries)!;
		// 600 and 160 (90 + 70) of 760.
		expect(mix.rows).toEqual([
			{ authorisation: 'registration', sharePct: 79, entitlement: false },
			{ authorisation: 'existing_lawful_use_claimed', sharePct: 21, entitlement: false, withOthers: true }
		]);
		noM3(mix, [600, 160, 760, 70, 90]);
		// With only entitlements shown, the pool goes into the smallest, which is no longer one.
		const lic = foldedMix([...held('licence', 300), ...held('existing_lawful_use', 200), ...held('registration', 9, 2)])!;
		expect(lic.rows).toEqual([
			{ authorisation: 'licence', sharePct: 59, entitlement: true },
			{ authorisation: 'existing_lawful_use', sharePct: 41, entitlement: false, withOthers: true }
		]);
		expect(lic.entitlementPct).toBe(59);
	});

	it('leaves out a water source fewer than 5 hold, saying how many only when 5 or more, else only that some were', () => {
		const few = foldedMix([...held('licence', 500), ...held('licence', 40, 2, 'groundwater')])!;
		expect(few.rows).toEqual([{ authorisation: 'licence', sharePct: 100, entitlement: true }]);
		expect([few.someLeftOut, few.leftOutHolders]).toEqual([true, undefined]);
		// One holder alone: nothing shown, and no count of 1.
		const one = foldedMix(Array.from({ length: 5 }, () => ({ volumeM3PerYear: 10, authorisation: 'licence', waterSource: 'surface', holder: 'same' })))!;
		expect(one.rows).toEqual([]);
		expect(one.entitlementPct).toBe(0);
		expect(one.leftOutHolders).toBeUndefined();
		expect(one.someLeftOut).toBe(true);
		// Two sources of 3 holders each, beside a kept one: 6 left out, counted.
		const six = foldedMix([...held('registration', 100), ...held('licence', 10, 3, 'groundwater'), ...held('licence', 10, 3, 'other')])!;
		expect(six.leftOutHolders).toBe(6);
		expect(six.someLeftOut).toBeUndefined();
	});

	it('rounds by largest remainder so the shares add up to 100, and passes a share-only mix through', () => {
		const thirds = mixShares({
			rows: (['licence', 'registration', 'schedule_1'] as const).map((k) => ({ authorisation: k, volumeM3PerYear: 1, entitlement: k === 'licence' })),
			entitlementM3PerYear: 1,
			totalM3PerYear: 3,
			folded: true,
			leftOutHolders: 7
		});
		expect(thirds.rows.map((r) => r.sharePct)).toEqual([34, 33, 33]);
		expect(thirds).toMatchObject({ entitlementPct: 34, leftOutHolders: 7, shares: true, folded: true });
		expect(mixShares(thirds)).toBe(thirds);
		expect(isMixShares(thirds)).toBe(true);
		expect(isMixShares(authorisedMix(held('licence', 10))!)).toBe(false);
	});

	it('#523 H: a row out of force today moves no figure a viewer can difference against their live totals', () => {
		// The review's probe: 5 surface holders, one row expired (123 457 m³/a), four of 50 000 with no dates. The
		// viewer's live total today (backend volumeTotals) is the 4 in force, and gives none of the expired row; the
		// mix sums all 5, so an m³ total beside it would give 123 457 by subtraction. As shares there is no total.
		const entries = [
			{ volumeM3PerYear: 123_457, authorisation: 'licence', waterSource: 'surface', holder: 'expired', validTo: '2024-09-30' },
			...Array.from({ length: 4 }, (_, i) => ({ volumeM3PerYear: 50_000, authorisation: 'licence', waterSource: 'surface', holder: `h${i}` }))
		];
		const mix = foldedMix(entries)!;
		expect(mix.rows).toEqual([{ authorisation: 'licence', sharePct: 100, entitlement: true }]);
		noM3(mix, [123_457, 323_457, 200_000]);
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
