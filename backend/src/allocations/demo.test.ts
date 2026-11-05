// The demo registered users (./demo.ts, docs/allocations.md § Demo registered
// users): invented names and farm numbers, figures from the unit's own inputs,
// the same for a project every time, different between projects.
import { describe, expect, it } from 'vitest';
import { DEMO_FARMERS } from './demoFarmers.js';
import { DEMO_REFERENCE, demoAllocations } from './demo.js';

const node = (id: string, name: string, kind: 'farm' | 'user' | 'gauge', sortOrder: number, extra: Record<string, unknown> = {}) =>
	({ id, name, kind, sortOrder, damCapacityM3: 0, ...extra }) as never;

const model = {
	nodes: [
		node('g', 'Weir', 'gauge', 1),
		node('a', 'Upper farm', 'farm', 2, { damCapacityM3: 200_000 }),
		node('b', 'Lower farm', 'farm', 3),
		node('c', 'Dry farm', 'farm', 4),
		node('t', 'Town', 'user', 5, { userDemandM3Day: Array(12).fill(500) })
	],
	cropAreas: [
		{ nodeId: 'a', cropId: 'x', areaM2: 400_000 },
		{ nodeId: 'b', cropId: 'x', areaM2: 150_000 },
		{ nodeId: 'b', cropId: 'y', areaM2: 50_000 }
	]
};

describe('demoAllocations', () => {
	const rows = demoAllocations(model, 'project-1');
	const takes = (id: string) => rows.filter((r) => r.nodeId === id && r.waterUse === '21a');

	it('gives every farm and water user two or three invented users, and the gauge none', () => {
		expect(rows.some((r) => r.nodeId === 'g')).toBe(false);
		for (const id of ['a', 'b', 'c', 't']) {
			const users = new Set(takes(id).map((r) => r.holder));
			expect(users.size, id).toBeGreaterThanOrEqual(2);
			expect(users.size, id).toBeLessThanOrEqual(3);
		}
		for (const r of rows) {
			expect(DEMO_FARMERS).toContain(r.holder);
			expect(r.holder).toMatch(/\(invented\)$/);
			expect(r.reference).toBe(DEMO_REFERENCE);
			expect(r.propertyRef).toMatch(/^[1-9]\d{2}\/[1-9]\d{0,2}$/);
		}
	});

	it('gives each user a farm number of their own and every row its own registration number', () => {
		const perUser = new Map(rows.map((r) => [`${r.nodeId}|${r.holder}`, r.propertyRef]));
		expect(new Set(perUser.values()).size).toBe(perUser.size);
		expect(new Set(rows.map((r) => r.registrationNo)).size).toBe(rows.length);
	});

	it('registers about the planted area, a volume from it and about the dam, shared among the users', () => {
		const area = (id: string) => takes(id).reduce((s, r) => s + (r.irrigatedAreaHa ?? 0), 0);
		const vol = (id: string) => takes(id).reduce((s, r) => s + r.volumeM3PerYear, 0);
		// 40 ha and 20 ha planted, × 0.8–1.15.
		expect(area('a')).toBeGreaterThanOrEqual(32);
		expect(area('a')).toBeLessThanOrEqual(46);
		expect(area('b')).toBeGreaterThanOrEqual(16);
		expect(area('b')).toBeLessThanOrEqual(23);
		// 6 000–9 000 m³ a hectare (within the rounding to 100 m³).
		expect(vol('a') / area('a')).toBeGreaterThan(5_900);
		expect(vol('a') / area('a')).toBeLessThan(9_100);
		// No crops: a volume and no irrigated area; a water user likewise, from its demand (182 500 m³ a year × 0.9–1.2).
		expect(takes('c').every((r) => r.irrigatedAreaHa === null && r.volumeM3PerYear > 0)).toBe(true);
		expect(takes('t').every((r) => r.irrigatedAreaHa === null && r.purpose === 'other')).toBe(true);
		expect(vol('t')).toBeGreaterThanOrEqual(164_000);
		expect(vol('t')).toBeLessThanOrEqual(219_100);
		// The dam: a storage-only row of the first user and the rest on the second's take, 200 000 × 0.85–1.1 in all.
		const a = rows.filter((r) => r.nodeId === 'a');
		const b21 = a.filter((r) => r.waterUse === '21b');
		expect(b21).toHaveLength(1);
		expect(b21[0]).toMatchObject({ volumeM3PerYear: 0, irrigatedAreaHa: null, waterSource: 'surface' });
		const storage = a.reduce((s, r) => s + (r.storageM3 ?? 0), 0);
		expect(storage).toBeGreaterThanOrEqual(170_000);
		expect(storage).toBeLessThanOrEqual(220_000);
		expect(a.filter((r) => r.waterUse === '21a' && r.storageM3 !== null)).toHaveLength(1);
		// No dam, no storage.
		expect(rows.filter((r) => r.nodeId === 'b').every((r) => r.storageM3 === null && r.waterUse === '21a')).toBe(true);
	});

	it('is the same for a project each time, and different for another', () => {
		expect(demoAllocations(model, 'project-1')).toEqual(rows);
		expect(demoAllocations(model, 'project-2')).not.toEqual(rows);
	});

	it('has nothing to load on a model with no farm or water user', () => {
		expect(demoAllocations({ nodes: [model.nodes[0]!], cropAreas: [] }, 'p')).toEqual([]);
	});
});
