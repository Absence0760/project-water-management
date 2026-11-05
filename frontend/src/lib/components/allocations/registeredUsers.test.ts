import { describe, expect, it } from 'vitest';
import type { Allocation } from '#lib/api/types.js';
import { NOT_MATCHED, registeredUsers, registeredUsersCsv, unitSubtotals } from './registeredUsers';

let n = 0;
const alloc = (over: Partial<Allocation>): Allocation => ({
	id: `a${++n}`,
	nodeId: 'u1',
	nodeName: 'Upper',
	sourceId: null,
	registrationNo: `R-${n}`,
	propertyRef: '',
	holder: null,
	authorisation: 'licence',
	purpose: 'irrigation',
	waterSource: 'surface',
	volumeM3PerYear: 0,
	storageM3: null,
	irrigatedAreaHa: null,
	validFrom: null,
	validTo: null,
	reference: '',
	months: null,
	maxRateM3s: null,
	conditions: [],
	waterUse: '21a',
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	...over
});

const nodes = [
	{ id: 'u1', name: 'Upper' },
	{ id: 'u2', name: 'Lower' },
	{ id: 'u3', name: 'Empty' }
];
const DAY = '2026-11-05';

describe('registeredUsers', () => {
	const list = [
		// Joe on Upper: two takes on 123/456 (surface and groundwater), one with storage, plus a dam's 21b row.
		alloc({ propertyRef: '123/456', holder: 'Joe Bloggs (invented)', volumeM3PerYear: 100_000, irrigatedAreaHa: 12.5, storageM3: 20_000 }),
		alloc({ propertyRef: '123/456', holder: 'joe  bloggs (invented)', waterSource: 'groundwater', volumeM3PerYear: 8_000 }),
		alloc({ propertyRef: '123/456', holder: 'Joe Bloggs (invented)', waterUse: '21b', storageM3: 50_000 }),
		// Jane on Upper, a second farm of Joe's on Lower.
		alloc({ propertyRef: '99/1', holder: 'Jane Doe (invented)', volumeM3PerYear: 40_000, irrigatedAreaHa: 5 }),
		alloc({ nodeId: 'u2', nodeName: 'Lower', propertyRef: '200/7', holder: 'Joe Bloggs (invented)', volumeM3PerYear: 30_000 }),
		// Not in force today: lapsed, and not yet started.
		alloc({ propertyRef: '123/456', holder: 'Joe Bloggs (invented)', volumeM3PerYear: 999_999, validTo: '2020-12-31' }),
		alloc({ nodeId: 'u2', propertyRef: '300/1', holder: 'Later (invented)', volumeM3PerYear: 999_999, validFrom: '2027-01-01' }),
		// In force on the day's edges.
		alloc({ nodeId: 'u2', propertyRef: '200/8', holder: 'Edge (invented)', volumeM3PerYear: 1_000, validFrom: DAY, validTo: DAY }),
		// Not matched to a unit.
		alloc({ nodeId: null, nodeName: null, propertyRef: '1/1', holder: 'Nobody (invented)', volumeM3PerYear: 15_000 })
	];
	const t = registeredUsers(list, nodes, DAY);

	it('groups the users by unit in the units’ order, leaves out a unit with none, and puts the not matched last', () => {
		expect(t.groups.map((g) => g.name)).toEqual(['Upper', 'Lower', NOT_MATCHED]);
		expect(t.groups.at(-1)!.nodeId).toBeNull();
	});

	it('adds up a user’s authorisations in force on one farm: takes for the volume and area, 21b rows and a take’s storage for the dam', () => {
		const joe = t.groups[0]!.rows.find((r) => r.farmNo === '123/456')!;
		expect(joe).toMatchObject({ holder: 'Joe Bloggs (invented)', authorisations: 3, volumeM3: 108_000, areaHa: 12.5, storageM3: 70_000 });
		// The same name on another unit and farm is its own row.
		expect(t.groups[1]!.rows.map((r) => [r.farmNo, r.holder])).toEqual([
			['200/7', 'Joe Bloggs (invented)'],
			['200/8', 'Edge (invented)']
		]);
	});

	it('leaves out what isn’t in force today, counting it, and keeps a row in force on its first and last day', () => {
		expect(t.notInForce).toBe(2);
		expect(t.groups.flatMap((g) => g.rows).some((r) => (r.volumeM3 ?? 0) > 500_000)).toBe(false);
		expect(t.groups[1]!.rows[1]!.volumeM3).toBe(1_000);
	});

	it('says none (null) for a figure no row states, never 0', () => {
		const jane = t.groups[0]!.rows.find((r) => r.farmNo === '99/1')!;
		expect(jane.storageM3).toBeNull();
		const storageOnly = registeredUsers([alloc({ propertyRef: '5/5', waterUse: '21b', storageM3: 10_000 })], nodes, DAY);
		expect(storageOnly.groups[0]!.rows[0]).toMatchObject({ volumeM3: null, areaHa: null, storageM3: 10_000 });
		expect(storageOnly.total).toEqual({ volumeM3: null, areaHa: null, storageM3: 10_000 });
	});

	it('sums each unit’s users into its subtotal, and the subtotals into the catchment total', () => {
		expect(t.groups.map((g) => g.subtotal)).toEqual([
			{ volumeM3: 148_000, areaHa: 17.5, storageM3: 70_000 },
			{ volumeM3: 31_000, areaHa: null, storageM3: null },
			{ volumeM3: 15_000, areaHa: null, storageM3: null }
		]);
		expect(t.total).toEqual({ volumeM3: 194_000, areaHa: 17.5, storageM3: 70_000 });
		expect(t.users).toBe(5);
		for (const g of t.groups) expect(g.subtotal.volumeM3).toBe(g.rows.reduce((s, r) => s + (r.volumeM3 ?? 0), 0));
		expect(unitSubtotals(t)).toEqual(
			new Map([
				['u1', t.groups[0]!.subtotal],
				['u2', t.groups[1]!.subtotal]
			])
		);
	});

	it('with names hidden, one row per unit and farm number, no name in it', () => {
		const hidden = list.map((a) => ({ ...a, holder: null }));
		const h = registeredUsers(hidden, nodes, DAY, false);
		expect(h.groups.flatMap((g) => g.rows).every((r) => r.holder === null)).toBe(true);
		expect(h.groups[0]!.rows.map((r) => r.farmNo)).toEqual(['99/1', '123/456']);
		// Names the API did send are dropped too, so a stale copy can't show one.
		expect(registeredUsers(list, nodes, DAY, false).groups.flatMap((g) => g.rows).every((r) => r.holder === null)).toBe(true);
		expect(h.total).toEqual(t.total);
	});

	it('writes the CSV with each unit’s subtotal and the catchment total, and no name column without names', () => {
		const csv = registeredUsersCsv(t, true).split('\r\n');
		expect(csv[0]).toBe('farm_no,registered_user,hydrological_unit,registered_irrigated_area_ha,registered_farm_dam_capacity_m3,registered_water_use_m3_a');
		expect(csv).toContain('123/456,Joe Bloggs (invented),Upper,12.5,70000,108000');
		expect(csv).toContain('Subtotal: Upper,,Upper,17.5,70000,148000');
		expect(csv.at(-2)).toBe('Catchment total,,,17.5,70000,194000');
		const anon = registeredUsersCsv(registeredUsers(list, nodes, DAY, false), false);
		expect(anon.split('\r\n')[0]).not.toContain('registered_user');
		expect(anon).not.toContain('invented');
	});
});
