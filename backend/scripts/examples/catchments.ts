// Three invented example catchments that together exercise every feature of the
// app: branching networks, intermediate gauges, dams that spill and run dry,
// transfers, mixed crops, winter vs summer rainfall, EWR shortfalls, and
// calibration against an (invented) observed record. Place and farm names are
// fictional. Everything is deterministic — re-seeding gives identical projects.
import {
	defaultProjectSettings,
	runModel,
	type CropDef,
	type NetworkNode,
	type ProjectModel,
	type ProjectSettings,
	type Transfer
} from '@water-management/engine';
import { v5 as uuidv5 } from './uuid.js';
import { dailyRain, observedFrom, SUMMER_RAIN, WINTER_RAIN, type RainClimate } from './weather.js';

export interface ExampleProject {
	name: string;
	description: string;
	settings: Partial<ProjectSettings>;
	model: ProjectModel;
	series: { kind: string; name: string; unit: string; startDate: string; values: (number | null)[] }[];
}

const START = '2010-01-01';
const DAYS = 15 * 365 + 4; // 2010-01-01 … 2024-12-31

// Crop factors per water-year month (Oct … Sep). Indicative values for demos.
const CROPS: Record<string, number[]> = {
	Citrus: [0.65, 0.7, 0.7, 0.7, 0.7, 0.65, 0.6, 0.55, 0.55, 0.55, 0.6, 0.65],
	Apples: [0.45, 0.65, 0.85, 0.95, 0.95, 0.8, 0.55, 0.3, 0.25, 0.25, 0.3, 0.35],
	'Wine grapes': [0.3, 0.45, 0.6, 0.65, 0.6, 0.45, 0.3, 0.2, 0.2, 0.2, 0.2, 0.25],
	Pasture: [0.8, 0.85, 0.9, 0.9, 0.85, 0.8, 0.75, 0.7, 0.7, 0.7, 0.72, 0.76],
	Maize: [0.3, 0.5, 0.9, 1.15, 1.1, 0.8, 0.4, 0, 0, 0, 0, 0.2],
	Lucerne: [0.8, 0.95, 1.0, 1.0, 0.95, 0.85, 0.7, 0.6, 0.6, 0.6, 0.65, 0.75],
	Vegetables: [0.7, 0.9, 1.0, 1.0, 0.9, 0.7, 0.6, 0.5, 0.5, 0.5, 0.6, 0.65]
};

// A-pan evaporation, mm per water-year month (Oct … Sep).
const APAN_WINTER_RAIN = [160, 210, 250, 260, 210, 180, 110, 70, 50, 50, 70, 110];
const APAN_SUMMER_RAIN = [190, 200, 210, 200, 170, 160, 120, 90, 70, 80, 120, 170];

interface FarmSpec {
	name: string;
	kind?: 'farm' | 'gauge';
	into: string | null;
	areaKm2?: number;
	damM3?: number;
	damStart?: number;
	damMin?: number;
	upstreamToDam?: number;
	runoffToDam?: number;
	divertM3Day?: number;
	returnFlow?: number;
	/** hectares per crop */
	crops?: Record<string, number>;
}

interface TransferSpec {
	from: string;
	to: string;
	months: number[];
	maxRateM3s: number;
	minStoragePct: number;
}

interface CatchmentSpec {
	key: string;
	name: string;
	description: string;
	climate: RainClimate;
	rainScale: number;
	seed: number;
	apan: number[];
	/** Pragmatic EWR as a fraction of mean natural flow, per water-year month. */
	ewrFraction: number[];
	settings?: Partial<ProjectSettings>;
	calibration?: Partial<ProjectSettings['calibration']>;
	farms: FarmSpec[];
	transfers?: TransferSpec[];
}

const id = (key: string, what: string) => uuidv5(`example:${key}:${what}`);

function build(spec: CatchmentSpec): ExampleProject {
	const nodeId = (name: string) => id(spec.key, `node:${name}`);
	const cropNames = [...new Set(spec.farms.flatMap((f) => Object.keys(f.crops ?? {})))];
	const crops: CropDef[] = cropNames.map((name) => ({ id: id(spec.key, `crop:${name}`), name, cropFactor: CROPS[name]! }));

	const nodes: NetworkNode[] = spec.farms.map((f, i) => ({
		id: nodeId(f.name),
		name: f.name,
		kind: f.kind ?? 'farm',
		downstreamNodeId: f.into ? nodeId(f.into) : null,
		sortOrder: i,
		areaKm2: f.areaKm2 ?? 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		// Engine ≥ 0.9.0 reads this as the share of upstream inflow INTO the dam
		// (model.md §3 Q1). The examples were built with all of it entering the
		// dam, which is now 1 (it was 0 under the workbook's reversed formula).
		pctUpstreamToDam: f.upstreamToDam ?? 1,
		pctRunoffToDam: f.runoffToDam ?? 0.6,
		damCapacityM3: f.damM3 ?? 0,
		damInitialPct: f.damStart ?? 0.6,
		// A minimum operating level (dead storage) irrigation stops at (engine ≥ 0.14.0, audit Q5).
		damMinPct: f.damMin ?? 0.15,
		divertCapacityM3Day: f.divertM3Day ?? 0,
		returnFlowPct: f.returnFlow ?? 0.1
	}));
	const cropAreas = spec.farms.flatMap((f) =>
		Object.entries(f.crops ?? {}).map(([crop, ha]) => ({ nodeId: nodeId(f.name), cropId: id(spec.key, `crop:${crop}`), areaM2: ha * 10_000 }))
	);
	const transfers: Transfer[] = (spec.transfers ?? []).map((t, i) => ({
		id: id(spec.key, `transfer:${i}`),
		fromNodeId: nodeId(t.from),
		toNodeId: nodeId(t.to),
		months: t.months,
		maxRateM3s: t.maxRateM3s,
		dailyCapM3: null,
		minStoragePct: t.minStoragePct,
		enabled: true
	}));
	const model: ProjectModel = { nodes, crops, cropAreas, transfers };

	const rain = dailyRain(spec.climate, START, DAYS, spec.seed, spec.rainScale);
	const d = defaultProjectSettings();
	const settings: Partial<ProjectSettings> = {
		...spec.settings,
		apanMm: spec.apan as unknown as ProjectSettings['apanMm'],
		calibration: { ...d.calibration, ...spec.calibration }
	};

	// First pass without EWR/observed flow to learn the catchment's own flow
	// regime, then set the EWR relative to it and derive an "observed" record.
	const rainSeries = { startDate: START, values: rain };
	const pass1 = runModel({ settings, model, series: { rain_catchment_mm: rainSeries } });
	const natural = pass1.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values;
	const simulated = pass1.series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
	const monthlyMean = new Array(12).fill(0);
	const monthlyN = new Array(12).fill(0);
	const t0 = Date.parse(`${START}T00:00:00Z`);
	natural.forEach((v, i) => {
		const wy = (new Date(t0 + i * 86_400_000).getUTCMonth() + 1 + 2) % 12; // Oct = 0
		monthlyMean[wy] += v;
		monthlyN[wy]++;
	});
	settings.ewrPragmaticM3PerDay = monthlyMean.map(
		(sum, m) => Math.round(((sum / monthlyN[m]) * spec.ewrFraction[m]!) / 100) * 100
	) as unknown as ProjectSettings['ewrPragmaticM3PerDay'];

	return {
		name: spec.name,
		description: spec.description,
		settings,
		model,
		series: [
			{ kind: 'rain_catchment_mm', name: 'Catchment average rainfall', unit: 'mm', startDate: START, values: rain },
			{ kind: 'flow_observed_m3s', name: 'Outlet weir (synthetic)', unit: 'm³/s', startDate: START, values: observedFrom(simulated, spec.seed + 1) }
		]
	};
}

const ha = (o: Record<string, number>) => o;

/** Healthy winter-rainfall catchment: branching network, one transfer, mixed fruit. */
const KLEINBERG: CatchmentSpec = {
	key: 'kleinberg',
	name: 'Example · Kleinberg (winter rainfall)',
	description:
		'Invented demo catchment. Winter-rainfall valley with two tributaries, four fruit and wine farms with on-farm dams, and a winter transfer from the upper dam to a downstream farm. Mostly meets demand; the EWR is missed in dry summers.',
	climate: WINTER_RAIN,
	rainScale: 1.1,
	seed: 101,
	apan: APAN_WINTER_RAIN,
	ewrFraction: [0.3, 0.25, 0.2, 0.2, 0.2, 0.2, 0.25, 0.35, 0.4, 0.4, 0.4, 0.35],
	farms: [
		{ name: 'Kleinberg Weir', kind: 'gauge', into: null },
		{ name: 'Rietvlei', into: 'Kleinberg Weir', areaKm2: 14, damM3: 250_000, divertM3Day: 3000, crops: ha({ Citrus: 45, Pasture: 20 }) },
		{ name: 'Bergwater', into: 'Rietvlei', areaKm2: 18, damM3: 400_000, divertM3Day: 4000, crops: ha({ Apples: 60, 'Wine grapes': 25 }) },
		{ name: 'Rooikloof', into: 'Bergwater', areaKm2: 22, damM3: 600_000, divertM3Day: 5000, crops: ha({ Apples: 40 }) },
		{ name: 'Doornhoek', into: 'Rietvlei', areaKm2: 16, damM3: 180_000, divertM3Day: 2500, crops: ha({ 'Wine grapes': 50, Vegetables: 10 }) }
	],
	transfers: [{ from: 'Rooikloof', to: 'Doornhoek', months: [6, 7, 8, 9], maxRateM3s: 0.03, minStoragePct: 0.3 }]
};

/** Over-allocated catchment: large irrigated areas, small dams → shortfalls and EWR failures. */
const DROEVLEI: CatchmentSpec = {
	key: 'droevlei',
	name: 'Example · Droëvlei (water-stressed)',
	description:
		'Invented demo catchment. Low rainfall and heavily irrigated citrus and lucerne with small dams: farms run short most summers and the EWR is regularly not met. Use it to show the shortfall tables and how dam size or planted area changes the outcome.',
	climate: WINTER_RAIN,
	rainScale: 0.6,
	seed: 202,
	apan: APAN_WINTER_RAIN.map((v) => Math.round(v * 1.15)),
	ewrFraction: [0.35, 0.3, 0.3, 0.3, 0.3, 0.3, 0.35, 0.45, 0.5, 0.5, 0.5, 0.45],
	farms: [
		{ name: 'Droëvlei Gauge', kind: 'gauge', into: null },
		{ name: 'Kareebos', into: 'Droëvlei Gauge', areaKm2: 12, damM3: 60_000, divertM3Day: 1500, crops: ha({ Citrus: 110, Lucerne: 40 }) },
		{ name: 'Sandkraal', into: 'Kareebos', areaKm2: 10, damM3: 40_000, divertM3Day: 1200, crops: ha({ Lucerne: 80 }) },
		{ name: 'Brakfontein', into: 'Sandkraal', areaKm2: 9, damM3: 80_000, divertM3Day: 1000, crops: ha({ Citrus: 70 }) }
	]
};

/** Larger summer-rainfall network with an intermediate gauge and two transfers. */
const SANDSPRUIT: CatchmentSpec = {
	key: 'sandspruit',
	name: 'Example · Sandspruit (summer rainfall, larger network)',
	description:
		'Invented demo catchment. Summer thunderstorm rainfall, eight farms on two tributaries that meet above a mid-catchment gauge, maize, lucerne and vegetables, and two transfers. Shows a bigger network tree and per-node results.',
	climate: SUMMER_RAIN,
	rainScale: 1.0,
	seed: 303,
	apan: APAN_SUMMER_RAIN,
	ewrFraction: [0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.35, 0.4, 0.4, 0.4, 0.35, 0.3],
	settings: {},
	// Summer storms on dry soil still run off, so soften the summer penalty.
	calibration: { summerFactor: 0.35 },
	farms: [
		{ name: 'Sandspruit Outlet', kind: 'gauge', into: null },
		{ name: 'Middel Gauge', kind: 'gauge', into: 'Uitkyk' },
		{ name: 'Uitkyk', into: 'Sandspruit Outlet', areaKm2: 20, damM3: 300_000, divertM3Day: 4000, crops: ha({ Maize: 80, Lucerne: 30 }) },
		{ name: 'Leeuwkop', into: 'Middel Gauge', areaKm2: 24, damM3: 500_000, divertM3Day: 5000, crops: ha({ Maize: 120 }) },
		{ name: 'Vaalbank', into: 'Leeuwkop', areaKm2: 30, damM3: 350_000, divertM3Day: 4000, crops: ha({ Lucerne: 60, Vegetables: 15 }) },
		{ name: 'Klipdrift', into: 'Vaalbank', areaKm2: 26, damM3: 60_000, divertM3Day: 1200, crops: ha({ Maize: 170 }) },
		{ name: 'Wilgerivier', into: 'Middel Gauge', areaKm2: 22, damM3: 450_000, divertM3Day: 4500, crops: ha({ Vegetables: 25, Lucerne: 40 }) },
		{ name: 'Grootdraai', into: 'Wilgerivier', areaKm2: 28, damM3: 800_000, divertM3Day: 6000, crops: ha({ Maize: 60 }) },
		{ name: 'Bosrand', into: 'Grootdraai', areaKm2: 18, damM3: 150_000, divertM3Day: 2000, crops: ha({ Vegetables: 30 }) },
		{ name: 'Rietspruit', into: 'Uitkyk', areaKm2: 16, damM3: 120_000, divertM3Day: 2000, crops: ha({ Lucerne: 45 }) }
	],
	transfers: [
		{ from: 'Grootdraai', to: 'Leeuwkop', months: [9, 10, 11], maxRateM3s: 0.05, minStoragePct: 0.35 },
		{ from: 'Vaalbank', to: 'Rietspruit', months: [7, 8, 9], maxRateM3s: 0.02, minStoragePct: 0.3 }
	]
};

export const EXAMPLES = [KLEINBERG, DROEVLEI, SANDSPRUIT];
export const buildExamples = (): ExampleProject[] => EXAMPLES.map(build);
