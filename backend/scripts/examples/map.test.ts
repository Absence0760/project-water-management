// The Sandspruit example's invented map (map.ts) as the seed loads it: every
// geometry passes the import's own checks, everything lies inside the
// boundary and the synthetic quaternary dataset, parcels don't overlap, and
// each parcel's and dam's area matches the model it stands for.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkGeometry, pointInGeometry, type Geometry, type Position } from '../../src/geo/geojson.js';
import { buildExamples } from './catchments.js';
import { sandspruitMap } from './map.js';

const sandspruit = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'))!;
const features = sandspruitMap(sandspruit.model);
const boundary = features.find((f) => f.kind === 'catchment_boundary')!.geometry;

const vertices = (g: Geometry): Position[] =>
	g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates.flat() : [];
const bbox = (g: Geometry) => {
	const v = vertices(g);
	return { minX: Math.min(...v.map((p) => p[0])), maxX: Math.max(...v.map((p) => p[0])), minY: Math.min(...v.map((p) => p[1])), maxY: Math.max(...v.map((p) => p[1])) };
};

describe('the Sandspruit example map', () => {
	it('passes the import’s geometry checks, one boundary', () => {
		for (const f of features) expect(checkGeometry(f.geometry), f.name).not.toHaveProperty('problem');
		expect(features.filter((f) => f.kind === 'catchment_boundary')).toHaveLength(1);
	});

	it('has a parcel for every farm and a point for every gauge, named after the node', () => {
		const names = (kind: string) => features.filter((f) => f.kind === kind).map((f) => f.node);
		expect(names('farm_parcel').sort()).toEqual(sandspruit.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.name).sort());
		expect(names('gauge').sort()).toEqual(sandspruit.model.nodes.filter((n) => n.kind === 'gauge').map((n) => n.name).sort());
		for (const f of features.filter((f) => f.kind === 'farm_parcel' || f.kind === 'gauge')) expect(f.name).toBe(f.node);
	});

	it('draws each parcel to its modelled area and each dam to its full-supply area (within 1 %)', () => {
		for (const n of sandspruit.model.nodes.filter((n) => n.kind === 'farm')) {
			const parcel = checkGeometry(features.find((f) => f.kind === 'farm_parcel' && f.node === n.name)!.geometry) as { areaM2: number };
			expect(parcel.areaM2 / 1e6, n.name).toBeCloseTo(n.areaKm2, 0);
			expect(Math.abs(parcel.areaM2 / 1e6 / n.areaKm2 - 1), n.name).toBeLessThan(0.01);
			const dam = checkGeometry(features.find((f) => f.kind === 'dam' && f.node === n.name)!.geometry) as { areaM2: number };
			expect(Math.abs(dam.areaM2 / n.damAreaFullM2! - 1), n.name).toBeLessThan(0.01);
		}
	});

	it('draws a boundary about the size of the modelled catchment (within 20 %)', () => {
		const total = sandspruit.model.nodes.filter((n) => n.kind === 'farm').reduce((sum, n) => sum + n.areaKm2, 0);
		const drawn = (checkGeometry(boundary) as { areaM2: number }).areaM2 / 1e6;
		expect(drawn).toBeGreaterThan(total);
		expect(drawn / total - 1).toBeLessThan(0.2);
	});

	it('keeps every vertex inside the boundary', () => {
		for (const f of features.filter((f) => f.kind !== 'catchment_boundary')) {
			for (const p of vertices(f.geometry)) expect(pointInGeometry(p, boundary), `${f.name} ${p}`).toBe(true);
		}
	});

	it('lays the parcels side by side, none overlapping', () => {
		const parcels = features.filter((f) => f.kind === 'farm_parcel').map((f) => ({ name: f.name, ...bbox(f.geometry) }));
		for (const [i, a] of parcels.entries()) {
			for (const b of parcels.slice(i + 1)) {
				const apart = a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;
				expect(apart, `${a.name} / ${b.name}`).toBe(true);
			}
		}
	});

	it('lies inside the synthetic quaternary dataset, across more than one cell', () => {
		const cells = JSON.parse(readFileSync(new URL('../../fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as {
			features: { properties: { code: string }; geometry: Geometry }[];
		};
		const cellOf = (p: Position) => cells.features.find((c) => pointInGeometry(p, c.geometry))?.properties.code;
		for (const p of vertices(boundary)) expect(cellOf(p), String(p)).toBeDefined();
		const centres = features.filter((f) => f.kind === 'farm_parcel').map((f) => cellOf(vertices(f.geometry)[0]!));
		expect(new Set(centres).size).toBeGreaterThan(1);
	});
});
