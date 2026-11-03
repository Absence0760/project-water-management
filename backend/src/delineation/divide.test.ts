// The pure parts of dividing a model that has nodes (divide.ts) that need no
// database; the routes and the plan are divide.db.test.ts's.
import { describe, expect, it } from 'vitest';
import { newUnitOverlaps, type Polygonal } from './divide.js';

const square = (x: number, y: number, size: number): Polygonal => ({
	type: 'Polygon',
	coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
});

describe('a new unit’s boundary against the units’ areas on the map (#670)', () => {
	const farm = { featureId: 'f-farm', name: 'Farm A', geometry: square(0, 0, 1) };
	const hill = { featureId: 'f-hill', name: 'Hillside', geometry: square(5, 5, 1) };

	it('names each unit whose area holds the new one, or lies inside it, and says that unit keeps its area', () => {
		const inside = newUnitOverlaps([{ key: 'n1', name: 'Sub-catchment 1', geometry: square(0.2, 0.2, 0.3) }], [farm, hill]);
		expect(inside).toEqual([
			'Sub-catchment 1 is a new unit, and its boundary overlaps Farm A’s area on the map. That unit keeps its area: dividing never takes land from a unit unseen, so the land they share counts twice until its boundary is redrawn on the map or a smaller area typed on the Network.'
		]);
		// A new unit around two units' areas names both.
		const around = newUnitOverlaps([{ key: 'n2', name: 'Big piece', geometry: square(-1, -1, 10) }], [farm, hill]);
		expect(around[0]).toMatch(/^Big piece is a new unit, and its boundary overlaps the areas of Farm A and Hillside on the map\. Those units keep their areas: .* until their boundaries are redrawn/);
	});

	it('says nothing for a new unit beside the others, or for its own outline', () => {
		expect(newUnitOverlaps([{ key: 'n3', name: 'Apart', geometry: square(2, 2, 1) }], [farm, hill])).toEqual([]);
		expect(newUnitOverlaps([{ key: 'f-farm', name: 'Same', geometry: farm.geometry }], [farm])).toEqual([]);
	});
});
