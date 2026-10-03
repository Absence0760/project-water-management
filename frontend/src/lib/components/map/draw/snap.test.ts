// Snapping while drawing (snap.ts; issue #326 C2): a plain projection stands
// in for the map's, 10 000 px to a degree, y down.
import { describe, expect, it } from 'vitest';
import type { MapFeature, MapPosition } from '$lib/api/types';
import { snapLines, snapPoint, traceAlong, type SnapLine } from './snap';

const project = (q: MapPosition) => ({ x: (q[0] - 21) * 10000, y: -(q[1] + 33) * 10000 });
const screen = (lon: number, lat: number) => project([lon, lat]);

function feature(id: string, kind: MapFeature['kind'], name: string, geometry: MapFeature['geometry']): MapFeature {
	return { id, kind, name, nodeId: null, nodeName: null, damPosition: null, geometry, properties: {}, areaM2: null, center: [0, 0], sourceId: null, createdBy: null, createdAt: '', updatedAt: '' };
}

const parcel = feature('p', 'farm_parcel', 'Upper farm', {
	type: 'Polygon',
	coordinates: [
		[
			[21.1, -33.1],
			[21.2, -33.1],
			[21.2, -33.2],
			[21.1, -33.2],
			[21.1, -33.1]
		]
	]
});
const river = feature('r', 'river', '', {
	type: 'LineString',
	coordinates: [
		[21.0, -33.3],
		[21.1, -33.3],
		[21.2, -33.35]
	]
});
const gauge = feature('g', 'gauge', 'G1', { type: 'Point', coordinates: [21.3, -33.3] });

describe('snapLines', () => {
	it('lists each outline (unclosed), line and point, named, and leaves out the feature being edited', () => {
		const lines = snapLines([parcel, river, gauge], 'g');
		expect(lines.map((l) => [l.featureId, l.label, l.coords.length, l.closed])).toEqual([
			['p', '“Upper farm”', 4, true],
			['r', 'a river', 3, false]
		]);
	});
});

describe('snapPoint', () => {
	const lines = snapLines([parcel, river, gauge]);

	it('lands on a corner within reach, even when an edge is nearer', () => {
		// 8 px from the corner (21.2, -33.1), 2 px from its edge.
		const hit = snapPoint({ x: screen(21.2, -33.1).x - 2, y: screen(21.2, -33.1).y + 8 }, lines, project);
		expect(hit).toMatchObject({ at: [21.2, -33.1], what: 'corner', pos: 1 });
		expect(hit!.line.featureId).toBe('p');
	});

	it('lands on the nearest edge when no corner is in reach, at the foot of the perpendicular', () => {
		const p = screen(21.15, -33.1);
		const hit = snapPoint({ x: p.x, y: p.y - 5 }, lines, project);
		expect(hit).toMatchObject({ at: [21.15, -33.1], what: 'edge' });
		expect(hit!.pos).toBeCloseTo(0.5, 9);
	});

	it('snaps to a river and to a point', () => {
		expect(snapPoint({ x: screen(21.05, -33.3).x, y: screen(21.05, -33.3).y + 3 }, lines, project)).toMatchObject({ at: [21.05, -33.3], what: 'edge' });
		expect(snapPoint({ x: screen(21.3, -33.3).x + 4, y: screen(21.3, -33.3).y }, lines, project)).toMatchObject({ at: [21.3, -33.3], what: 'corner' });
	});

	it('finds nothing out of reach, and nothing in a box the line misses', () => {
		expect(snapPoint({ x: screen(21.15, -33.15).x, y: screen(21.15, -33.15).y }, lines, project)).toBeNull();
		const p = screen(21.2, -33.1);
		expect(snapPoint(p, lines, project, 12, [22, -34, 22.1, -33.9])).toBeNull();
		expect(snapPoint(p, lines, project, 12, [21.19, -33.11, 21.21, -33.09])).toMatchObject({ at: [21.2, -33.1] });
	});
});

describe('traceAlong', () => {
	const ring: SnapLine = { featureId: 'p', part: 0, label: '', closed: true, coords: snapLines([parcel])[0]!.coords };
	const line: SnapLine = { featureId: 'r', part: 0, label: '', closed: false, coords: snapLines([river])[0]!.coords };

	it('takes the corners between two places on an outline, the shorter way round', () => {
		// From the middle of the north edge (0.5) to the middle of the east edge (1.5): one corner between.
		expect(traceAlong(ring, 0.5, 1.5, [21.15, -33.1], [21.2, -33.15])).toEqual([[21.2, -33.1]]);
		// Backwards round: from the north edge's middle to the west edge's middle (3.5) passes corner 0.
		expect(traceAlong(ring, 0.5, 3.5, [21.15, -33.1], [21.1, -33.15])).toEqual([[21.1, -33.1]]);
		// Across the wrap, corner to corner: 3 → 1 the short way is via 0.
		expect(traceAlong(ring, 3, 1, [21.1, -33.2], [21.2, -33.1])).toHaveLength(1);
	});

	it('takes nothing between neighbours on one edge, or the same place', () => {
		expect(traceAlong(ring, 0.2, 0.7, [21.12, -33.1], [21.17, -33.1])).toEqual([]);
		expect(traceAlong(ring, 2, 2, [21.2, -33.2], [21.2, -33.2])).toEqual([]);
	});

	it('runs an open line either way, never round', () => {
		expect(traceAlong(line, 0.5, 1.5, [21.05, -33.3], [21.15, -33.325])).toEqual([[21.1, -33.3]]);
		expect(traceAlong(line, 1.5, 0, [21.15, -33.325], [21.0, -33.3])).toEqual([[21.1, -33.3]]);
		expect(traceAlong(line, 0, 2, [21.0, -33.3], [21.2, -33.35])).toEqual([[21.1, -33.3]]);
	});
});
