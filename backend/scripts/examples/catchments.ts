// Three invented example catchments that together exercise every feature of the
// app (engine 0.16.0): branching networks, intermediate gauges, dams that spill
// and run dry with evaporation, rain on the dam and seepage, irrigation
// efficiency and loss return per farm, transfers run by priority and capped at
// the receiver's room, mixed crops, winter vs summer rainfall, EWR shortfalls,
// calibration against an (invented) observed record with an exclusion and a
// stored GR4J fit, CHIRPS filling a blank and a zero-rain run, a logger that
// disagrees with the gauge, a reference gauge on another river, a forecast and
// a WR2012 check. Place and farm names are fictional, and every number is
// synthetic. Everything is deterministic: re-seeding gives identical projects.
//
// What each one shows (docs/run-locally.md § Example catchments):
//   Kleinberg  — CHIRPS bias correction, zero-rain runs (flagged and listed),
//                a calibration exclusion and a stored GR4J fit, transfer priority.
//   Droëvlei   — shortfalls and EWR failures, flood irrigation, a leaky dam,
//                gauge vs logger disagreement, a reporting window, a small soil store.
//   Sandspruit — a bigger tree with a mid-catchment gauge, equal-priority
//                transfers sharing a dam, a daily transfer cap, a calibration
//                window, a reference gauge, a forecast and a WR2012 reference.
import {
	DAM_AREA_EXPONENT,
	DAM_STORAGE_DEFAULTS,
	DEVELOPMENT_DEFAULTS,
	ENGINE_VERSION,
	IRRIGATION_SYSTEMS,
	NEW_FARM_IRRIGATION,
	USER_DEFAULTS,
	BOREHOLE_DEFAULTS,
	OPERATING_DEFAULTS,
	SUPPLY_DEFAULTS,
	PAN_COEFFICIENT_PRESETS,
	calibrate,
	defaultProjectSettings,
	fitRecordFromReport,
	OFFTAKE_DEFAULTS,
	runModel,
	type CropDef,
	type DailySeries,
	type Gr4jParams,
	type ModelInput,
	type NetworkNode,
	type ProjectModel,
	type ProjectSettings,
	type SeriesKind,
	type Transfer
} from '@water-management/engine';
import { v5 as uuidv5 } from './uuid.js';
import { chirpsFrom, dailyRain, observedFrom, SUMMER_RAIN, WINTER_RAIN, type RainClimate } from './weather.js';

export interface ExampleSeries {
	kind: SeriesKind;
	name: string;
	unit: string;
	startDate: string;
	values: (number | null)[];
}

export interface ExampleProject {
	name: string;
	description: string;
	settings: Partial<ProjectSettings>;
	model: ProjectModel;
	series: ExampleSeries[];
}

const START = '2010-01-01';
const DAYS = 15 * 365 + 4; // 2010-01-01 … 2024-12-31
const T0 = Date.parse(`${START}T00:00:00Z`);
const DAY_MS = 86_400_000;
/** Day index of an ISO date in the example record. */
const dayOf = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - T0) / DAY_MS);
const isoOf = (i: number) => new Date(T0 + i * DAY_MS).toISOString().slice(0, 10);
/** Water year (labelled by the calendar year it starts in) of day index i. */
const waterYearOfDay = (i: number) => {
	const d = new Date(T0 + i * DAY_MS);
	return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};
/** The fixed time the stored fit claims, so a re-seed stays identical. */
const FITTED_AT = '2025-01-15T09:00:00.000Z';

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

const panPreset = (id: string) => [...PAN_COEFFICIENT_PRESETS.find((p) => p.id === id)!.values] as ProjectSettings['panCoefficient'];

type IrrigationSystem = (typeof IRRIGATION_SYSTEMS)[number]['id'];

interface FarmSpec {
	name: string;
	kind?: 'farm' | 'gauge';
	into: string | null;
	areaKm2?: number;
	damM3?: number;
	damStart?: number;
	/** Minimum operating level, fraction of capacity (audit Q5). Default 0.15. */
	damMin?: number;
	/**
	 * Mean depth of the full dam (m): its full-supply area is capacity ÷ depth
	 * (audit N2). null leaves the area unknown, so the run estimates it at 3 m
	 * and warns (W6). Default 4 m.
	 */
	damDepthM?: number | null;
	/** Seepage per day as a fraction of storage (audit N2). Default 0. */
	seepage?: number;
	upstreamToDam?: number;
	runoffToDam?: number;
	divertM3Day?: number;
	/** Irrigation system: its SABI 2021 efficiency (IRRIGATION_SYSTEMS) is the farm's (audit N1). Default NEW_FARM_IRRIGATION. */
	system?: IrrigationSystem;
	/** Share of the application losses returning to the river. Default NEW_FARM_IRRIGATION's. */
	lossReturn?: number;
	/** hectares per crop */
	crops?: Record<string, number>;
}

interface TransferSpec {
	from: string;
	to: string;
	months: number[];
	maxRateM3s: number;
	dailyCapM3?: number;
	minStoragePct: number;
	/** Lower moves first; equal priorities from one dam share it pro rata (audit Q18). Default: list position. */
	priority?: number;
}

type Period = [start: string, end: string];

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
	/**
	 * GR4J parameters the invented "observed" record is generated with: the
	 * catchment's hidden truth. Unset = the settings' own, so the record fits
	 * as it stands.
	 */
	truthGr4j?: Partial<Gr4jParams>;
	/** Faults in the catchment rain record (the "truth" is kept for CHIRPS and the observed flow). */
	rainFaults?: {
		/** Days with no reading (blank). */
		blank?: Period[];
		/** Days wrongly recorded as 0 mm. */
		zeros?: Period[];
		/** Gauge not read: 0 mm on every day but the last, which holds the whole period's rain (an untagged accumulation, audit B4). */
		accumulations?: Period[];
	};
	/** CHIRPS as catchment rain × this per calendar month (Jan … Dec), with noise. */
	chirpsBias?: number[];
	/** A water year whose observed peaks are cut at the record's `quantile` flow (a drowned weir). */
	observedCap?: { waterYear: number; quantile: number };
	/** A logger on the same weir from `from`, reading `drift.factor` × the flow through one water year. */
	logger?: { from: string; drift: { waterYear: number; factor: number } };
	/** A gauge on a neighbouring river, `scale` × this catchment's natural flow. */
	referenceGauge?: { name: string; scale: number };
	/** Days of forecast rain after the record ends. */
	forecastDays?: number;
	/** A WR2012-style reference derived from the natural flow: the quaternary is `areaFactor` × the catchment, `marFactor` × as wet. */
	wr2012?: { quaternary: string; areaFactor: number; marFactor: number; periodStart: number; periodEnd: number };
	/** Store a GR4J fit (automatic calibration, validated) in settings.fitRecord. */
	fit?: { budget: number; seed: number };
	farms: FarmSpec[];
	transfers?: TransferSpec[];
}

const id = (key: string, what: string) => uuidv5(`example:${key}:${what}`);
const efficiencyOf = (s: IrrigationSystem) => IRRIGATION_SYSTEMS.find((x) => x.id === s)!.efficiency;

/** A project's series as runModel reads them. */
export function inputOf(ex: ExampleProject): ModelInput {
	return {
		settings: ex.settings as ModelInput['settings'],
		model: ex.model,
		series: Object.fromEntries(ex.series.map((s) => [s.kind, { startDate: s.startDate, values: s.values }])) as Partial<Record<SeriesKind, DailySeries>>
	};
}

function build(spec: CatchmentSpec, opts: BuildOptions): ExampleProject {
	const nodeId = (name: string) => id(spec.key, `node:${name}`);
	const cropNames = [...new Set(spec.farms.flatMap((f) => Object.keys(f.crops ?? {})))];
	const crops: CropDef[] = cropNames.map((name) => ({ id: id(spec.key, `crop:${name}`), name, cropFactor: CROPS[name]! }));

	const nodes: NetworkNode[] = spec.farms.map((f, i) => {
		const cap = f.damM3 ?? 0;
		const depth = f.damDepthM === undefined ? 4 : f.damDepthM;
		return {
			id: nodeId(f.name),
			name: f.name,
			kind: f.kind ?? 'farm',
			downstreamNodeId: f.into ? nodeId(f.into) : null,
			sortOrder: i,
			areaKm2: f.areaKm2 ?? 0,
			areaHiKm2: 0,
			areaLoKm2: 0,
			flowShareManual: null,
			// The share of upstream inflow INTO the dam (model.md §3 Q1); all of it by default.
			pctUpstreamToDam: f.upstreamToDam ?? 1,
			pctRunoffToDam: f.runoffToDam ?? 0.6,
			damCapacityM3: cap,
			damInitialPct: f.damStart ?? 0.6,
			// Dead storage irrigation stops at (audit Q5).
			damMinPct: f.damMin ?? 0.15,
			divertCapacityM3Day: f.divertM3Day ?? 0,
			irrigationEfficiency: f.system ? efficiencyOf(f.system) : NEW_FARM_IRRIGATION.irrigationEfficiency,
			lossReturnFraction: f.lossReturn ?? NEW_FARM_IRRIGATION.lossReturnFraction,
			// Full-supply area from a surveyed mean depth (audit N2); drives dam evaporation and rain on the dam.
			damAreaFullM2: cap > 0 && depth !== null ? Math.round(cap / depth) : null,
			damAreaExponent: DAM_AREA_EXPONENT,
			damSeepagePerDay: f.seepage ?? 0,
			// Not an other water user (WP-1.33), no boreholes (WP-1.34), no dam survey curve or release rule (WP-3.5),
			// the dam only with no river pump or hands-off flow (WP-3.8), every gauge an EWR site, no GN 538 property (engine 1.12.0): the inert defaults.
			...USER_DEFAULTS,
			...BOREHOLE_DEFAULTS,
			...DAM_STORAGE_DEFAULTS,
			...DEVELOPMENT_DEFAULTS,
			...SUPPLY_DEFAULTS,
			...OPERATING_DEFAULTS,
			ewrSite: true,
			gaPropertyAreaHa: null,
			gaRateM3HaYear: null
		};
	});
	const cropAreas = spec.farms.flatMap((f) =>
		Object.entries(f.crops ?? {}).map(([crop, ha]) => ({ nodeId: nodeId(f.name), cropId: id(spec.key, `crop:${crop}`), areaM2: ha * 10_000 }))
	);
	const transfers: Transfer[] = (spec.transfers ?? []).map((t, i) => ({
		id: id(spec.key, `transfer:${i}`),
		fromNodeId: nodeId(t.from),
		toNodeId: nodeId(t.to),
		months: t.months,
		maxRateM3s: t.maxRateM3s,
		dailyCapM3: t.dailyCapM3 ?? null,
		minStoragePct: t.minStoragePct,
		enabled: true,
		priority: t.priority ?? i,
		monthlyRateM3s: null,
		...OFFTAKE_DEFAULTS
	}));
	const model: ProjectModel = { nodes, crops, cropAreas, transfers };

	const truthRain = dailyRain(spec.climate, START, DAYS, spec.seed, spec.rainScale);
	const d = defaultProjectSettings();
	const settings: Partial<ProjectSettings> = {
		// Explicit, as a project saved from Settings is: a stored fit is judged against it.
		runoffModel: 'gr4j',
		...spec.settings,
		apanMm: spec.apan as unknown as ProjectSettings['apanMm'],
		calibration: { ...d.calibration, ...spec.calibration }
	};

	// First pass on the true rain, without EWR or observed flow, to learn the
	// catchment's own flow regime (with its hidden GR4J truth); then set the
	// EWR relative to it and derive the "observed" records from it.
	const truthSettings = { ...settings, gr4j: { ...d.gr4j, ...settings.gr4j, ...spec.truthGr4j } };
	const pass1 = runModel({ settings: truthSettings, model, series: { rain_catchment_mm: { startDate: START, values: truthRain } } });
	const natural = pass1.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values;
	const simulated = pass1.series.find((s) => s.nodeId === null && s.key === 'simulated_outflow')!.values;
	const monthlyMean = new Array(12).fill(0);
	const monthlyN = new Array(12).fill(0);
	natural.forEach((v, i) => {
		const wy = (new Date(T0 + i * DAY_MS).getUTCMonth() + 1 + 2) % 12; // Oct = 0
		monthlyMean[wy] += v;
		monthlyN[wy]++;
	});
	settings.ewrPragmaticM3PerDay = monthlyMean.map(
		(sum, m) => Math.round(((sum / monthlyN[m]) * spec.ewrFraction[m]!) / 100) * 100
	) as unknown as ProjectSettings['ewrPragmaticM3PerDay'];

	// Catchment rain as the gauge recorded it: the truth with its faults.
	const rain: (number | null)[] = truthRain.slice();
	for (const [a, b] of spec.rainFaults?.blank ?? []) for (let i = dayOf(a); i <= dayOf(b); i++) rain[i] = null;
	for (const [a, b] of spec.rainFaults?.zeros ?? []) for (let i = dayOf(a); i <= dayOf(b); i++) rain[i] = 0;
	for (const [a, b] of spec.rainFaults?.accumulations ?? []) {
		let total = 0;
		for (let i = dayOf(a); i <= dayOf(b); i++) {
			total += truthRain[i] ?? 0;
			rain[i] = 0;
		}
		rain[dayOf(b)] = Math.round(total * 10) / 10;
	}

	const observed = observedFrom(simulated, spec.seed + 1);
	if (spec.observedCap) {
		const sorted = observed.filter((v): v is number => v !== null).sort((a, b) => a - b);
		const cap = sorted[Math.floor(sorted.length * spec.observedCap.quantile)]!;
		observed.forEach((v, i) => {
			if (v !== null && waterYearOfDay(i) === spec.observedCap!.waterYear) observed[i] = Math.min(v, cap);
		});
	}

	const series: ExampleSeries[] = [
		{ kind: 'rain_catchment_mm', name: 'Catchment average rainfall', unit: 'mm', startDate: START, values: rain },
		{ kind: 'flow_observed_m3s', name: 'Outlet weir (synthetic)', unit: 'm³/s', startDate: START, values: observed }
	];
	if (spec.chirpsBias) {
		series.push({ kind: 'rain_chirps_mm', name: 'CHIRPS (synthetic)', unit: 'mm', startDate: START, values: chirpsFrom(truthRain, START, spec.chirpsBias, spec.seed + 2) });
	}
	if (spec.logger) {
		const from = dayOf(spec.logger.from);
		const logger = observedFrom(simulated, spec.seed + 3, 0.06).slice(from);
		logger.forEach((v, j) => {
			if (v !== null && waterYearOfDay(from + j) === spec.logger!.drift.waterYear) logger[j] = Number((v * spec.logger!.drift.factor).toPrecision(3));
		});
		series.push({ kind: 'flow_logger_m3s', name: 'Outlet logger (synthetic)', unit: 'm³/s', startDate: spec.logger.from, values: logger });
	}
	if (spec.referenceGauge) {
		const scale = spec.referenceGauge.scale;
		series.push({
			kind: 'flow_reference_m3s',
			name: spec.referenceGauge.name,
			unit: 'm³/s',
			startDate: START,
			values: observedFrom(natural.map((v) => v * scale), spec.seed + 4, 0.02)
		});
	}
	if (spec.forecastDays) {
		series.push({
			kind: 'rain_forecast_mm',
			name: 'Forecast (synthetic)',
			unit: 'mm',
			startDate: isoOf(DAYS),
			values: dailyRain(spec.climate, isoOf(DAYS), spec.forecastDays, spec.seed + 5, spec.rainScale)
		});
	}
	if (spec.wr2012) {
		const w = spec.wr2012;
		const areaKm2 = spec.farms.reduce((a, f) => a + (f.areaKm2 ?? 0), 0);
		const MONTH_DAYS = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30]; // Oct … Sep
		const scale = w.areaFactor * w.marFactor;
		const monthlyMm3 = monthlyMean.map((sum, m) => Math.round(((sum / monthlyN[m]) * MONTH_DAYS[m]! * scale) / 1e3) / 1e3);
		const mapMm = Math.round((truthRain.reduce((a, b) => a + b, 0) / DAYS) * 365.25);
		settings.wr2012 = {
			...d.wr2012,
			reference: {
				quaternary: w.quaternary,
				areaKm2: Math.round(areaKm2 * w.areaFactor),
				marMm3: Math.round(monthlyMm3.reduce((a, b) => a + b, 0) * 1000) / 1000,
				monthlyMm3,
				periodStart: w.periodStart,
				periodEnd: w.periodEnd,
				mapMm,
				source: 'Invented for the demo (not from WR2012): the example catchment’s own natural flow, scaled'
			}
		};
	}

	const project: ExampleProject = { name: spec.name, description: spec.description, settings, model, series };
	if (spec.fit && opts.fit) storeFit(project, spec.fit);
	return project;
}

/**
 * Run the automatic calibration the way Settings → Fit automatically does
 * (validated: split-sample and dry → wet tests), apply the parameters and
 * store the fit record, as "Apply to form" would.
 */
function storeFit(ex: ExampleProject, fit: { budget: number; seed: number }) {
	const report = calibrate(inputOf(ex), { model: 'gr4j', budget: fit.budget, seed: fit.seed, validate: true });
	const s = { ...defaultProjectSettings(), ...ex.settings };
	ex.settings.gr4j = { ...s.gr4j, ...report.params } as ProjectSettings['gr4j'];
	ex.settings.fitRecord = fitRecordFromReport(report, {
		settings: {
			calibrationStart: s.calibrationStart,
			calibrationEnd: s.calibrationEnd,
			calibrationExclusions: s.calibrationExclusions,
			panCoefficient: s.panCoefficient,
			apanMm: s.apanMm,
			chirpsBiasCorrection: s.chirpsBiasCorrection,
			zeroRainRuns: s.zeroRainRuns,
			pe: s.pe
		},
		validate: true,
		validationRecord: null,
		engineVersion: ENGINE_VERSION,
		fittedAt: FITTED_AT
	});
}

const ha = (o: Record<string, number>) => o;

/**
 * Healthy winter-rainfall catchment: branching network, two transfers by
 * priority, mixed fruit on drip and micro. Its rain gauge has the faults a
 * real record has — a stolen gauge (blank), a logger fault exported as zeros
 * (a flagged zero run) and a fortnight entered as 0 (a listed period) — which
 * bias-corrected CHIRPS fills, and three weeks read in one go (a multi-day
 * accumulation) that the run spreads back by CHIRPS. Its weir drowned in one flood year, which is
 * excluded from calibration, and GR4J is fitted to the record.
 */
const KLEINBERG: CatchmentSpec = {
	key: 'kleinberg',
	name: 'Example · Kleinberg (winter rainfall)',
	description:
		'Invented demo catchment. Winter-rainfall valley with two tributaries, four fruit and wine farms on drip and micro irrigation with on-farm dams, and two winter transfers from the upper dam, run by priority. The rain gauge has gaps that bias-corrected CHIRPS fills, one flood year is excluded from calibration, and GR4J is fitted to the weir record (Settings → Fit record). Mostly meets demand; the EWR is missed in dry summers.',
	climate: WINTER_RAIN,
	rainScale: 1.1,
	seed: 101,
	apan: APAN_WINTER_RAIN,
	ewrFraction: [0.3, 0.25, 0.2, 0.2, 0.2, 0.2, 0.25, 0.35, 0.4, 0.4, 0.4, 0.35],
	settings: {
		panCoefficient: panPreset('winter-rainfall'),
		chirpsBiasCorrection: 'monthly',
		zeroRainRuns: {
			mode: 'missing',
			keepDry: [],
			missing: [{ start: '2021-07-05', end: '2021-07-18', reason: 'Observer on leave: the fortnight was entered as 0 mm' }],
			accumulationMode: 'spread',
			keepReadings: [],
			addAccumulations: []
		},
		calibrationExclusions: [{ waterYear: 2013, reason: 'Weir drowned in the winter floods: peaks above its rating were not recorded' }]
	},
	// The record's own catchment is slower and holds more than GR4J's defaults, so the fit has something to find.
	truthGr4j: { x1: 480, x3: 65, x4: 2.1 },
	rainFaults: {
		blank: [['2016-03-10', '2016-05-20']],
		zeros: [
			['2019-06-01', '2019-08-15'],
			['2021-07-05', '2021-07-18']
		],
		// Three winter weeks read in one go: spread back over them (B4).
		accumulations: [['2017-06-05', '2017-06-26']]
	},
	// CHIRPS reads the orographic winter rain low (Jan … Dec).
	chirpsBias: [0.95, 0.95, 0.9, 0.8, 0.7, 0.65, 0.65, 0.65, 0.7, 0.8, 0.9, 0.95],
	observedCap: { waterYear: 2013, quantile: 0.85 },
	fit: { budget: 300, seed: 7 },
	farms: [
		{ name: 'Kleinberg Weir', kind: 'gauge', into: null },
		{ name: 'Rustenvrede', into: 'Kleinberg Weir', areaKm2: 14, damM3: 250_000, damDepthM: 4, divertM3Day: 3000, system: 'micro', lossReturn: 0.3, crops: ha({ Citrus: 45, Pasture: 20 }) },
		{ name: 'Bergwater', into: 'Rustenvrede', areaKm2: 18, damM3: 400_000, damDepthM: 5, divertM3Day: 4000, system: 'drip', lossReturn: 0.3, crops: ha({ Apples: 60, 'Wine grapes': 25 }) },
		{ name: 'Rooikloof', into: 'Bergwater', areaKm2: 22, damM3: 600_000, damDepthM: 6, divertM3Day: 5000, system: 'micro', lossReturn: 0.3, crops: ha({ Apples: 40 }) },
		{ name: 'Doornhoek', into: 'Rustenvrede', areaKm2: 16, damM3: 180_000, damDepthM: 3.5, divertM3Day: 2500, system: 'drip', lossReturn: 0.3, crops: ha({ 'Wine grapes': 50, Vegetables: 10 }) }
	],
	transfers: [
		// Doornhoek first; Rustenvrede gets what the upper dam can still spare.
		{ from: 'Rooikloof', to: 'Doornhoek', months: [6, 7, 8, 9], maxRateM3s: 0.03, minStoragePct: 0.3, priority: 0 },
		{ from: 'Rooikloof', to: 'Rustenvrede', months: [6, 7, 8, 9], maxRateM3s: 0.02, minStoragePct: 0.4, priority: 1 }
	]
};

/**
 * Over-allocated catchment: large irrigated areas, small shallow dams →
 * shortfalls and EWR failures. A logger beside the weir drifted high for a
 * year, which the gauge-vs-logger check flags.
 */
const DROEVLEI: CatchmentSpec = {
	key: 'droevlei',
	name: 'Example · Droëvlei (water-stressed)',
	description:
		'Invented demo catchment. Low rainfall and heavily irrigated citrus and lucerne (sprinkler, flood and micro) with small shallow dams, one of them a leaky earth dam: farms run short most summers and the EWR is regularly not met. The curtailment report covers the last four water years, and a logger beside the weir that drifted high for a year shows the gauge-vs-logger check. Use it to show the shortfall tables and how dam size, planted area or irrigation efficiency changes the outcome.',
	climate: WINTER_RAIN,
	rainScale: 0.6,
	seed: 202,
	apan: APAN_WINTER_RAIN.map((v) => Math.round(v * 1.15)),
	ewrFraction: [0.35, 0.3, 0.3, 0.3, 0.3, 0.3, 0.35, 0.45, 0.5, 0.5, 0.5, 0.45],
	settings: {
		// Sandy soils hold less of a storm for the crop than the 25 mm default.
		effectiveRainStoreMm: 15,
		// Shallow dams in a hot, windy valley.
		lakeEvapFactor: 0.8,
		calibrationFlowKind: 'flow_observed_m3s',
		reportStart: '2020-10-01',
		reportEnd: '2024-09-30'
	},
	logger: { from: '2016-01-01', drift: { waterYear: 2020, factor: 1.9 } },
	farms: [
		{ name: 'Droëvlei Gauge', kind: 'gauge', into: null },
		{ name: 'Kareebos', into: 'Droëvlei Gauge', areaKm2: 12, damM3: 60_000, damDepthM: 2.5, divertM3Day: 1500, system: 'movable', crops: ha({ Citrus: 110, Lucerne: 40 }) },
		{ name: 'Sandkraal', into: 'Kareebos', areaKm2: 10, damM3: 40_000, damDepthM: 2.5, damMin: 0.2, seepage: 0.001, divertM3Day: 1200, system: 'surface', lossReturn: 0.6, crops: ha({ Lucerne: 80 }) },
		{ name: 'Brakfontein', into: 'Sandkraal', areaKm2: 9, damM3: 80_000, damDepthM: 3, divertM3Day: 1000, system: 'micro', crops: ha({ Citrus: 70 }) }
	]
};

/** Larger summer-rainfall network with an intermediate gauge, three transfers and a WR2012 check. */
const SANDSPRUIT: CatchmentSpec = {
	key: 'sandspruit',
	name: 'Example · Sandspruit (summer rainfall, larger network)',
	description:
		'Invented demo catchment. Summer thunderstorm rainfall, eight farms on two tributaries that meet above a mid-catchment gauge, maize under centre pivots, lucerne and vegetables, and three transfers: two of equal priority share the Grootdraai dam, one has a daily cap. Calibration scores a window, a gauge on a neighbouring river is kept as a reference, a 10-day forecast extends the run, and natural flow is checked against a WR2012-style reference. Shows a bigger network tree and per-node results.',
	climate: SUMMER_RAIN,
	rainScale: 1.0,
	seed: 303,
	apan: APAN_SUMMER_RAIN,
	ewrFraction: [0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.35, 0.4, 0.4, 0.4, 0.35, 0.3],
	settings: {
		panCoefficient: panPreset('summer-rainfall'),
		calibrationStart: '2011-10-01',
		calibrationEnd: '2021-09-30'
	},
	referenceGauge: { name: 'Neighbouring river weir (synthetic, reference only)', scale: 0.7 },
	forecastDays: 10,
	// The model is about 11 % drier than the reference: noted, not queried.
	wr2012: { quaternary: 'X99Z', areaFactor: 1.6, marFactor: 1.12, periodStart: 1920, periodEnd: 2009 },
	farms: [
		{ name: 'Sandspruit Outlet', kind: 'gauge', into: null },
		{ name: 'Melkhout Gauge', kind: 'gauge', into: 'Uitkyk' },
		{ name: 'Uitkyk', into: 'Sandspruit Outlet', areaKm2: 20, damM3: 300_000, damDepthM: 4, divertM3Day: 4000, system: 'pivot', crops: ha({ Maize: 80, Lucerne: 30 }) },
		{ name: 'Lemoenkraal', into: 'Melkhout Gauge', areaKm2: 24, damM3: 500_000, damDepthM: 5, divertM3Day: 5000, system: 'pivot', crops: ha({ Maize: 120 }) },
		{ name: 'Vaalbank', into: 'Lemoenkraal', areaKm2: 30, damM3: 350_000, damDepthM: 4, divertM3Day: 4000, system: 'movable', crops: ha({ Lucerne: 60, Vegetables: 15 }) },
		{ name: 'Klipdrift', into: 'Vaalbank', areaKm2: 26, damM3: 60_000, damDepthM: 3, divertM3Day: 1200, system: 'pivot', crops: ha({ Maize: 170 }) },
		{ name: 'Wilgerivier', into: 'Melkhout Gauge', areaKm2: 22, damM3: 450_000, damDepthM: 4.5, divertM3Day: 4500, system: 'movable', crops: ha({ Vegetables: 25, Lucerne: 40 }) },
		{ name: 'Grootdraai', into: 'Wilgerivier', areaKm2: 28, damM3: 800_000, damDepthM: 6, divertM3Day: 6000, system: 'pivot', crops: ha({ Maize: 60 }) },
		{ name: 'Bosrand', into: 'Grootdraai', areaKm2: 18, damM3: 150_000, damDepthM: 3.5, divertM3Day: 2000, system: 'drip', crops: ha({ Vegetables: 30 }) },
		{ name: 'Rietspruit', into: 'Uitkyk', areaKm2: 16, damM3: 120_000, damDepthM: 3.5, divertM3Day: 2000, system: 'pivot', crops: ha({ Lucerne: 45 }) }
	],
	transfers: [
		// Equal priority from one dam: they share Grootdraai's spare water pro rata to their limits.
		{ from: 'Grootdraai', to: 'Lemoenkraal', months: [9, 10, 11], maxRateM3s: 0.05, minStoragePct: 0.35, priority: 0 },
		{ from: 'Grootdraai', to: 'Uitkyk', months: [9, 10, 11], maxRateM3s: 0.03, minStoragePct: 0.35, priority: 0 },
		{ from: 'Vaalbank', to: 'Rietspruit', months: [7, 8, 9], maxRateM3s: 0.02, dailyCapM3: 1500, minStoragePct: 0.3, priority: 1 }
	]
};

export const EXAMPLES = [KLEINBERG, DROEVLEI, SANDSPRUIT];

export interface BuildOptions {
	/**
	 * Run the automatic calibration for the examples that store a fit
	 * (Kleinberg). Several seconds; tests that only need the model can skip it,
	 * which leaves those examples on GR4J's default parameters.
	 */
	fit: boolean;
}

export const buildExamples = (opts: BuildOptions = { fit: true }): ExampleProject[] => EXAMPLES.map((s) => build(s, opts));
