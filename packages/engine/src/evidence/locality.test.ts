// § 1's locality map as the report keeps it (evidence-12, issue #326 A5;
// docs/evidence-pack.md § The locality map): which features, as what layer,
// under which label (never another unit's), rounded and simplified, with the
// date and source files; and the SVG's hash the backend stamps.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localityMapSvg, positionsOf } from '../geo/localityMap';
import { figureGeometry, localitySection, withLocalitySvgHash } from './locality';
import type { EvidenceMapFeatureInput, EvidenceReport } from './types';

const sq = (lon: number, lat: number, d: number): [number, number][] => [
	[lon, lat],
	[lon + d, lat],
	[lon + d, lat + d],
	[lon, lat + d],
	[lon, lat]
];
const f = (kind: EvidenceMapFeatureInput['kind'], nodeId: string | null, geometry: EvidenceMapFeatureInput['geometry'], over: Partial<EvidenceMapFeatureInput> = {}): EvidenceMapFeatureInput => ({
	kind,
	name: '',
	nodeId,
	geometry,
	updatedAt: '2026-09-28T10:00:00.000Z',
	source: null,
	...over
});
const model = { nodes: [{ id: 'A', name: 'Applicant farm' }, { id: 'B', name: 'Neighbour farm' }, { id: 'G1', name: 'Gauge one' }, { id: 'S1', name: 'Reserve weir' }] };
const ctx = { applicant: true, ownedNodeIds: ['A'], ewrSiteNodeIds: ['S1'], models: [model as never] };
const FILE = { fileName: 'parcels.geojson', sha256: 'b'.repeat(64), importedAt: '2026-09-20T09:00:00.000Z' };

describe('localitySection', () => {
	it('is null with no features, only "other" features, or none with a drawable geometry', () => {
		expect(localitySection(null, ctx)).toBeNull();
		expect(localitySection([], ctx)).toBeNull();
		expect(localitySection([f('other', null, { type: 'Point', coordinates: [21, -33] })], ctx)).toBeNull();
		expect(localitySection([f('river', null, { type: 'LineString', coordinates: [[21, -33]] })], ctx)).toBeNull();
		expect(localitySection([f('gauge', null, { type: 'Point', coordinates: [Number.NaN, -33] as never })], ctx)).toBeNull();
		// Positive control: one point is a figure.
		expect(localitySection([f('gauge', null, { type: 'Point', coordinates: [21, -33] })], ctx)?.features).toHaveLength(1);
	});

	it('sorts each feature into its layer: the applicant’s parcel and dam, the others’ unnamed, gauges and EWR sites by their node', () => {
		const loc = localitySection(
			[
				f('catchment_boundary', null, { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] }, { name: 'Boundary' }),
				f('farm_parcel', 'A', { type: 'Polygon', coordinates: [sq(21.31, -33.69, 0.02)] }),
				f('dam', 'A', { type: 'Point', coordinates: [21.32, -33.68] }),
				f('farm_parcel', 'B', { type: 'Polygon', coordinates: [sq(21.35, -33.69, 0.02)] }, { name: 'Neighbour’s home block' }),
				f('dam', 'B', { type: 'Polygon', coordinates: [sq(21.36, -33.68, 0.005)] }, { name: 'Neighbour dam' }),
				f('farm_parcel', null, { type: 'Polygon', coordinates: [sq(21.38, -33.69, 0.01)] }, { name: 'Unlinked parcel' }),
				f('river', null, { type: 'LineString', coordinates: [[21.3, -33.6], [21.4, -33.7]] }, { name: 'Sand River' }),
				f('gauge', 'G1', { type: 'Point', coordinates: [21.33, -33.64] }),
				f('gauge', 'S1', { type: 'Point', coordinates: [21.39, -33.69] }),
				f('gauge', null, { type: 'Point', coordinates: [21.34, -33.62] }, { name: 'Old weir' }),
				f('other', null, { type: 'Point', coordinates: [21.35, -33.65] }, { name: 'Pump house' })
			],
			ctx
		)!;
		// In drawing order: the boundary, the others' parcels and dams, the applicant's, rivers, then points.
		expect(loc.features.map((x) => [x.layer, x.label])).toEqual([
			['boundary', null],
			['parcel', null],
			['parcel', null],
			['dam', null],
			['applicantParcel', 'Applicant farm'],
			// The dam beside its parcel isn't named twice.
			['applicantDam', null],
			['river', null],
			['gauge', 'Gauge one'],
			['gauge', 'Old weir'],
			['ewrSite', 'Reserve weir']
		]);
		const text = JSON.stringify(loc);
		for (const hidden of ['Neighbour', 'Unlinked parcel', 'Pump house', '"B"', 'Sand River']) expect(text).not.toContain(hidden);
	});

	it('names the applicant’s dam when it has no parcel, and falls back to the feature’s name when no run’s model has the node', () => {
		const loc = localitySection([f('dam', 'A', { type: 'Point', coordinates: [21.32, -33.68] }), f('gauge', 'G9', { type: 'Point', coordinates: [21.3, -33.6] }, { name: 'Gauge nine' })], ctx)!;
		expect(loc.features.map((x) => x.label)).toEqual(['Applicant farm', 'Gauge nine']);
	});

	it('baseline evidence names no unit: every parcel and dam is drawn alike', () => {
		const loc = localitySection([f('farm_parcel', 'A', { type: 'Polygon', coordinates: [sq(21.31, -33.69, 0.02)] })], { ...ctx, applicant: false, ownedNodeIds: [] })!;
		expect(loc.applicant).toBe(false);
		expect(loc.features).toEqual([{ layer: 'parcel', label: null, geometry: expect.anything() }]);
	});

	it('records the newest change as the date, the imported files once each, and how many were drawn in the app', () => {
		const loc = localitySection(
			[
				f('farm_parcel', 'A', { type: 'Polygon', coordinates: [sq(21.31, -33.69, 0.02)] }, { source: FILE, updatedAt: '2026-09-20T09:00:00.000Z' }),
				f('farm_parcel', 'B', { type: 'Polygon', coordinates: [sq(21.35, -33.69, 0.02)] }, { source: FILE, updatedAt: '2026-09-29T23:59:00.000Z' }),
				f('gauge', 'G1', { type: 'Point', coordinates: [21.33, -33.64] }, { updatedAt: '2026-09-25T00:00:00.000Z' })
			],
			ctx
		)!;
		expect(loc.asOf).toBe('2026-09-29');
		expect(loc.sources).toEqual([{ fileName: 'parcels.geojson', sha256: 'b'.repeat(64), importedAt: '2026-09-20' }]);
		expect(loc.drawnInApp).toBe(1);
		expect(loc.svgSha256).toBeNull();
	});

	it('rounds coordinates to 6 decimals and simplifies a dense line to the figure’s resolution, keeping its ends', () => {
		// A river of 5 000 vertices wiggling by ~1 cm, across a 0.1° catchment.
		const river = Array.from({ length: 5_000 }, (_, i): [number, number] => [21.3 + (0.1 * i) / 4_999 + 1.234567891e-7, -33.6 - (0.1 * i) / 4_999 + (i % 2) * 1e-7]);
		const loc = localitySection([f('catchment_boundary', null, { type: 'Polygon', coordinates: [sq(21.3, -33.7, 0.1)] }), f('river', null, { type: 'LineString', coordinates: river })], ctx)!;
		const drawn = loc.features.find((x) => x.layer === 'river')!.geometry;
		const pts = positionsOf(drawn);
		expect(pts.length).toBeLessThan(10);
		expect(pts[0]).toEqual([21.3, -33.6]);
		expect(pts.at(-1)).toEqual([21.4, -33.7]);
		for (const [lon, lat] of positionsOf(loc.features[0]!.geometry)) {
			expect(Math.round(lon * 1e6) / 1e6).toBe(lon);
			expect(Math.round(lat * 1e6) / 1e6).toBe(lat);
		}
	});

	it('keeps a small ring the simplification would collapse, and drops a ring of fewer than 4 points', () => {
		const tiny = sq(21.3, -33.7, 1e-5);
		expect(figureGeometry({ type: 'Polygon', coordinates: [tiny] }, ([x, y]) => [x * 1e5, y * 1e5], 1e9)).toEqual({ type: 'Polygon', coordinates: [tiny.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])] });
		expect(figureGeometry({ type: 'Polygon', coordinates: [[[21, -33], [21.1, -33], [21, -33]]] }, ([x, y]) => [x, y], 0)).toBeNull();
		// A hole that collapses is dropped; the outer ring stays.
		const withHole = figureGeometry({ type: 'Polygon', coordinates: [sq(21, -33, 0.1), [[21.01, -32.99], [21.02, -32.99], [21.01, -32.99]]] }, ([x, y]) => [x, y], 0);
		expect(withHole?.type === 'Polygon' && withHole.coordinates).toHaveLength(1);
	});

	it('stamps the SVG’s SHA-256, the one of the figure drawn from the report', async () => {
		const loc = localitySection([f('gauge', 'G1', { type: 'Point', coordinates: [21.33, -33.64] })], ctx)!;
		const report = { localityMap: loc } as EvidenceReport;
		const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
		const stamped = await withLocalitySvgHash(report, hash);
		expect(stamped.localityMap!.svgSha256).toBe(hash(localityMapSvg(loc).svg));
		// The hash isn't part of what is drawn: stamping doesn't change the SVG.
		expect(localityMapSvg(stamped.localityMap!).svg).toBe(localityMapSvg(loc).svg);
		// No figure, nothing to stamp.
		expect(await withLocalitySvgHash({ localityMap: null } as EvidenceReport, hash)).toEqual({ localityMap: null });
	});
});
