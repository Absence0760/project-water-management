// The showcase example (`pnpm seed:examples`): one invented catchment that
// carries every model feature the app has, so the demo account can click on
// anything and see it working. The other examples each show a theme
// (catchments.ts); this one is the full set in one small network:
//
//   Kransdal (headwater)  dam, crops on two systems, a borehole, a pine plantation, a demand in l/s
//     │  transfers to Vleiplaas (by months) and to Rivieroewer (a rate per month)
//   Vleiplaas             dam, a planting on the project's own irrigation system, invasive trees,
//     │                   a packhouse that rests at weekends
//   Kraaivlei Gauge       a mid-catchment gauge and EWR site
//   Rivieroewer           dam, crops from a river abstraction with a pool, a village and a dairy
//     │                   herd sized per person / per head, an emergency borehole into the dam
//   Dorp water works      an other water user, taking from the river and returning part of it
//   Showcase Outlet       the outlet weir and EWR site
//
// The irrigation-systems table is the project's own: micro-sprinkler's
// efficiency edited, and a row of its own (a subsurface drip trial). Every
// name and number is invented. Its seeding (runs, scenarios, map, licensing,
// notes, alerts, feeds) is scripts/examples/showcaseSeed.ts.
import {
	DEFAULT_IRRIGATION_SYSTEMS,
	USER_DEFAULTS,
	type Borehole,
	type DeclaredUncertaintyRule,
	type DemandObject,
	type IrrigationSystemDef,
	type LandCoverPatch,
	type NetworkNode
} from '@water-management/engine';
import { APAN_SUMMER_RAIN, build, panPreset, type BuildOptions, type CatchmentSpec, type ExampleProject } from './catchments.js';
import { v5 as uuidv5 } from './uuid.js';
import { SUMMER_RAIN } from './weather.js';

const KEY = 'showcase';
const id = (what: string) => uuidv5(`example:${KEY}:${what}`);
export const showcaseNodeId = (name: string) => id(`node:${name}`);

/** The project's own irrigation system (a row with no SABI preset). */
export const OWN_SYSTEM_ID = id('system:subsurface-drip');

export const SHOWCASE_NAME = 'Example · Showcase (every feature)';

/** The units, by name, so the seed and its tests can't drift from the model. */
export const UNITS = {
	outlet: 'Showcase Outlet',
	town: 'Dorp water works',
	lower: 'Rivieroewer',
	gauge: 'Kraaivlei Gauge',
	middle: 'Vleiplaas',
	upper: 'Kransdal'
} as const;

/** The declared uncertainty rule: the smallest ensemble the app accepts, so seeding stays quick. */
export const SHOWCASE_UNCERTAINTY_RULE: DeclaredUncertaintyRule = {
	members: 30,
	bounds: 'typical',
	panOffset: 0,
	thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null }
};

export const SHOWCASE: CatchmentSpec = {
	key: KEY,
	name: SHOWCASE_NAME,
	description:
		'Invented demo catchment with every feature switched on, for clicking around. Three units and an other water user on one river: dams, a mid-catchment gauge, boreholes, two transfers (one by months, one with a rate per month), demands sized in m³/day, in l/s and per person or head, a river abstraction with a pool, the project’s own irrigation systems with a per-unit override, plantations and invasive trees, a calibrated GR4J fit, a forecast and a WR2012-style check. It has named runs, scenarios with their runs, a map, registered water use, an evidence pack draft, notes, alerts and data feeds.',
	climate: SUMMER_RAIN,
	rainScale: 1.05,
	seed: 505,
	apan: APAN_SUMMER_RAIN,
	ewrFraction: [0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.35, 0.4, 0.4, 0.4, 0.35, 0.3],
	settings: {
		panCoefficient: panPreset('summer-rainfall'),
		chirpsBiasCorrection: 'monthly',
		calibrationStart: '2011-10-01',
		calibrationEnd: '2020-09-30',
		calibrationExclusions: [{ waterYear: 2016, reason: 'Invented: the weir was being rebuilt for most of the year' }],
		calibrationFlowKind: 'flow_observed_m3s',
		reportStart: '2021-10-01',
		reportEnd: '2024-09-30',
		// Settings › Evidence: the sample a cited ensemble must use (the evidence report and pack need one).
		evidenceUncertaintyRule: SHOWCASE_UNCERTAINTY_RULE
	},
	truthGr4j: { x1: 420, x3: 80, x4: 1.8 },
	rainFaults: { blank: [['2018-02-01', '2018-03-15']] },
	chirpsBias: [1.05, 1.05, 1.0, 0.95, 0.9, 0.9, 0.9, 0.9, 0.95, 1.0, 1.05, 1.05],
	logger: { from: '2019-01-01', drift: { waterYear: 2022, factor: 1.6 } },
	referenceGauge: { name: 'Neighbouring river weir (synthetic, reference only)', scale: 0.6 },
	forecastDays: 10,
	wr2012: { quaternary: 'Z01B', areaFactor: 2.2, marFactor: 1.08, periodStart: 1920, periodEnd: 2009 },
	fit: { budget: 200, seed: 11 },
	farms: [
		{ name: UNITS.outlet, kind: 'gauge', into: null },
		// The other water user sits on the river between Rivieroewer and the outlet (made a user node below).
		{ name: UNITS.town, kind: 'gauge', into: UNITS.outlet },
		{
			name: UNITS.lower,
			into: UNITS.town,
			areaKm2: 35,
			damM3: 200_000,
			damDepthM: 3.5,
			system: 'pivot',
			crops: { Lucerne: 40, Vegetables: 15 },
			cropRiver: { pumpM3Day: 3000, poolM3: 2000 }
		},
		{ name: UNITS.gauge, kind: 'gauge', into: UNITS.lower },
		{ name: UNITS.middle, into: UNITS.gauge, areaKm2: 25, damM3: 300_000, damDepthM: 4, system: 'pivot', returnFlow: 0.05, crops: { Lucerne: 50, Maize: 40 } },
		{ name: UNITS.upper, into: UNITS.middle, areaKm2: 30, damM3: 600_000, damDepthM: 6, system: 'micro', crops: { Citrus: 50, Apples: 20 } }
	],
	transfers: [
		{ from: UNITS.upper, to: UNITS.middle, months: [7, 8, 9, 10], maxRateM3s: 0.03, minStoragePct: 0.35, priority: 0 },
		// Given a rate per month below (monthlyRateM3s); months and maxRateM3s agree with it.
		{ from: UNITS.upper, to: UNITS.lower, months: [8, 9, 10, 11], maxRateM3s: 0.02, minStoragePct: 0.4, priority: 1 }
	],
	demands: [
		{
			farm: UNITS.middle,
			name: 'Packhouse',
			category: 'industrial',
			m3Day: 120,
			priority: 'shared',
			returnPct: 0.2,
			schedule: [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }]
		}
	]
};

/** Per water-year month (Oct … Sep): Kransdal → Rivieroewer runs in the dry spring, most in October. */
const LOWER_TRANSFER_RATES = [0.02, 0.015, 0, 0, 0, 0, 0, 0, 0, 0, 0.01, 0.015];

const demand = (o: Partial<DemandObject> & Pick<DemandObject, 'nodeId' | 'name' | 'category' | 'sizing' | 'priority'>): DemandObject => ({
	id: id(`demand:${o.name}`),
	monthlyM3Day: null,
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	destination: 'internal',
	enabled: true,
	schedule: null,
	population: null,
	source: null,
	waterSource: null,
	riverPumpM3Day: null,
	riverPoolM3: null,
	note: 'Invented demo demand.',
	...o
});

/** The showcase project: SHOWCASE built as the other examples are, then the features their builder has no field for. */
export function buildShowcase(opts: BuildOptions = { fit: true }): ExampleProject {
	const ex = build(SHOWCASE, opts);
	const m = ex.model;
	const node = (name: string) => m.nodes.find((n) => n.name === name)!;
	const upper = showcaseNodeId(UNITS.upper);
	const middle = showcaseNodeId(UNITS.middle);
	const lower = showcaseNodeId(UNITS.lower);

	// The other water user (WP-1.33): a town's water works on the river, returning treated wastewater.
	Object.assign(node(UNITS.town), {
		kind: 'user',
		...USER_DEFAULTS,
		userDemandM3Day: [900, 950, 1000, 1000, 950, 900, 800, 750, 700, 700, 750, 850],
		userReturnPct: 0.4,
		userPriority: 'senior',
		// Its intake pump: a river abstraction with no capacity can take the whole river (the evidence report asks for one).
		pumpCapacityM3Day: 1200
	} satisfies Partial<NetworkNode>);
	// Both gauges stay EWR sites (only a gauge can be taken off them).

	// The project's own irrigation systems: micro-sprinkler measured lower than SABI's default, and a trial system of its own.
	const systems: IrrigationSystemDef[] = DEFAULT_IRRIGATION_SYSTEMS.map((s) => (s.id === 'micro' ? { ...s, efficiency: 0.78 } : { ...s }));
	systems.push({ id: OWN_SYSTEM_ID, name: 'Subsurface drip (farm trial)', efficiency: 0.93, preset: null, sortOrder: systems.length });
	m.irrigationSystems = systems;
	// Each crop's default system; the plantings follow it, except Vleiplaas's lucerne on the trial system.
	const cropDefault: Record<string, string> = { Citrus: 'micro', Apples: 'drip', Lucerne: 'pivot', Maize: 'pivot', Vegetables: 'drip' };
	for (const c of m.crops) c.irrigationSystemId = cropDefault[c.name]!;
	for (const a of m.cropAreas) {
		const crop = m.crops.find((c) => c.id === a.cropId)!;
		a.irrigationSystemId = a.nodeId === middle && crop.name === 'Lucerne' ? OWN_SYSTEM_ID : null;
	}

	// A rate per month on the second transfer (engine ≥ 1.14.0).
	const t = m.transfers[1]!;
	t.monthlyRateM3s = LOWER_TRANSFER_RATES;

	// Demands the builder sizes only by month: one entered in l/s, two per person / per head.
	m.demandObjects = [
		...(m.demandObjects ?? []),
		demand({
			nodeId: upper,
			name: 'School and clinic',
			category: 'municipal',
			sizing: 'monthly',
			// 1.5 l/s every month, kept in m³/day (1.5 × 86.4).
			monthlyM3Day: new Array(12).fill(129.6),
			monthlyUnit: 'ls',
			priority: 'first',
			rank: 1,
			returnPct: 0.3,
			population: 450
		}),
		demand({
			nodeId: lower,
			name: 'Village',
			category: 'domestic',
			sizing: 'perUnit',
			count: 600,
			litresPerUnitDay: 230,
			lossPct: 0.1,
			// Busier over the December holidays.
			monthlyFactor: [1, 1, 1.3, 1.1, 1, 1, 1, 1, 1, 1, 1, 1],
			priority: 'first',
			rank: 1,
			returnPct: 0.3,
			population: 600,
			source: 'perCapita'
		}),
		demand({ nodeId: lower, name: 'Dairy herd', category: 'livestock', sizing: 'perUnit', count: 300, litresPerUnitDay: 45, priority: 'first', rank: 2 })
	];

	// Boreholes (WP-3.9): one that tops up Kransdal's crops, one that fills Rivieroewer's dam in a drought.
	const boreholes: Borehole[] = [
		{ id: id('borehole:KD-BH1'), nodeId: upper, name: 'KD-BH1 (invented)', capacityM3Day: 250, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.3 },
		{ id: id('borehole:RO-BH2'), nodeId: lower, name: 'RO-BH2 (invented)', capacityM3Day: 400, annualCapM3: 60_000, mode: 'emergency', emergencyBelowPct: 0.25, target: 'dam', depletionFactor: 0.5 }
	];
	m.boreholes = boreholes;

	// Land cover that reduces runoff (WP-1.35).
	const landCover: LandCoverPatch[] = [
		{ id: id('landcover:pine'), nodeId: upper, coverClass: 'pine', areaKm2: 4, densityPct: 0.6, factors: null },
		{ id: id('landcover:riparian'), nodeId: middle, coverClass: 'invasiveRiparian', areaKm2: 1.5, densityPct: 0.4, factors: null }
	];
	m.landCover = landCover;
	return ex;
}
