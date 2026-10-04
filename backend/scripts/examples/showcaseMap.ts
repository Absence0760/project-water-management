// An invented map for the showcase example (showcase.ts): a boundary, a
// parcel and a dam for each unit, both gauges, the river, the town's water
// works and points at the boreholes and the river pump. It sits on the
// synthetic reference data's footprint (the land-cover grid, the evaporation
// grid and the quaternaries all cover 21.19–21.39° E, 33.63–33.80° S), so
// cultivated area from land cover, evaporation from the map and the
// quaternary lookup all have an answer here. Every coordinate is made up.
//
// Each parcel is drawn to its unit's modelled catchment area and each dam to
// its full-supply area, as on the Sandspruit map (map.ts).
import type { ProjectModel } from '@water-management/engine';
import type { Position } from '../../src/geo/geojson.js';
import type { ExampleMapFeature } from './map.js';
import { UNITS } from './showcase.js';

/** The file name the seeded features are recorded under (geo_source). */
export const SHOWCASE_MAP_FILE = 'showcase-map.synthetic.geojson';

// Kilometres east (x) and north (y, negative = south) of ORIGIN: the units
// stacked in one 6 km column, headwater at the top, the river down its middle.
const ORIGIN: Position = [21.22, -33.645];
const WIDTH_KM = 6;
const STACK = [UNITS.upper, UNITS.middle, UNITS.lower];
const RIVER_X = 3;

const KM_PER_DEG_LAT = 110.95;
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN[1] * Math.PI) / 180);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const place = ([x, y]: [number, number]): Position => [round6(ORIGIN[0] + x / KM_PER_DEG_LON), round6(ORIGIN[1] + y / KM_PER_DEG_LAT)];
const rect = (x: number, y: number, w: number, h: number): Position[][] => [
	[place([x, y - h]), place([x + w, y - h]), place([x + w, y]), place([x, y]), place([x, y - h])]
];
const point = (xy: [number, number]) => ({ type: 'Point' as const, coordinates: place(xy) });

export function showcaseMap(model: Pick<ProjectModel, 'nodes'>): ExampleMapFeature[] {
	const byName = (name: string) => {
		const n = model.nodes.find((x) => x.name === name);
		if (!n) throw new Error(`the showcase map has no node ${name}`);
		return n;
	};
	const features: ExampleMapFeature[] = [];
	const top: Record<string, number> = {};
	let y = 0;
	for (const name of STACK) {
		const n = byName(name);
		const h = n.areaKm2 / WIDTH_KM;
		top[name] = y;
		features.push({ kind: 'farm_parcel', name, node: name, geometry: { type: 'Polygon', coordinates: rect(0, y, WIDTH_KM, h) } });
		if (n.damAreaFullM2) {
			const side = Math.sqrt(n.damAreaFullM2) / 1000;
			const cy = y - h / 2;
			features.push({ kind: 'dam', name: `${name} dam`, node: name, geometry: { type: 'Polygon', coordinates: rect(RIVER_X - side / 2, cy + side / 2, side, side) } });
		}
		y -= h;
	}
	const bottom = y;
	const gaugeY = top[UNITS.lower]!;
	features.unshift({
		kind: 'catchment_boundary',
		name: 'Showcase catchment',
		node: null,
		geometry: { type: 'Polygon', coordinates: rect(-0.4, 0.4, WIDTH_KM + 0.8, -bottom + 1.4) }
	});
	features.push(
		{ kind: 'gauge', name: UNITS.gauge, node: UNITS.gauge, geometry: point([RIVER_X, gaugeY]) },
		{ kind: 'other', name: UNITS.town, node: UNITS.town, geometry: point([RIVER_X, bottom - 0.3]) },
		{ kind: 'gauge', name: UNITS.outlet, node: UNITS.outlet, geometry: point([RIVER_X, bottom - 0.8]) },
		{ kind: 'other', name: 'KD-BH1 borehole (invented)', node: UNITS.upper, geometry: point([1.2, -1.5]) },
		{ kind: 'other', name: 'RO-BH2 borehole (invented)', node: UNITS.lower, geometry: point([4.8, gaugeY - 2]) },
		{ kind: 'other', name: 'Rivieroewer river pump', node: UNITS.lower, geometry: point([RIVER_X + 0.2, gaugeY - 4.5]) },
		{ kind: 'other', name: 'Pine plantation (invented)', node: UNITS.upper, geometry: { type: 'Polygon', coordinates: rect(4, -0.5, 1.6, 2.5) } },
		{ kind: 'river', name: 'Kraaispruit', node: null, geometry: { type: 'LineString', coordinates: [place([RIVER_X, 0]), place([RIVER_X, gaugeY]), place([RIVER_X, bottom - 0.8])] } }
	);
	return features;
}
