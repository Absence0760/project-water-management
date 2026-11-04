// The licence comparison map example (issue #510, docs/run-locally.md §
// Example catchments): an invented catchment whose units land in every band
// of the Allocations tab's map (docs/allocations.md § The map), so the map is
// on screen with every band after `pnpm seed:examples`. Seeded by
// licenceMapSeed.ts; tested in licenceMap.test.ts.
//
// The registered volumes are not fixed numbers: after the baseline run the
// seed reads each unit's modelled mean surface use per whole water year from
// the comparison and registers that use ÷ the unit's target ratio, so the
// bands hold whatever the engine's numbers do. Each unit's volume, irrigated
// area and storage are held by two or three demo registered users
// (./farmers.ts), and the area and the storage have targets of their own, so
// the map's Irrigated area and Dam capacity shading show every band too.
// Every name and value is invented.
import { plantedHaByNode, type AllocationComparison, type ProjectModel } from '@water-management/engine';
import { DEMO_FARMERS } from './farmers.js';
import type { Position } from '../../src/geo/geojson.js';
import { APAN_SUMMER_RAIN, build, panPreset, type CatchmentSpec, type ExampleProject } from './catchments.js';
import type { ExampleMapFeature } from './map.js';
import { SUMMER_RAIN } from './weather.js';

export const LICENCE_MAP_NAME = 'Example · Licence comparison map';
/** The file name the seeded features are recorded under (geo_source). */
export const LICENCE_MAP_FILE = 'licence-map.synthetic.geojson';

/** What each unit is there to show: a ratio of modelled use to registered volume, or nothing registered. */
export type LicenceTarget = { ratio: number } | { unregistered: true };

/**
 * The units, upstream first, each with its targets (#510's seed list): its
 * water use (`target`), its irrigated area (`area`: planted in the run ÷
 * registered) and its dam (`storage`: capacity in the run ÷ registered), and
 * how many registered users hold them.
 */
export const LICENCE_UNITS: readonly { name: string; target: LicenceTarget; area: LicenceTarget; storage: LicenceTarget; holders: number; polygon: boolean; note: string }[] = [
	{ name: 'Groenkloof', target: { ratio: 0.8 }, area: { ratio: 1.3 }, storage: { ratio: 0.8 }, holders: 3, polygon: true, note: 'uses less than registered (green), and holds a groundwater registration' },
	{ name: 'Oranjedraai', target: { ratio: 1.05 }, area: { ratio: 2 }, storage: { ratio: 1.05 }, holders: 2, polygon: true, note: 'up to 10 % more (orange)' },
	{ name: 'Randhoek', target: { ratio: 1 }, area: { ratio: 1 }, storage: { ratio: 1.3 }, holders: 3, polygon: true, note: 'exactly its registered volume and area: the orange band’s lower edge' },
	{ name: 'Rooiheuwel', target: { ratio: 1.3 }, area: { ratio: 0.8 }, storage: { ratio: 2 }, holders: 2, polygon: true, note: '10–50 % more (light red)' },
	{ name: 'Brandvlei', target: { ratio: 2 }, area: { ratio: 1.05 }, storage: { unregistered: true }, holders: 3, polygon: true, note: 'more than 50 % more (bright red); its dam has no storage registered' },
	{ name: 'Grysvlakte', target: { unregistered: true }, area: { unregistered: true }, storage: { unregistered: true }, holders: 0, polygon: true, note: 'uses water with nothing registered (grey, hatched)' },
	{ name: 'Stilwater', target: { unregistered: true }, area: { unregistered: true }, storage: { unregistered: true }, holders: 0, polygon: true, note: 'no demand and nothing registered (outline only)' },
	{ name: 'Sonderkaart', target: { ratio: 0.9 }, area: { ratio: 0.9 }, storage: { ratio: 1 }, holders: 2, polygon: false, note: 'no area on the map: listed under it' }
];
/** The unit with no demand at all. */
export const IDLE_UNIT = 'Stilwater';
/** The unit with a groundwater registration (it has no borehole, so it uses none of it). */
export const GROUNDWATER_UNIT = 'Groenkloof';
export const GROUNDWATER_M3 = 25_000;

const SPEC: CatchmentSpec = {
	key: 'licence-map',
	name: LICENCE_MAP_NAME,
	description:
		'Invented demo catchment for the Allocations tab’s map: eight irrigation units on one river, each registered so its modelled use lands in a different band of the map (less than registered, up to 10 % more, 10–50 % more, more than 50 % more, use with nothing registered, no use at all), and one unit with no area on the map. Open Allocations and press Show the map.',
	climate: SUMMER_RAIN,
	rainScale: 1,
	seed: 510,
	apan: APAN_SUMMER_RAIN,
	ewrFraction: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.25, 0.3, 0.3, 0.3, 0.25, 0.2],
	settings: { panCoefficient: panPreset('summer-rainfall') },
	farms: [
		{ name: 'Licence Weir', kind: 'gauge', into: null },
		{ name: 'Sonderkaart', into: 'Licence Weir', areaKm2: 14, damM3: 150_000, damDepthM: 4, system: 'pivot', crops: { Lucerne: 30 } },
		{ name: 'Stilwater', into: 'Sonderkaart', areaKm2: 10 },
		{ name: 'Grysvlakte', into: 'Stilwater', areaKm2: 12, damM3: 120_000, damDepthM: 3.5, system: 'drip', crops: { Vegetables: 20 } },
		{ name: 'Brandvlei', into: 'Grysvlakte', areaKm2: 15, damM3: 200_000, damDepthM: 4, system: 'pivot', crops: { Maize: 50 } },
		{ name: 'Rooiheuwel', into: 'Brandvlei', areaKm2: 13, damM3: 160_000, damDepthM: 4, system: 'movable', crops: { Lucerne: 25 } },
		{ name: 'Randhoek', into: 'Rooiheuwel', areaKm2: 12, damM3: 140_000, damDepthM: 4, system: 'drip', crops: { Citrus: 30 } },
		{ name: 'Oranjedraai', into: 'Randhoek', areaKm2: 16, damM3: 220_000, damDepthM: 4.5, system: 'pivot', crops: { Maize: 35 } },
		{ name: 'Groenkloof', into: 'Oranjedraai', areaKm2: 18, damM3: 300_000, damDepthM: 5, system: 'micro', crops: { Citrus: 40 } }
	]
};

/** The example's project document (no stored fit: GR4J's defaults). */
export const buildLicenceMap = (): ExampleProject => build(SPEC, { fit: false });

// The map, in kilometres east (x) and north (y) of ORIGIN: the units in two
// rows of four, each parcel 4 km wide and as tall as its modelled area needs,
// on the synthetic reference data's footprint like the showcase's map.
const ORIGIN: Position = [21.25, -33.65];
const WIDTH_KM = 4;
const KM_PER_DEG_LAT = 110.95;
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN[1] * Math.PI) / 180);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const place = ([x, y]: [number, number]): Position => [round6(ORIGIN[0] + x / KM_PER_DEG_LON), round6(ORIGIN[1] + y / KM_PER_DEG_LAT)];
const rect = (x: number, y: number, w: number, h: number): Position[][] => [
	[place([x, y - h]), place([x + w, y - h]), place([x + w, y]), place([x, y]), place([x, y - h])]
];

/** The example's map: a parcel per unit with an area on it (each linked to its unit), the boundary and the weir. */
export function licenceMapFeatures(model: Pick<ProjectModel, 'nodes'>): ExampleMapFeature[] {
	const drawn = LICENCE_UNITS.filter((u) => u.polygon);
	const features: ExampleMapFeature[] = [];
	let bottom = 0;
	drawn.forEach((u, i) => {
		const n = model.nodes.find((x) => x.name === u.name);
		if (!n) throw new Error(`the licence map has no unit ${u.name}`);
		const row = Math.floor(i / 4);
		const h = n.areaKm2 / WIDTH_KM;
		const top = -row * 5;
		features.push({ kind: 'farm_parcel', name: u.name, node: u.name, geometry: { type: 'Polygon', coordinates: rect((i % 4) * WIDTH_KM, top, WIDTH_KM, h) } });
		bottom = Math.min(bottom, top - h);
	});
	features.unshift({ kind: 'catchment_boundary', name: 'Licence comparison catchment', node: null, geometry: { type: 'Polygon', coordinates: rect(-0.4, 0.4, 4 * WIDTH_KM + 0.8, -bottom + 1.6) } });
	features.push({ kind: 'gauge', name: 'Licence Weir', node: 'Licence Weir', geometry: { type: 'Point', coordinates: place([2 * WIDTH_KM, bottom - 0.8]) } });
	return features;
}

/** One registered volume as POST …/allocations takes it. */
export interface LicenceAllocation {
	nodeId: string;
	registrationNo: string;
	holder: string;
	authorisation: 'registration' | 'licence' | 'existing_lawful_use_claimed' | 'existing_lawful_use';
	waterSource: 'surface' | 'groundwater';
	volumeM3PerYear: number;
	/** The holder's share of the unit's registered storage (m³), on the take; absent when the unit has none registered. */
	storageM3?: number;
	/** The holder's registered irrigated area (ha), on the take. */
	irrigatedAreaHa?: number;
}

/** How a unit's registered figures are shared among its holders, by how many there are. */
const SHARES: Record<number, readonly number[]> = { 1: [1], 2: [0.6, 0.4], 3: [0.5, 0.3, 0.2] };

/**
 * `total` split into `n` shares, each rounded to `decimals` but the last, which
 * takes what is left so the shares add up to the total (exactly, for a
 * total that must sit on a band's edge; else rounded too).
 */
export function splitShares(total: number, n: number, decimals: number, exact: boolean): number[] {
	const shares = SHARES[n];
	if (!shares) throw new Error(`no shares for ${n} holders`);
	const f = 10 ** decimals;
	const round = (x: number) => Math.round(x * f) / f;
	const head = shares.slice(0, -1).map((s) => round(total * s));
	const rest = total - head.reduce((a, x) => a + x, 0);
	return [...head, exact ? rest : round(rest)];
}

const AUTHORISATIONS: readonly LicenceAllocation['authorisation'][] = ['licence', 'registration', 'existing_lawful_use_claimed', 'existing_lawful_use'];

/** A unit's registered figure for its target: the run's ÷ the ratio (exactly the run's at r = 1, on the band's edge); null when none is registered. */
const registeredFor = (target: LicenceTarget, modelled: number, decimals: number): number | null => {
	if (!('ratio' in target)) return null;
	const f = 10 ** decimals;
	return target.ratio === 1 ? modelled : Math.round((modelled / target.ratio) * f) / f;
};

/**
 * The registered volumes, from the baseline run's comparison (made with no
 * volumes yet) and the model's planted crop areas: each unit with a target
 * ratio gets its modelled mean surface use per whole water year ÷ that ratio
 * (whole m³, except the r = 1 unit, which gets its use exactly so it sits on
 * the band's edge), its planted area ÷ its area ratio (0.1 ha) and its
 * modelled dam ÷ its storage ratio (whole m³), each shared among its
 * holders (DEMO_FARMERS, in order, each on one take), and the groundwater
 * unit a groundwater registration too. Throws when a unit meant to use water
 * uses none, or to be registered has no crops or dam to register, so a seed
 * can't quietly lose a band.
 */
export function licenceAllocations(comparison: Pick<AllocationComparison, 'nodes'>, model: Pick<ProjectModel, 'cropAreas'>): LicenceAllocation[] {
	const out: LicenceAllocation[] = [];
	const planted = plantedHaByNode(model.cropAreas);
	let holder = 0;
	LICENCE_UNITS.forEach((u, i) => {
		const n = comparison.nodes.find((x) => x.name === u.name);
		if (!n) throw new Error(`the licence map's run has no unit ${u.name}`);
		const use = n.surface.meanModelledM3PerYear ?? 0;
		if (u.name !== IDLE_UNIT && !(use > 0)) throw new Error(`the licence map's ${u.name} modelled no surface use`);
		if (u.name === IDLE_UNIT && use > 0) throw new Error(`the licence map's ${u.name} should use no water`);
		if (!('ratio' in u.target)) return;
		const ha = planted.get(n.nodeId) ?? 0;
		const dam = n.storage.modelledCapacityM3 ?? 0;
		if ('ratio' in u.area && !(ha > 0)) throw new Error(`the licence map's ${u.name} plants no crops to register an area for`);
		if ('ratio' in u.storage && !(dam > 0)) throw new Error(`the licence map's ${u.name} has no dam to register storage for`);
		const volumes = splitShares(registeredFor(u.target, use, 0)!, u.holders, 0, u.target.ratio === 1);
		const area = registeredFor(u.area, ha, 1);
		const areas = area === null ? null : splitShares(area, u.holders, 1, 'ratio' in u.area && u.area.ratio === 1);
		const storage = registeredFor(u.storage, dam, 0);
		const storages = storage === null ? null : splitShares(storage, u.holders, 0, 'ratio' in u.storage && u.storage.ratio === 1);
		const no = `LIC-${String(i + 1).padStart(4, '0')}`;
		const names: string[] = [];
		volumes.forEach((v, k) => {
			const name = DEMO_FARMERS[holder++ % DEMO_FARMERS.length]!;
			names.push(name);
			out.push({
				nodeId: n.nodeId,
				registrationNo: `${no}-${k + 1}`,
				holder: name,
				authorisation: AUTHORISATIONS[(i + k) % AUTHORISATIONS.length]!,
				waterSource: 'surface',
				volumeM3PerYear: v,
				...(storages ? { storageM3: storages[k]! } : {}),
				...(areas ? { irrigatedAreaHa: areas[k]! } : {})
			});
		});
		if (u.name === GROUNDWATER_UNIT)
			out.push({ nodeId: n.nodeId, registrationNo: `${no}-G`, holder: names[0]!, authorisation: 'registration', waterSource: 'groundwater', volumeM3PerYear: GROUNDWATER_M3 });
	});
	return out;
}
