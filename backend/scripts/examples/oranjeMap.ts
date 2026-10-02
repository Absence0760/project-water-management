// An invented map for the Oranje example (catchments.ts ORANJE, #342 items 4–5):
// a boundary, a parcel and a dam for each unit, the weir, and a point at each
// river abstraction's pump. It lies along the Orange River near Upington, so
// the Map tab's River network layer draws real reaches around it once
// HydroRIVERS is loaded (pnpm dev:tiles:rivers; docs/maps.md § River network).
// The parcels and dams are made up; only the area is real.
//
// Each parcel is drawn to its modelled catchment area and each dam to its
// full-supply area, as on the Sandspruit map (map.ts).
import type { ProjectModel } from '@water-management/engine';
import type { Position } from '../../src/geo/geojson.js';
import type { ExampleMapFeature } from './map.js';

/** The file name the seeded features are recorded under (geo_source). */
export const ORANJE_MAP_FILE = 'oranje-map.synthetic.geojson';

// Laid out in kilometres east (x) and south (y, negative) of the north-west
// corner at ORIGIN: the units side by side from the weir upstream to the east,
// each 10 km north to south, so its width is its area ÷ 10.
const ORIGIN: Position = [21.1, -28.38];
const HEIGHT_KM = 10;
/** West to east, from the outlet upstream. */
const UNITS = ['Rivierplaas', 'Wingerdhoek', 'Sandkop'];
/** The river's line through the parcels (km south of the top edge), where the weir and the pumps sit. */
const RIVER_Y = -6.5;
/** The river abstractions' pumps: [unit, the demand they serve, km east of the unit's west edge]. */
const PUMPS: [string, string, number][] = [
	['Rivierplaas', 'Packhouse', 1.5],
	['Wingerdhoek', 'crops', 2],
	['Wingerdhoek', 'Town supply', 5]
];

const KM_PER_DEG_LAT = 110.95;
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN[1] * Math.PI) / 180);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const place = ([x, y]: [number, number]): Position => [round6(ORIGIN[0] + x / KM_PER_DEG_LON), round6(ORIGIN[1] + y / KM_PER_DEG_LAT)];
const rect = (x: number, y: number, w: number, h: number): Position[][] => [
	[place([x, y - h]), place([x + w, y - h]), place([x + w, y]), place([x, y]), place([x, y - h])]
];

/** The Oranje example's map, built from its model so areas and names can't drift from it. */
export function oranjeMap(model: Pick<ProjectModel, 'nodes'>): ExampleMapFeature[] {
	const node = (name: string) => {
		const n = model.nodes.find((x) => x.name === name);
		if (!n) throw new Error(`the Oranje map has no unit ${name}`);
		return n;
	};
	const west = new Map<string, number>();
	let x = 0;
	for (const name of UNITS) {
		west.set(name, x);
		x += node(name).areaKm2 / HEIGHT_KM;
	}
	const width = x;
	const features: ExampleMapFeature[] = [
		{ kind: 'catchment_boundary', name: 'Oranje catchment', node: null, geometry: { type: 'Polygon', coordinates: rect(-0.4, 0.4, width + 0.8, HEIGHT_KM + 0.8) } },
		{ kind: 'gauge', name: 'Oranje Weir', node: 'Oranje Weir', geometry: { type: 'Point', coordinates: place([0.3, RIVER_Y]) } }
	];
	for (const name of UNITS) {
		const n = node(name);
		const w = n.areaKm2 / HEIGHT_KM;
		const x0 = west.get(name)!;
		features.push({ kind: 'farm_parcel', name, node: name, geometry: { type: 'Polygon', coordinates: rect(x0, 0, w, HEIGHT_KM) } });
		if (n.damAreaFullM2) {
			// The dam on a side stream north of the river, drawn square to its full-supply area.
			const side = Math.sqrt(n.damAreaFullM2) / 1000;
			const cx = x0 + w / 2;
			const cy = -3;
			features.push({ kind: 'dam', name: `${name} dam`, node: name, geometry: { type: 'Polygon', coordinates: rect(cx - side / 2, cy + side / 2, side, side) } });
		}
	}
	for (const [unit, what, dx] of PUMPS) {
		const name = what === 'crops' ? `${unit} crops pump` : `${what} pump`;
		features.push({ kind: 'other', name, node: unit, geometry: { type: 'Point', coordinates: place([west.get(unit)! + dx, RIVER_Y]) } });
	}
	return features;
}
