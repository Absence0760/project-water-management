// An invented catchment map for the Sandspruit example (Map tab, issue #288),
// so `pnpm seed:examples` gives the map something to show: a boundary, a
// parcel and a dam for each farm, the two gauges and the streams between
// them. Every coordinate is made up. It sits inside the synthetic quaternary
// dataset (backend/fixtures/geo/quaternaries.synthetic.geojson, drainage
// region Z, 21.0–21.75° E, 33.5–34.0° S) and spans several of its cells, so
// the quaternary lookup has an answer anywhere in the catchment.
//
// Each farm's parcel is drawn to its modelled catchment area and each dam to
// its full-supply area, so "Use … km²" proposes a value that agrees with the
// model (to the drawing's rounding). map.test.ts holds the layout to that.
import type { ProjectModel } from '@water-management/engine';
import type { Geometry, Position } from '../../src/geo/geojson.js';

export type ExampleMapKind = 'catchment_boundary' | 'farm_parcel' | 'dam' | 'gauge' | 'river';

export interface ExampleMapFeature {
	kind: ExampleMapKind;
	name: string;
	/** The node it stands for, by name (parcels, dams and gauges). */
	node: string | null;
	geometry: Geometry;
}

/** The file name the seeded features are recorded under (geo_source). */
export const SANDSPRUIT_MAP_FILE = 'sandspruit-map.synthetic.geojson';

// The layout is drawn in kilometres east (x) and north (y) of the catchment's
// north-west corner, then placed at ORIGIN. Farms are rectangles that abut,
// in three blocks: the Melkhoutspruit farms down the west, the Wilgerivier
// farms beside them, and Uitkyk and Rietspruit below, where the two streams
// meet at Melkhout Gauge and leave past Sandspruit Outlet.
const ORIGIN: Position = [21.2, -33.64];
/** The farms in columns (km): a column's west edge, width and north edge, its parcels stacked downward, each as tall as its modelled area needs. */
const COLUMNS: { x: number; w: number; top: number; farms: string[] }[] = [
	{ x: 0, w: 6, top: 0, farms: ['Klipdrift', 'Vaalbank', 'Lemoenkraal'] },
	{ x: 6, w: 5.5, top: 0, farms: ['Bosrand', 'Grootdraai', 'Wilgerivier', 'Uitkyk'] },
	{ x: 11.5, w: 4, top: -10, farms: ['Rietspruit'] }
];
/** The gauges (km): where the two streams meet, and the outlet. */
const GAUGES: Record<string, [number, number]> = {
	'Melkhout Gauge': [6, -68 / 5.5],
	'Sandspruit Outlet': [10.5, -16.2]
};
/** The catchment boundary (km): the blocks' outline with a margin of about 0.4 km. */
const BOUNDARY_KM: [number, number][] = [
	[-0.4, 0.4],
	[11.9, 0.4],
	[11.9, -9.6],
	[15.9, -9.6],
	[15.9, -14.4],
	[11.9, -14.4],
	[11.9, -16.4],
	[5.6, -16.4],
	[5.6, -13.8],
	[-0.4, -13.8],
	[-0.4, 0.4]
];

/** The streams, each from its top down through the nodes it passes. */
const RIVERS: { name: string; through: string[] }[] = [
	{ name: 'Wilgerivier', through: ['Bosrand', 'Grootdraai', 'Wilgerivier', 'Melkhout Gauge'] },
	{ name: 'Melkhoutspruit', through: ['Klipdrift', 'Vaalbank', 'Lemoenkraal', 'Melkhout Gauge'] },
	{ name: 'Rietspruit', through: ['Rietspruit', 'Uitkyk'] },
	{ name: 'Sandspruit', through: ['Melkhout Gauge', 'Uitkyk', 'Sandspruit Outlet'] }
];

const KM_PER_DEG_LAT = 110.95;
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN[1] * Math.PI) / 180);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** A point given in km from ORIGIN, as lon/lat. */
const place = ([x, y]: [number, number]): Position => [round6(ORIGIN[0] + x / KM_PER_DEG_LON), round6(ORIGIN[1] + y / KM_PER_DEG_LAT)];
/** A closed, anticlockwise ring around the km rectangle with north-west corner (x, y). */
const rect = (x: number, y: number, w: number, h: number): Position[][] => [
	[place([x, y - h]), place([x + w, y - h]), place([x + w, y]), place([x, y]), place([x, y - h])]
];

/** The Sandspruit example's map, built from its model so areas and names can't drift from it. */
export function sandspruitMap(model: Pick<ProjectModel, 'nodes'>): ExampleMapFeature[] {
	const area = (name: string) => model.nodes.find((n) => n.name === name)?.areaKm2 ?? 0;
	const parcels = new Map<string, { x: number; y: number; w: number; h: number }>();
	for (const c of COLUMNS) {
		let y = c.top;
		for (const name of c.farms) {
			const h = area(name) / c.w;
			parcels.set(name, { x: c.x, y, w: c.w, h });
			y -= h;
		}
	}
	const parcel = (name: string) => {
		const p = parcels.get(name);
		if (!p) throw new Error(`the Sandspruit map has no parcel for ${name}`);
		return p;
	};
	/** A node's place on the map: a gauge's point, or the middle of a farm's parcel (km). */
	const centre = (name: string): [number, number] => {
		const g = GAUGES[name];
		if (g) return g;
		const p = parcel(name);
		return [p.x + p.w / 2, p.y - p.h / 2];
	};
	const features: ExampleMapFeature[] = [
		{ kind: 'catchment_boundary', name: 'Sandspruit catchment', node: null, geometry: { type: 'Polygon', coordinates: [BOUNDARY_KM.map(place)] } }
	];
	for (const n of model.nodes) {
		if (n.kind === 'gauge') {
			const g = GAUGES[n.name];
			if (!g) throw new Error(`the Sandspruit map has no place for ${n.name}`);
			features.push({ kind: 'gauge', name: n.name, node: n.name, geometry: { type: 'Point', coordinates: place(g) } });
			continue;
		}
		if (n.kind !== 'farm') continue;
		const p = parcel(n.name);
		features.push({ kind: 'farm_parcel', name: n.name, node: n.name, geometry: { type: 'Polygon', coordinates: rect(p.x, p.y, p.w, p.h) } });
		if (n.damAreaFullM2) {
			// The dam on the stream through the parcel's middle, drawn square to its full-supply area.
			const side = Math.sqrt(n.damAreaFullM2) / 1000;
			const [cx, cy] = centre(n.name);
			features.push({ kind: 'dam', name: `${n.name} dam`, node: n.name, geometry: { type: 'Polygon', coordinates: rect(cx - side / 2, cy + side / 2, side, side) } });
		}
	}
	for (const r of RIVERS) features.push({ kind: 'river', name: r.name, node: null, geometry: { type: 'LineString', coordinates: r.through.map((name) => place(centre(name))) } });
	return features;
}
