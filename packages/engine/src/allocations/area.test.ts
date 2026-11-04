import { describe, expect, it } from 'vitest';
import { compareIrrigatedAreas, plantedHaByNode, withIrrigatedAreas } from './area';
import { compareAllocations } from './compare';

const run = { startDate: '2001-10-01', endDate: '2003-09-30', tolerance: 0.1 };

describe('compareIrrigatedAreas: registered irrigated area against the planted crop areas', () => {
	it('sums each unit’s planted crop areas in hectares', () => {
		const m = plantedHaByNode([
			{ nodeId: 'A', areaM2: 300_000 },
			{ nodeId: 'A', areaM2: 120_000 },
			{ nodeId: 'B', areaM2: 0 },
			{ nodeId: 'C', areaM2: Number.NaN }
		]);
		expect(m.get('A')).toBeCloseTo(42, 9);
		expect(m.get('B')).toBe(0);
		expect(m.get('C')).toBe(0);
		expect(plantedHaByNode(null).size).toBe(0);
	});

	it('bands planted against registered as the comparison does, and says unregistered and none', () => {
		const out = compareIrrigatedAreas({
			...run,
			nodeIds: ['over', 'within', 'under', 'unreg', 'none', 'registeredOnly'],
			cropAreas: [
				{ nodeId: 'over', areaM2: 500_000 },
				{ nodeId: 'within', areaM2: 400_000 },
				{ nodeId: 'under', areaM2: 100_000 },
				{ nodeId: 'unreg', areaM2: 200_000 }
			],
			allocations: [
				{ nodeId: 'over', irrigatedAreaHa: 40 },
				{ nodeId: 'within', irrigatedAreaHa: 25 },
				{ nodeId: 'within', irrigatedAreaHa: 17 },
				{ nodeId: 'under', irrigatedAreaHa: 20 },
				{ nodeId: 'unreg', irrigatedAreaHa: null },
				{ nodeId: 'registeredOnly', irrigatedAreaHa: 5 }
			]
		});
		expect(out.get('over')).toEqual({ registeredHa: 40, modelledHa: 50, differenceHa: 10, status: 'over' });
		expect(out.get('within')).toMatchObject({ registeredHa: 42, status: 'within' });
		expect(out.get('under')).toMatchObject({ registeredHa: 20, modelledHa: 10, differenceHa: -10, status: 'under' });
		// A row that states no area is not an area of 0.
		expect(out.get('unreg')).toEqual({ registeredHa: null, modelledHa: 20, differenceHa: null, status: 'unregistered' });
		expect(out.get('none')).toEqual({ registeredHa: null, modelledHa: 0, differenceHa: null, status: 'none' });
		expect(out.get('registeredOnly')).toMatchObject({ registeredHa: 5, modelledHa: 0, status: 'under' });
	});

	it('counts only takes in force on some day of the run, never a storage-only (21b) row or an unmatched one', () => {
		const out = compareIrrigatedAreas({
			...run,
			nodeIds: ['A'],
			cropAreas: [{ nodeId: 'A', areaM2: 100_000 }],
			allocations: [
				{ nodeId: 'A', irrigatedAreaHa: 10, validFrom: '2003-09-30' },
				{ nodeId: 'A', irrigatedAreaHa: 100, validTo: '2001-09-30' },
				{ nodeId: 'A', irrigatedAreaHa: 100, validFrom: '2003-10-01' },
				{ nodeId: 'A', irrigatedAreaHa: 100, waterUse: '21b' },
				{ nodeId: null, irrigatedAreaHa: 100 }
			]
		});
		expect(out.get('A')).toMatchObject({ registeredHa: 10, modelledHa: 10, status: 'within' });
	});

	it('withIrrigatedAreas puts each unit’s area on the comparison at its band, and leaves the rest as it was', () => {
		const c = compareAllocations({
			startDate: run.startDate,
			tolerance: 0.2,
			nodes: [
				{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(730).fill(10) },
				{ nodeId: 'U', name: 'Works', kind: 'user', supplied: new Array(730).fill(5) }
			],
			allocations: [{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 3650 }]
		});
		expect(c.nodes[0]!.irrigatedArea).toBeUndefined();
		const w = withIrrigatedAreas(c, [{ nodeId: 'A', areaM2: 115_000 }], [{ nodeId: 'A', irrigatedAreaHa: 10 }]);
		// 11.5 ha against 10: within ±20 %, outside ±10 %.
		expect(w.nodes[0]!.irrigatedArea).toMatchObject({ registeredHa: 10, status: 'within' });
		expect(w.nodes[0]!.irrigatedArea!.modelledHa).toBeCloseTo(11.5, 9);
		expect(w.nodes[1]!.irrigatedArea).toEqual({ registeredHa: null, modelledHa: 0, differenceHa: null, status: 'none' });
		expect({ ...w.nodes[0], irrigatedArea: undefined }).toEqual({ ...c.nodes[0], irrigatedArea: undefined });
		expect(c.nodes[0]!.irrigatedArea).toBeUndefined();
	});
});
