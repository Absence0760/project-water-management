// Seeded random generator of valid ModelInputs, for the invariant (property)
// tests in *.invariants.test.ts. "Valid" = passes the backend's validation
// (backend/src/model/validate.ts): one outflow node, no cycles, fractions in
// 0–1, non-negative volumes, transfers between distinct existing nodes.
//
// The generator deliberately over-weights edge values (0 and 1 fractions, empty
// dams, zero areas, huge storms, long dry spells, missing days, leap days, runs
// that start and end mid water-year) because that is where balance bugs hide.
// Everything is a pure function of the seed: a failing seed reproduces exactly.
import { withMonthlyRates } from '../network/transferRates';
import type { AllocationEntry } from '../allocations/compare';
import { DEMAND_PARTS, irrigationFromReturnFlow, LAND_COVER_CLASSES, type DemandPart, type DroughtRestrictionRule, type Borehole, type DemandObject, type LandCoverPatch, type CropArea, type CropDef, type DailySeries, type ModelInput, type NetworkNode, type ProjectSettings, type SeriesKind, type Transfer } from '../project';
import { fromEpochDay, toEpochDay, type Monthly } from '../calendar';
import { Rng } from '../random';
import { GR4J_PARAMS } from '../runoff/params';
import { DEFAULT_ASSURANCE_POINTS } from '../reserve/rules';

export { Rng };

type Shape = 'chain' | 'fan' | 'random' | 'binary' | 'twoBranches';

export interface GenOptions {
	maxNodes?: number;
	maxDays?: number;
	/**
	 * false: keep the allocations but run them compare only (engine ≥ 1.18.0),
	 * for properties of the demand model that a full allocation (which scales
	 * demand to the registered volumes) or a cap would break. The random
	 * stream, and so the rest of each seed, is unchanged.
	 */
	allocationModes?: boolean;
}

const monthly = (f: (m: number) => number): Monthly => Array.from({ length: 12 }, (_, m) => f(m)) as unknown as Monthly;

/** Daily rain with long dry spells, wet spells, the odd huge storm and missing days. */
function rainSeries(rng: Rng, days: number): (number | null)[] {
	const out: (number | null)[] = new Array(days);
	const pMissing = rng.pick([0, 0, 0.01, 0.05, 0.3]);
	const stormP = rng.pick([0, 0.002, 0.01]);
	let wet = rng.bool(0.3);
	let spellLeft = 0;
	for (let t = 0; t < days; t++) {
		if (spellLeft <= 0) {
			wet = !wet;
			// Dry spells of up to more than a year; wet spells of days to weeks.
			spellLeft = wet ? rng.int(1, 20) : rng.pick([rng.int(1, 30), rng.int(30, 450)]);
		}
		spellLeft--;
		let v: number | null;
		if (rng.bool(stormP)) v = rng.float(150, 600);
		else if (!wet) v = rng.bool(0.05) ? rng.float(0, 3) : 0;
		else v = Math.round(rng.logFloat(0.1, 80) * 10) / 10;
		if (rng.bool(pMissing)) v = null;
		out[t] = v;
	}
	// A block of missing days now and then (a gauge outage).
	if (days > 20 && rng.bool(0.2)) {
		const a = rng.int(0, days - 1);
		const b = Math.min(days, a + rng.int(1, 200));
		for (let t = a; t < b; t++) out[t] = null;
	}
	return out;
}

function flowSeries(rng: Rng, days: number, scale: number): (number | null)[] {
	const out: (number | null)[] = new Array(days);
	let q = rng.float(0, scale);
	const pMissing = rng.pick([0, 0.05, 0.5]);
	for (let t = 0; t < days; t++) {
		q = rng.bool(0.05) ? rng.float(0, scale * 10) : q * rng.float(0.8, 1.02);
		out[t] = rng.bool(pMissing) ? null : rng.bool(0.02) ? 0 : q;
	}
	return out;
}

/**
 * One random valid ModelInput. Node ids are "n0", "n1", …; the outflow node is
 * always n0 (the invariance test shuffles the array, so nothing may rely on it).
 */
function capFlowShares(settings: Partial<ProjectSettings>, nodes: NetworkNode[]): void {
	const split = settings.hiLoSplit!;
	if (split.hi + split.lo > 1) settings.hiLoSplit = { hi: split.hi / (split.hi + split.lo), lo: split.lo / (split.hi + split.lo) };
	const farms = nodes.filter((n) => n.kind === 'farm');
	const sum = farms.reduce((a, n) => a + (n.flowShareManual ?? 0), 0);
	if (sum > 1) for (const n of farms) if (n.flowShareManual !== null) n.flowShareManual /= sum;
}

export function randomInput(seed: number, opts: GenOptions = {}): ModelInput {
	const rng = new Rng(seed);
	// Irrigation efficiency and loss return (engine ≥ 0.16.0) come from their own
	// generator, so the rest of a seed's network is what it was before them.
	const ops = new Rng(seed ^ 0x2c1b3c6d);
	// Dam evaporation and seepage (N2) likewise, and transfer priorities (Q18).
	const dl = new Rng(seed ^ 0x6a09e667);
	const pr = new Rng(seed ^ 0x3c6ef372);
	const maxNodes = opts.maxNodes ?? 25;
	const maxDays = opts.maxDays ?? 1200;

	// --- network ---------------------------------------------------------------
	const n = rng.bool(0.1) ? 1 : rng.int(1, maxNodes);
	const shape: Shape = rng.pick(['chain', 'fan', 'random', 'binary', 'twoBranches'] as const);
	const pGauge = rng.pick([0, 0.1, 0.3]);
	const nodes: NetworkNode[] = [];
	for (let i = 0; i < n; i++) {
		let down: number | null = null;
		if (i > 0) {
			if (shape === 'chain') down = i - 1;
			else if (shape === 'fan') down = 0;
			else if (shape === 'binary') down = Math.floor((i - 1) / 2);
			else if (shape === 'twoBranches') down = i <= 2 ? 0 : i - 2;
			else down = rng.int(0, i - 1);
		}
		const isGauge = i === 0 ? rng.bool(0.7) : rng.bool(pGauge);
		const hasDam = rng.bool(0.65);
		const cap = !hasDam ? 0 : rng.bool(0.1) ? rng.float(0, 5) : rng.bool(0.3) ? Math.round(rng.logFloat(10, 3e6)) : rng.logFloat(10, 3e6);
		const area = rng.bool(0.1) ? 0 : rng.logFloat(0.01, 150);
		const hiPart = rng.frac(0.2, 0.2);
		nodes.push({
			id: `n${i}`,
			name: `Node ${i}`,
			kind: isGauge ? 'gauge' : 'farm',
			downstreamNodeId: down === null ? null : `n${down}`,
			sortOrder: i,
			areaKm2: area,
			areaHiKm2: area * hiPart,
			areaLoKm2: rng.bool(0.1) ? area : area * (1 - hiPart),
			flowShareManual: rng.bool(0.1) ? null : rng.frac(0.1, 0.05),
			pctUpstreamToDam: rng.frac(),
			pctRunoffToDam: rng.frac(),
			damCapacityM3: cap,
			damInitialPct: rng.frac(),
			damMinPct: rng.frac(),
			divertCapacityM3Day: rng.bool(0.3) ? 0 : rng.bool(0.1) ? 1e9 : rng.bool(0.5) ? rng.logFloat(0.5, 1e5) : Math.round(rng.logFloat(1, 1e5)),
			...irrigationOps(ops, rng.bool(0.4) ? 0 : rng.frac(0, 0.05)),
			...damLossOps(dl)
		});
	}
	const farms = nodes.filter((x) => x.kind === 'farm');
	// The rain model needs a catchment area: make sure at least one farm has land.
	if (farms.length === 0) nodes[n - 1]!.kind = 'farm';
	if (!nodes.some((x) => x.kind === 'farm' && x.areaKm2 > 0)) {
		const f = nodes.find((x) => x.kind === 'farm')!;
		f.areaKm2 = rng.logFloat(0.1, 50);
		f.areaHiKm2 = f.areaKm2 / 2;
		f.areaLoKm2 = f.areaKm2 / 2;
	}
	// Other water users (WP-1.33), from their own stream so the rest of a seed's network is what it was.
	addUsers(new Rng(seed ^ 0x510e527f), nodes);
	// Boreholes and stream depletion (WP-1.34), likewise from their own stream.
	addBoreholes(new Rng(seed ^ 0x9b05688c), nodes);
	// Dam survey curves, releases and the seepage destination (WP-3.5), likewise.
	addDamStorage(new Rng(seed ^ 0x1b873593), nodes);
	const farmIds = nodes.filter((x) => x.kind === 'farm').map((x) => x.id);

	// --- crops -------------------------------------------------------------------
	const nCrops = rng.int(0, 5);
	const crops: CropDef[] = Array.from({ length: nCrops }, (_, c) => ({
		id: `c${c}`,
		name: `Crop ${c}`,
		sortOrder: c,
		cropFactor: Array.from({ length: 12 }, () => (rng.bool(0.15) ? 0 : Math.round(rng.float(0, 1.3) * 100) / 100))
	}));
	const areaScale = rng.pick([1e3, 1e5, 1e6, 1e7]);
	const cropAreas: CropArea[] = [];
	for (const f of farmIds) {
		if (rng.bool(0.3)) continue;
		for (const c of crops) {
			if (rng.bool(0.5)) continue;
			cropAreas.push({ nodeId: f, cropId: c.id, areaM2: rng.bool(0.05) ? 0 : rng.float(0, areaScale) });
		}
	}

	// --- transfers ---------------------------------------------------------------
	const transfers: Transfer[] = [];
	const nTransfers = n < 2 ? 0 : rng.pick([0, 0, 1, 1, 2, 3, 5]);
	for (let k = 0; k < nTransfers; k++) {
		// Mostly farm → farm; now and then a gauge end, which the engine must skip.
		const pool = rng.bool(0.05) ? nodes.map((x) => x.id) : farmIds;
		if (pool.length < 2) break;
		const from = rng.pick(pool);
		let to = rng.pick(pool);
		while (to === from) to = rng.pick(pool);
		const months = rng.bool(0.1) ? [] : rng.bool(0.2) ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [...new Set(Array.from({ length: rng.int(1, 8) }, () => rng.int(1, 12)))];
		transfers.push({
			id: `t${k}`,
			fromNodeId: from,
			toNodeId: to,
			months,
			maxRateM3s: rng.bool(0.1) ? 0 : rng.bool(0.1) ? 1e4 : rng.logFloat(1e-4, 2),
			dailyCapM3: rng.bool(0.6) ? null : rng.bool(0.1) ? 0 : rng.logFloat(1, 1e5),
			minStoragePct: rng.frac(0.3, 0.2),
			enabled: rng.bool(0.9),
			// Ties are common on purpose: equal priorities share a dam pro rata.
			priority: pr.pick([0, 0, 1, 2, k])
		});
	}

	// --- period and series -----------------------------------------------------------
	const days = rng.bool(0.05) ? rng.int(1, 5) : rng.bool(0.1) ? rng.int(maxDays, maxDays * 3) : rng.int(5, maxDays);
	// Any day 1979–2031: runs start and end mid water-year, and many cross a 29 Feb.
	const start = toEpochDay('1979-01-01') + rng.int(0, 52 * 365);
	const startDate = fromEpochDay(start);
	const series: Partial<Record<SeriesKind, DailySeries>> = {};
	const shifted = (len: number) => {
		const off = rng.bool(0.7) ? 0 : rng.int(-30, 30);
		return { startDate: fromEpochDay(start + off), len: Math.max(1, len + (rng.bool(0.5) ? 0 : rng.int(-30, 30))) };
	};
	const rainSource = rng.pick(['catchment', 'catchment', 'catchment', 'chirps', 'several'] as const);
	if (rainSource === 'catchment' || rainSource === 'several') series.rain_catchment_mm = { startDate, values: rainSeries(rng, days) };
	if (rainSource === 'chirps' || rainSource === 'several') {
		const s = shifted(days);
		series.rain_chirps_mm = { startDate: s.startDate, values: rainSeries(rng, s.len) };
	}
	if (rainSource === 'several' && rng.bool(0.5)) {
		const s = shifted(days);
		series.rain_forecast_mm = { startDate: s.startDate, values: rainSeries(rng, s.len) };
	}
	if (rng.bool(0.5)) {
		const s = shifted(days);
		series.flow_observed_m3s = { startDate: s.startDate, values: flowSeries(rng, s.len, 1) };
	}
	if (rng.bool(0.3)) {
		const s = shifted(days);
		series.flow_logger_m3s = { startDate: s.startDate, values: flowSeries(rng, s.len, 1) };
	}

	// --- settings ------------------------------------------------------------------------
	const ewrScale = rng.pick([0, 0, 100, 10_000, 1e6, 1e10]);
	const iso = (off: number) => fromEpochDay(start + off);
	const settings: Partial<ProjectSettings> = {
		februaryDays: rng.pick([28.25, 28.25, 28, 29]),
		effectiveRainFraction: rng.frac(0.1, 0.1),
		apanMm: monthly(() => (rng.bool(0.1) ? 0 : rng.float(0, 300))),
		flowShareMethod: rng.pick(['area', 'area', 'hiLo', 'manual'] as const),
		hiLoSplit: rng.bool(0.7) ? { hi: 0.5, lo: 0.5 } : { hi: rng.frac(), lo: rng.frac() },
		ewrPragmaticM3PerDay: monthly(() => (rng.bool(0.1) ? 0 : rng.float(0, ewrScale))),
		calibration: {
			...defaultCalibrationOverrides(rng)
		} as ProjectSettings['calibration']
	};
	if (rng.bool(0.15)) {
		settings.simulationStart = iso(rng.int(-20, Math.max(0, days - 1)));
		settings.simulationEnd = iso(rng.int(toEpochDay(settings.simulationStart) - start, days + 20));
	}
	if (rng.bool(0.3)) {
		settings.reportStart = rng.bool(0.2) ? null : iso(rng.int(-50, days));
		settings.reportEnd = rng.bool(0.2) ? null : iso(rng.int(-50, days + 50));
	}
	if (rng.bool(0.3)) {
		settings.calibrationStart = iso(rng.int(-50, days));
		settings.calibrationEnd = iso(rng.int(-50, days + 50));
	}
	if (rng.bool(0.2)) settings.calibrationFlowKind = rng.pick(['flow_observed_m3s', 'flow_logger_m3s'] as const);
	// GR4J (the only runoff model since engine 1.0.0) draws its parameters from a second generator, so a seed's network and series don't depend on them.
	{
		const g = new Rng(seed ^ 0x5bd1e995);
		const p = Object.fromEntries(
			GR4J_PARAMS.map((s) => [s.key, s.fixedByDefault ? (g.bool(0.25) ? g.float(s.min, s.max) : s.default) : g.bool(0.1) ? g.pick([s.min, s.max]) : g.logFloat(Math.max(s.min, 1e-3), s.max)])
		) as Record<string, number>;
		settings.runoffModel = 'gr4j';
		settings.gr4j = { x1: p.x1!, x2: p.x2!, x3: p.x3!, x4: p.x4!, warmupDays: g.pick([0, 0, 30, 365, 365, 1000]) };
		settings.panCoefficient = g.bool(0.5) ? monthly(() => 0.7) : monthly(() => (g.bool(0.1) ? 0 : g.float(0.3, 1.2)));
		// Sometimes GR4J's PE comes as a monthly row instead (engine ≥ 0.31.0). Its own stream, so a seed still builds the same network.
		const pe = new Rng(seed ^ 0x3c6ef372);
		if (pe.bool(0.25)) settings.pe = { kind: 'monthly', mm: monthly(() => (pe.bool(0.1) ? 0 : pe.float(0, 250))), source: 'fuzz: invented monthly PE' };
	}
	// The soil-water store (N3): none, the default, anything, or practically
	// endless. From its own stream, so a seed still builds the same network.
	const sw = new Rng(seed ^ 0x2545f491);
	settings.effectiveRainStoreMm = sw.pick([0, 25, 25, sw.float(0, 200), 1e6]);
	// Dam evaporation (N2): the default, none, anything up to well above an open-water factor.
	settings.lakeEvapFactor = dl.pick([0.75, 0.75, 0, dl.float(0, 2)]);
	// Monthly lake factors (WP-3.5) in 20 % of seeds, from their own stream.
	const lk = new Rng(seed ^ 0xcc9e2d51);
	if (lk.bool(0.2)) settings.lakeEvapFactorMonthly = monthly(() => (lk.bool(0.1) ? 0 : lk.float(0.4, 1.3)));
	// Crop demand options (engine ≥ 0.43.0, issue #54), from their own stream so a seed still
	// builds the same network: monthly effective-rain fractions in 20 % of seeds (a month of 0
	// or 1 now and then), and an own irrigation efficiency on a third of the crops.
	const cd = new Rng(seed ^ 0x85ebca6b);
	if (cd.bool(0.2)) settings.effectiveRainFractionMonthly = monthly(() => (cd.bool(0.1) ? 0 : cd.bool(0.05) ? 1 : cd.float(0, 1)));
	for (const c of crops) if (cd.bool(1 / 3)) c.irrigationEfficiency = cd.bool(0.1) ? 1 : cd.bool(0.05) ? cd.float(0.01, 0.1) : cd.float(0.5, 1);
	// The CHIRPS gap map (engine ≥ 1.53.0, CR-23) in 30 % of seeds with CHIRPS, from its own stream so a seed still builds the same network.
	const qm = new Rng(seed ^ 0x1b873593);
	if (series.rain_chirps_mm && qm.bool(0.3)) settings.chirpsQuantileMap = { wetDayMm: qm.pick([1, 1, qm.float(0.1, 10)]) };
	// Calibration exclusions: date ranges and water years, in or around the run,
	// overlapping or not. Their own stream too.
	const cx = new Rng(seed ^ 0xbb67ae85);
	if (cx.bool(0.3)) {
		settings.calibrationExclusions = Array.from({ length: cx.int(1, 3) }, (_, i) => {
			const a = cx.int(-60, days);
			return cx.bool(0.3)
				? { waterYear: Number(iso(a).slice(0, 4)) + i * 3, reason: 'fuzz' }
				: { start: iso(a), end: iso(a + cx.int(0, 400)), reason: 'fuzz' };
		});
	}
	// EWR rule tables (engine ≥ 0.21.0): at the outlet, gauges, now and then a
	// farm or a missing node (both skipped), with any points, units, natural
	// source and scale, rows that need not fall. Their own stream too.
	const er = new Rng(seed ^ 0x9b05688c);
	if (er.bool(0.3)) {
		const gauges = nodes.filter((nd) => nd.kind === 'gauge').map((nd) => nd.id);
		const sites = [null, ...gauges, ...(er.bool(0.1) ? ['n1', 'missing'] : [])].filter(() => er.bool(0.7));
		settings.ewrRules = sites.map((siteNodeId) => {
			const points = er.bool(0.7) ? [...DEFAULT_ASSURANCE_POINTS] : [...new Set(Array.from({ length: er.int(2, 12) }, () => er.int(1, 100)))].sort((a, b) => a - b);
			const size = er.pick([0.001, 1, 100, 1e5]);
			const grid = () =>
				Array.from({ length: 12 }, () => {
					const row = points.map(() => (er.bool(0.1) ? 0 : er.logFloat(1e-6, 1) * size)).sort((a, b) => b - a);
					// Now and then a row that rises somewhere (a typo in a pasted table).
					if (er.bool(0.1)) row.reverse();
					return row;
				});
			const naturalSource = er.pick(['run', 'run', 'table'] as const);
			return {
				siteNodeId,
				source: 'fuzz',
				component: er.pick(['total', 'lowFlow'] as const),
				unit: er.pick(['mcm', 'm3s'] as const),
				points,
				ewr: grid(),
				naturalSource,
				natural: naturalSource === 'table' ? grid() : null,
				scale: er.pick([1, 1, er.logFloat(0.01, 100)])
			};
		});
		// Low flows and high-flow components (engine ≥ 0.33.0), from their own stream so the
		// tables above are what they were: a low-flow grid on some total tables (now and then
		// above the total), freshets and floods of any peak, length and count.
		const eh = new Rng(seed ^ 0x9b05688d);
		for (const t of settings.ewrRules) {
			if (t.component === 'total' && eh.bool(0.4)) t.lowFlow = t.ewr.map((row) => row.map((v) => v * eh.pick([0.3, 0.6, 1, eh.float(0, 1.3)])));
			if (eh.bool(0.4)) {
				t.highFlows = Array.from({ length: eh.int(1, 3) }, (_, k) => ({
					label: `fuzz ${k + 1}`,
					months: [...new Set(Array.from({ length: eh.int(1, 6) }, () => eh.int(1, 12)))],
					peakM3s: eh.logFloat(1e-4, 100),
					durationDays: eh.int(1, 10),
					perYear: eh.int(1, 3)
				}));
			}
		}
		// What the charge follows and what low flows are judged on (engine ≥ 1.3.0, issue #64),
		// from their own stream so the tables above are what they were.
		const em = new Rng(seed ^ 0x9b05688e);
		if (em.bool(0.4)) settings.ewrChargeSource = 'ruleTable';
		if (em.bool(0.4)) settings.lowFlowMeasure = 'baseflow';
	}

	// Flow shares over 100 % are refused by the run (engine 0.27.1: they make
	// water from nowhere), so scale them down to 100 % after every draw: the
	// random stream, and so the rest of each seed, is unchanged. Under 100 %
	// stays, since the run allows it with a warning.
	capFlowShares(settings, nodes);

	// Land cover (WP-1.35), from its own stream: the rest of the seed is unchanged.
	const landCover = randomLandCover(new Rng(seed ^ 0x1f83d9ac), nodes);
	// Individual boreholes (WP-3.9), from their own stream too.
	const boreholes = randomBoreholes(new Rng(seed ^ 0x3c6ef372), nodes);
	// Supply rules and river pumps (WP-3.8), from their own stream and last, so
	// the rest of every seed (transfers and boreholes included) is what it was.
	addSupply(new Rng(seed ^ 0x5be0cd19), nodes);
	// Demand objects (engine ≥ 1.7.0), from their own stream and last of all, so every seed's rest is what it was.
	const demandObjects = randomDemandObjects(new Rng(seed ^ 0x9e3779b9), nodes);
	// Their schedules (engine ≥ 1.17.0), from their own stream, so the objects themselves are what they were.
	addSchedules(new Rng(seed ^ 0x510e527f), demandObjects, start, days);
	// Monthly transfer rates (engine ≥ 1.14.0), from their own stream, after everything else.
	addMonthlyRates(new Rng(seed ^ 0x6a09e667), transfers);
	// River off-takes (engine ≥ 1.14.0), from their own stream, last of all.
	addOfftakes(new Rng(seed ^ 0xbb67ae85), nodes, transfers);
	// Registered volumes and the allocation mode (engine ≥ 1.18.0), from their own stream, after everything else.
	const allocations = randomAllocations(new Rng(seed ^ 0x510e527f), nodes, settings, start, days);
	if (opts.allocationModes === false && settings.allocationMode) settings.allocationMode = 'none';
	// Their licence conditions (engine ≥ 1.37.0), from their own stream, so the volumes themselves are what they were.
	addLicenceConditions(new Rng(seed ^ 0x6c9e0e8b), allocations);
	// Development over the run (engine ≥ 1.30.0), from its own stream, last of all.
	addDevelopment(new Rng(seed ^ 0x1f83d9ad), nodes, start, days);
	// Hands-off flows and River to dam by month (engine ≥ 1.32.0), from their own stream, last of all.
	addOperating(new Rng(seed ^ 0x2b3c4d5e), nodes);
	// Canal seepage back to the river (engine ≥ 1.42.0), from its own stream, last of all.
	addOfftakeReturns(new Rng(seed ^ 0x3f1a7c2d), nodes, transfers);
	// The drought restriction rule (engine ≥ 1.54.0, WP-3.8), from its own stream, last of all.
	addDroughtRestriction(new Rng(seed ^ 0x7f4a7c15), settings, nodes);
	return {
		settings,
		model: {
			nodes,
			crops,
			cropAreas,
			transfers,
			...(landCover.length ? { landCover } : {}),
			...(boreholes.length ? { boreholes } : {}),
			...(demandObjects.length ? { demandObjects } : {}),
			...(allocations.length ? { allocations } : {})
		},
		series
	};
}

/**
 * The drought restriction rule (engine ≥ 1.54.0, WP-3.8, docs/model.md §2.7i)
 * in 25 % of seeds: one to twelve review dates (now and then every month's
 * first), lift dates half the time, one to four levels from 100 % down (a
 * level at 100 % is in force whenever a dam isn't full), each cutting a
 * random set of parts, deeper levels at least as much, up to a whole part
 * (100 %), so the basic-needs floor is what keeps a town's water.
 */
function addDroughtRestriction(g: Rng, settings: Partial<ProjectSettings>, nodes: readonly NetworkNode[]): void {
	if (!g.bool(0.25)) return;
	settings.droughtRestriction = randomDroughtRestriction(g, nodes);
}

/** One random valid drought restriction rule (addDroughtRestriction's), for the rule's own fuzz tests. */
export function randomDroughtRestriction(g: Rng, nodes?: readonly NetworkNode[]): DroughtRestrictionRule {
	const md = () => {
		const m = g.int(1, 12);
		const d = g.int(1, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!);
		return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
	};
	const reviews = g.bool(0.15) ? Array.from({ length: 12 }, (_, m) => `${String(m + 1).padStart(2, '0')}-01`) : [...new Set(Array.from({ length: g.int(1, 4) }, md))];
	const lifts = g.bool(0.5) ? [...new Set(Array.from({ length: g.int(1, 3) }, md))].filter((d) => !reviews.includes(d)) : [];
	const n = g.int(1, 4);
	let below = g.bool(0.2) ? 1 : g.float(0.3, 1);
	const cuts: Partial<Record<DemandPart, number>> = {};
	const levels = Array.from({ length: n }, (_, i) => {
		for (const p of DEMAND_PARTS) {
			if (!g.bool(0.5) && cuts[p] === undefined) continue;
			const was = cuts[p] ?? 0;
			cuts[p] = g.bool(0.1) ? 1 : Math.min(1, was + g.float(0, 0.5));
		}
		const level = { ...(g.bool(0.5) ? { label: `L${i + 1}` } : {}), belowPct: below, cuts: { ...cuts } };
		below = below * g.float(0.2, 0.95);
		return level;
	});
	const rule: DroughtRestrictionRule = { reviewDates: reviews, ...(lifts.length ? { liftDates: lifts } : {}), levels };
	if (!nodes) return rule;
	// Engine ≥ 1.54.0, drawn after the rest so a rule's dates and levels are what they were: the storage read
	// (every dam, some dams, or each unit's own), the units cut, and an EWR trigger; now and then an id the
	// network hasn't got (the run leaves it out with a warning).
	const farms = nodes.filter((n) => n.kind === 'farm');
	const dams = farms.filter((n) => n.damCapacityM3 > 0);
	const some = <T>(xs: readonly T[]) => xs.filter(() => g.bool(0.5));
	const basis = g.pick(['total', 'total', 'dams', 'own'] as const);
	if (basis === 'own') rule.basis = 'own';
	if (basis === 'dams') {
		const picked = some(dams).map((n) => n.id);
		rule.basis = 'dams';
		rule.damNodeIds = picked.length ? picked : [dams[0]?.id ?? 'missing-dam'];
	}
	if (g.bool(0.3)) {
		const picked = some(farms).map((n) => n.id);
		rule.nodeIds = picked.length ? picked : [farms[0]?.id ?? 'missing-unit'];
	}
	if (g.bool(0.35)) {
		const gauges = nodes.filter((n) => n.kind === 'gauge');
		rule.ewrTrigger = { siteNodeId: gauges.length && g.bool(0.5) ? g.pick(gauges).id : g.bool(0.1) ? 'missing-site' : null, level: g.int(1, levels.length) };
	}
	return rule;
}

/**
 * Monthly transfer rates (engine ≥ 1.14.0) in 25 % of seeds, on each rule half
 * the time: twelve rates from a trickle to more than any dam holds, some
 * months off (0), now and then every month off; the months and max rate kept
 * beside them follow (withMonthlyRates), as every editor writes them.
 */
function addMonthlyRates(g: Rng, transfers: Transfer[]): void {
	if (!g.bool(0.25)) return;
	for (const t of transfers) {
		if (!g.bool(0.5)) continue;
		const allOff = g.bool(0.05);
		const rates = Array.from({ length: 12 }, () => (allOff || g.bool(0.3) ? 0 : g.bool(0.1) ? 1e4 : g.logFloat(1e-4, 2)));
		Object.assign(t, withMonthlyRates(rates));
	}
}

/**
 * River off-takes (engine ≥ 1.14.0) in 25 % of seeds: one to three rules
 * between random farms (now and then a gauge end, which the engine skips,
 * and destinations that drain into their source, which it skips too), with
 * capacities from a trickle to more than any flow, monthly rates now and
 * then, either sizing, a hands-off flow, the EWR kept or not, conveyance
 * losses up to 60 %, the dam topped up or not, tied priorities, some off.
 */
function addOfftakes(g: Rng, nodes: NetworkNode[], transfers: Transfer[]): void {
	if (!g.bool(0.25)) return;
	const farms = nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
	if (farms.length < 2) return;
	const count = g.int(1, 3);
	for (let k = 0; k < count; k++) {
		const pool = g.bool(0.05) ? nodes.map((n) => n.id) : farms;
		const from = g.pick(pool);
		let to = g.pick(pool);
		while (to === from) to = g.pick(pool);
		const t: Transfer = {
			id: `o${k}`,
			fromNodeId: from,
			toNodeId: to,
			months: g.bool(0.2) ? [...new Set(Array.from({ length: g.int(1, 8) }, () => g.int(1, 12)))] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			maxRateM3s: g.pick([0, g.logFloat(1e-5, 0.05), g.logFloat(1e-3, 10)]),
			dailyCapM3: g.bool(0.7) ? null : g.logFloat(1, 1e5),
			minStoragePct: g.frac(0.5, 0.2),
			enabled: g.bool(0.9),
			priority: g.pick([0, 0, 1, k]),
			source: 'river',
			handsOffM3Day: g.bool(0.6) ? null : g.pick([0, g.logFloat(1, 1e5)]),
			handsOffEwr: g.bool(0.3),
			lossPct: g.bool(0.5) ? 0 : g.float(0, 0.6),
			sizing: g.pick(['demand', 'capacity'] as const),
			topUpDam: g.bool(0.4)
		};
		if (g.bool(0.2)) Object.assign(t, withMonthlyRates(Array.from({ length: 12 }, () => (g.bool(0.3) ? 0 : g.logFloat(1e-4, 1)))));
		transfers.push(t);
	}
}

/**
 * Canal seepage back to the river (engine ≥ 1.42.0): on half the river
 * off-takes with losses, a share of them (all of it now and then) rejoining
 * below the source or a unit on the river below it, now and then one that
 * isn't (the engine returns none, with a warning).
 */
function addOfftakeReturns(g: Rng, nodes: NetworkNode[], transfers: Transfer[]): void {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	for (const t of transfers) {
		if (t.source !== 'river' || !((t.lossPct ?? 0) > 0) || !g.bool(0.5)) continue;
		t.lossReturnPct = g.bool(0.2) ? 1 : g.float(0, 1);
		const below: string[] = [];
		for (let id: string | null | undefined = t.fromNodeId; id && !below.includes(id); id = byId.get(id)?.downstreamNodeId) below.push(id);
		t.lossReturnNodeId = g.bool(0.05) ? g.pick(nodes).id : g.bool(0.4) ? null : g.pick(below);
	}
}

/**
 * Land-cover patches (WP-1.35) in 30 % of seeds: on random nodes (gauges and
 * users too, which the engine skips), any class, from a sliver to more than
 * the unit (scaled down), any density, the class defaults or overrides at the
 * edges 0 and 1.
 */
function randomLandCover(g: Rng, nodes: NetworkNode[]): LandCoverPatch[] {
	if (!g.bool(0.3)) return [];
	return Array.from({ length: g.int(1, 6) }, (_, k) => {
		const n = g.pick(nodes);
		return {
			id: `lc${k}`,
			nodeId: n.id,
			coverClass: g.pick(LAND_COVER_CLASSES.map((c) => c.id)),
			areaKm2: g.bool(0.1) ? 0 : g.bool(0.1) ? n.areaKm2 * 3 + 1 : g.float(0, Math.max(n.areaKm2, 0.1)),
			densityPct: g.frac(0.1, 0.3),
			factors: g.bool(0.6) ? null : { mar: g.frac(0.2, 0.2), lowFlow: g.frac(0.2, 0.2) }
		};
	});
}

/**
 * Boreholes (WP-1.34) on farms and other users in 30 % of seeds: each node has
 * them half the time, with a capacity from a trickle to more than any demand,
 * any rule (drought on a dam-less node too, which runs as supplemental), a
 * trigger from 0 to 1, stream depletion none, some or all, with no lag, a
 * short one or one far longer than the run.
 */
function addBoreholes(g: Rng, nodes: NetworkNode[]): void {
	if (!g.bool(0.3)) return;
	for (const n of nodes) {
		if (n.kind === 'gauge' || !g.bool(0.5)) continue;
		n.boreholeCapacityM3Day = g.pick([0, g.logFloat(0.1, 1e3), g.logFloat(1, 1e6), 1e9]);
		n.boreholeRule = g.pick(['supplemental', 'primary', 'drought'] as const);
		n.boreholeTriggerPct = g.frac(0.1, 0.1);
		n.streamDepletionFrac = g.frac(0.25, 0.25);
		n.streamDepletionLagDays = g.pick([0, 0, g.float(0.1, 5), g.logFloat(1, 5000)]);
	}
}

/**
 * Dam storage (WP-3.5) in 30 % of seeds, on each farm dam half the time: a
 * survey curve (2–8 rows, from a flat pan to a steep gorge, its top row near
 * or off the capacity, sometimes starting above empty; now and then one the
 * run rejects), a release rule (pass inflow up to the EWR or a monthly amount,
 * or a fixed monthly release, from nothing to more than the dam holds) with or
 * without an outlet limit, and a seepage return share with the edges
 * over-weighted.
 */
function addDamStorage(g: Rng, nodes: NetworkNode[]): void {
	if (!g.bool(0.3)) return;
	for (const n of nodes) {
		if (n.kind !== 'farm' || !(n.damCapacityM3 > 0) || !g.bool(0.5)) continue;
		if (g.bool(0.6)) {
			const rows = g.int(2, 8);
			const top = n.damCapacityM3 * g.pick([1, 1, g.float(0.9, 1.1)]);
			const depth = g.logFloat(0.5, 30);
			const shape = g.float(0.3, 1.5);
			const start = g.bool(0.3) ? g.float(0, 0.3) : 0;
			n.damCurve = Array.from({ length: rows }, (_, k) => {
				const f = start + ((1 - start) * k) / (rows - 1);
				// Area ∝ volume^shape, scaled so the mean depth at the top is `depth`.
				return { levelM: 100 + depth * f, areaM2: (top / depth) * Math.pow(f, shape), volumeM3: top * f };
			});
			if (g.bool(0.05)) n.damCurve = n.damCurve.slice(0, 1);
		}
		const rule = g.pick(['none', 'passInflow', 'passInflow', 'fixed'] as const);
		n.damReleaseRule = rule;
		const scale = g.pick([0, 10, 1e3, n.damCapacityM3 / 30, n.damCapacityM3 * 2]);
		n.damReleaseM3Day = rule === 'passInflow' && g.bool(0.5) ? null : Array.from({ length: 12 }, () => (g.bool(0.2) ? 0 : g.float(0, scale)));
		n.damOutletCapacityM3Day = g.bool(0.5) ? null : g.pick([0, g.logFloat(1, 1e6)]);
		n.damSeepageReturnPct = g.frac(0.25, 0.25);
	}
}

/**
 * Supply rules and river pumps (WP-3.8) in 25 % of seeds, on each farm half
 * the time: any rule (trigger on a dam-less farm, and run of river on a farm
 * that keeps its dam, now and then, which the engine runs as river first), a
 * pump capacity of none, 0, a trickle or more than any flow, a trigger from 0
 * to 1 and a stop level usually above it (now and then below, which the
 * engine clamps). Run of river takes the dam away (capacity 0) most of the
 * time, as the backend requires; whatever else the seed gave that dam then
 * runs as on any dam-less farm.
 */
function addSupply(g: Rng, nodes: NetworkNode[]): void {
	if (!g.bool(0.25)) return;
	for (const n of nodes) {
		if (n.kind !== 'farm' || !g.bool(0.5)) continue;
		const rule = g.pick(['damFirst', 'riverFirst', 'riverFirst', 'trigger', 'trigger', 'runOfRiver', 'runOfRiver'] as const);
		n.supplyRule = rule;
		n.pumpCapacityM3Day = g.pick([null, 0, g.logFloat(0.1, 1e3), g.logFloat(1, 1e6)]);
		n.supplyTriggerPct = g.frac(0.1, 0.1);
		n.supplyStopPct = g.bool(0.9) ? g.float(n.supplyTriggerPct, 1) : g.frac();
		if (rule === 'runOfRiver' && g.bool(0.8)) n.damCapacityM3 = 0;
	}
}

/**
 * Hands-off flows and River to dam by month (engine ≥ 1.32.0, issue #204) in
 * 25 % of seeds, on each farm half the time: a hands-off flow by month (some
 * months 0, from a trickle to more than any flow, now and then 0 in every
 * month, which is none), the EWR kept or not, and River to dam by month (some
 * months off, winter-only now and then, from a trickle to more than any flow).
 * With or without a river pump (addSupply ran before), so both the pump and
 * the diversion meet the rule.
 */
function addOperating(g: Rng, nodes: NetworkNode[]): void {
	if (!g.bool(0.25)) return;
	for (const n of nodes) {
		if (n.kind !== 'farm' || !g.bool(0.5)) continue;
		if (g.bool(0.7)) {
			const scale = g.pick([0, g.logFloat(0.1, 1e3), g.logFloat(1, 1e5), 1e9]);
			n.handsOffM3Day = Array.from({ length: 12 }, () => (g.bool(0.2) ? 0 : g.float(0, scale)));
		}
		n.handsOffEwr = g.bool(0.4);
		if (g.bool(0.4)) {
			const scale = g.pick([g.logFloat(0.5, 1e5), 1e9]);
			// Winter only (April–September: water-year months 7–12) now and then, otherwise any months off.
			const winter = g.bool(0.3);
			n.divertMonthlyM3Day = Array.from({ length: 12 }, (_, k) => (winter ? (k >= 6 ? g.float(0, scale) : 0) : g.bool(0.2) ? 0 : g.float(0, scale)));
		}
	}
}

/**
 * Individual boreholes (WP-3.9) in 25 % of seeds: up to three per farm or
 * other user (now and then one on a gauge, which the engine skips), any mode
 * (emergency and dam-target on dam-less nodes too, which run as supplemental
 * and direct), capacities from a trickle to more than any demand, no annual
 * cap, a small one that binds within weeks or one that never does, any
 * depletion factor.
 */
function randomBoreholes(g: Rng, nodes: NetworkNode[]): Borehole[] {
	if (!g.bool(0.25)) return [];
	const out: Borehole[] = [];
	for (const n of nodes) {
		if ((n.kind === 'gauge' && !g.bool(0.05)) || !g.bool(0.5)) continue;
		const count = g.int(1, 3);
		for (let k = 0; k < count; k++) {
			const cap = g.pick([0, g.logFloat(0.1, 1e3), g.logFloat(1, 1e6), 1e9]);
			out.push({
				id: `bh-${n.id}-${k}`,
				nodeId: n.id,
				name: `Borehole ${n.id}.${k}`,
				capacityM3Day: cap,
				annualCapM3: g.pick([null, null, g.logFloat(1, 1e5), cap * g.float(1, 400), 0]),
				mode: g.pick(['none', 'supplemental', 'supplemental', 'primary', 'emergency'] as const),
				emergencyBelowPct: g.frac(0.1, 0.1),
				target: g.pick(['direct', 'direct', 'dam'] as const),
				depletionFactor: g.frac(0.25, 0.25)
			});
		}
	}
	return out;
}

/**
 * Registered volumes (engine ≥ 1.18.0, issue #72) in 25 % of seeds, with the
 * allocation mode drawn from none, cap and fullAllocation: on half the farms
 * and users (now and then one on a gauge, on a node that doesn't exist, or
 * unmatched, which the run leaves out), surface or groundwater, volumes from
 * nothing to more than any demand, open or with validity dates around the
 * run (one that ends before another starts, some outside it).
 */
function randomAllocations(g: Rng, nodes: NetworkNode[], settings: Partial<ProjectSettings>, start: number, days: number): AllocationEntry[] {
	if (!g.bool(0.25)) return [];
	settings.allocationMode = g.pick(['none', 'cap', 'cap', 'fullAllocation', 'fullAllocation'] as const);
	if (g.bool(0.3)) settings.allocationTolerance = g.frac(0.1, 0.1) * 0.99;
	const date = () => (g.bool(0.5) ? null : fromEpochDay(start + g.int(-400, days + 400)));
	const out: AllocationEntry[] = [];
	for (const n of nodes) {
		if ((n.kind === 'gauge' && !g.bool(0.05)) || !g.bool(0.5)) continue;
		const count = g.int(1, 3);
		for (let k = 0; k < count; k++) {
			let validFrom = date();
			let validTo = date();
			if (validFrom && validTo && validFrom > validTo) [validFrom, validTo] = [validTo, validFrom];
			out.push({
				id: `al-${n.id}-${k}`,
				nodeId: g.bool(0.05) ? null : g.bool(0.03) ? 'no-such-node' : n.id,
				waterSource: g.pick(['surface', 'surface', 'groundwater'] as const),
				volumeM3PerYear: g.pick([0, g.logFloat(1, 1e4), g.logFloat(1e3, 1e7), 1e10]),
				validFrom,
				validTo
			});
		}
	}
	return out;
}

/**
 * Licence conditions (engine ≥ 1.37.0, issue #72) on about a third of the
 * allocations: months of use (the summer or winter half, one month, or an
 * empty list, which states none) and a maximum rate from 0 to more than any
 * day's use.
 */
function addLicenceConditions(g: Rng, allocations: AllocationEntry[]): void {
	for (const a of allocations) {
		if (!g.bool(0.35)) continue;
		if (g.bool(0.6)) a.months = g.pick([[10, 11, 12, 1, 2, 3], [4, 5, 6, 7, 8, 9], [g.int(1, 12)], []]);
		if (g.bool(0.6)) a.maxRateM3s = g.pick([0, g.logFloat(1e-4, 1), 100]);
	}
}

/**
 * Demand objects (engine ≥ 1.7.0, docs/model.md §2.7f) in 25 % of seeds: up
 * to three on half the farms (now and then one on a gauge or user, or one
 * switched off, which the engine skips), monthly or per unit, from a trickle
 * to more than the river carries, months without any, losses, profiles, any
 * return share (0 when piped out), any priority class; half the monthly
 * ones with people, so a domestic or municipal one has a basic-needs floor
 * from under to over its demand (engine ≥ 1.44.0).
 */
function randomDemandObjects(g: Rng, nodes: NetworkNode[]): DemandObject[] {
	if (!g.bool(0.25)) return [];
	const out: DemandObject[] = [];
	for (const n of nodes) {
		if ((n.kind !== 'farm' && !g.bool(0.05)) || !g.bool(0.5)) continue;
		const count = g.int(1, 3);
		for (let k = 0; k < count; k++) {
			const perUnit = g.bool(0.4);
			const external = g.bool(0.2);
			const level = g.pick([0, g.logFloat(0.1, 1e3), g.logFloat(1, 1e5), 1e7]);
			out.push({
				id: `do-${n.id}-${k}`,
				nodeId: n.id,
				name: `Demand ${n.id}.${k}`,
				category: g.pick(['domestic', 'municipal', 'industrial', 'livestock', 'other'] as const),
				sizing: perUnit ? 'perUnit' : 'monthly',
				monthlyM3Day: perUnit ? null : Array.from({ length: 12 }, () => (g.bool(0.15) ? 0 : level * g.float(0.2, 2))),
				count: perUnit ? g.pick([0, g.int(1, 50_000)]) : null,
				litresPerUnitDay: perUnit ? g.float(5, 400) : null,
				lossPct: perUnit ? g.pick([0, g.float(0, 0.6)]) : 0,
				monthlyFactor: perUnit && g.bool(0.5) ? Array.from({ length: 12 }, () => g.float(0, 3)) : null,
				returnPct: external ? 0 : g.pick([0, 1, g.frac()]),
				priority: g.pick(['first', 'shared', 'last'] as const),
				destination: external ? 'external' : 'internal',
				enabled: g.bool(0.9),
				// The basic-needs floor (engine ≥ 1.44.0): a per-unit object's count sets it; every other
				// monthly one names people from its level, no draw, so the rest of the seed is unchanged.
				population: !perUnit && k % 2 === 0 ? Math.round(level * 40) : null,
				note: ''
			});
		}
	}
	return out;
}

/**
 * Development over the run (engine ≥ 1.30.0, ../network/development.ts) in
 * 20 % of seeds: on a farm dam, now and then a sediment rate with a survey
 * date anywhere from a run before the start to after the end, and an
 * in-service date inside the run; on a farm or water user, an abstraction
 * start before, inside or after the run.
 */
function addDevelopment(g: Rng, nodes: NetworkNode[], start: number, days: number): void {
	if (!g.bool(0.2)) return;
	const day = (lo: number, hi: number) => fromEpochDay(start + g.int(lo, hi));
	for (const n of nodes) {
		if (n.kind === 'farm' && n.damCapacityM3 > 0) {
			if (g.bool(0.4)) {
				n.damSedimentPctPerYear = g.pick([0, g.float(0, 0.05), g.float(0.05, 0.2)]);
				n.damSurveyDate = day(-days, days + 30);
			}
			if (g.bool(0.3)) n.damInServiceFrom = day(-30, days);
		}
		if (n.kind !== 'gauge' && g.bool(0.3)) n.abstractionFrom = day(-30, days + 30);
	}
}

/**
 * Schedules on half the demand objects (engine ≥ 1.17.0, docs/model.md
 * §2.7f): up to four windows each, of every span (every day, yearly spans
 * that wrap the year end or not, a one-off range in or around the run,
 * Easter), on some weekdays or all, with factors from off (0, over-weighted)
 * to a peak, overlapping at random, and now and then an empty schedule.
 */
function addSchedules(g: Rng, objects: DemandObject[], start: number, days: number): void {
	const md = () => `${String(g.int(1, 12)).padStart(2, '0')}-${String(g.int(1, 28)).padStart(2, '0')}`;
	for (const o of objects) {
		if (!g.bool(0.5)) continue;
		const n = g.int(0, 4);
		o.schedule = Array.from({ length: n }, (_, k) => {
			const span = g.pick(['always', 'yearly', 'range', 'easter'] as const);
			const a = start + g.int(-60, days + 60);
			const easterFrom = g.int(-10, 5);
			return {
				label: `w${k}`,
				span,
				from: span === 'yearly' ? md() : span === 'range' ? fromEpochDay(a) : null,
				to: span === 'yearly' ? md() : span === 'range' ? fromEpochDay(a + g.int(0, 90)) : null,
				easterFrom: span === 'easter' ? easterFrom : null,
				easterTo: span === 'easter' ? easterFrom + g.int(0, 6) : null,
				weekdays: g.bool(0.4) ? [...new Set(Array.from({ length: g.int(1, 5) }, () => g.int(1, 7)))].sort((x, y) => x - y) : null,
				factor: g.pick([0, 0, 1, g.float(0, 3)])
			};
		});
	}
}

/**
 * Up to three other water users (WP-1.33) in 30 % of seeds: each drains into
 * a random node, and half the time takes one of that node's upstream nodes
 * in-line above it. Demand from none to far more than the river carries,
 * months without any, no demand at all; any return share, the edges 0 and 1
 * over-weighted; senior or junior.
 */
function addUsers(g: Rng, nodes: NetworkNode[]): void {
	if (!g.bool(0.3)) return;
	const count = g.int(1, 3);
	for (let k = 0; k < count; k++) {
		const into = g.pick(nodes);
		const id = `u${k}`;
		if (g.bool(0.5)) {
			const ups = nodes.filter((x) => x.downstreamNodeId === into.id);
			if (ups.length) g.pick(ups).downstreamNodeId = id;
		}
		const scale = g.pick([0, 10, 1e3, 1e5, 1e7]);
		nodes.push({
			id,
			name: `User ${k}`,
			kind: 'user',
			downstreamNodeId: into.id,
			sortOrder: nodes.length,
			areaKm2: 0,
			areaHiKm2: 0,
			areaLoKm2: 0,
			flowShareManual: null,
			pctUpstreamToDam: 0,
			pctRunoffToDam: 0,
			damCapacityM3: 0,
			damInitialPct: 0,
			damMinPct: 0,
			divertCapacityM3Day: 0,
			irrigationEfficiency: 1,
			lossReturnFraction: 0,
			damAreaFullM2: null,
			damAreaExponent: 0.7,
			damSeepagePerDay: 0,
			userDemandM3Day: g.bool(0.1) ? null : Array.from({ length: 12 }, () => (g.bool(0.2) ? 0 : g.float(0, scale))),
			userReturnPct: g.frac(0.25, 0.25),
			userPriority: g.pick(['senior', 'senior', 'junior'] as const)
		});
	}
}

/**
 * A dam's evaporation and seepage parameters (audit N2): the area unknown
 * (estimated from the capacity), none, or anything from a pond to a lake far
 * bigger than its volume suggests; the exponent at its default, flat or
 * steep; no seepage, a little, or a leaky dam losing it all in a day.
 */
function damLossOps(g: Rng): Pick<NetworkNode, 'damAreaFullM2' | 'damAreaExponent' | 'damSeepagePerDay'> {
	return {
		damAreaFullM2: g.pick([null, null, 0, g.logFloat(1, 1e6)]),
		damAreaExponent: g.pick([0.7, 0.7, 3, g.float(0.05, 3)]),
		damSeepagePerDay: g.pick([0, 0, 1, g.logFloat(1e-5, 0.2)])
	};
}

/**
 * A farm's irrigation efficiency and loss return (audit N1). Half the time the
 * migration 006 mapping of the pre-0.15 return flow `r` the main generator
 * drew (so e = 1 − r, β = 1, and r = 1 gives e = 0.01); otherwise drawn
 * directly, with the edges e = 1 and β = 0 or 1 over-weighted.
 */
function irrigationOps(g: Rng, r: number): Pick<NetworkNode, 'irrigationEfficiency' | 'lossReturnFraction'> {
	if (g.bool(0.5)) return irrigationFromReturnFlow(r);
	return {
		irrigationEfficiency: g.bool(0.2) ? 1 : g.bool(0.05) ? g.float(0.01, 0.1) : g.float(0.5, 1),
		lossReturnFraction: g.frac(0.25, 0.25)
	};
}

/** The rain threshold and catchment area: mostly the defaults, sometimes pushed around. */
function defaultCalibrationOverrides(rng: Rng): Partial<ProjectSettings['calibration']> {
	if (rng.bool(0.5)) return {};
	// The legacy runoff model's parameters (removed in engine 1.0.0) are still
	// drawn and dropped, so every seed keeps the network and series it had.
	rng.logFloat(0.001, 1);
	rng.float(0.5, 2);
	const rainThresholdMm = rng.pick([0, 2, 5]);
	rng.frac(0.1, 0.1);
	rng.frac(0.1, 0.3);
	Array.from({ length: rng.int(0, 8) }, () => rng.int(1, 12));
	rng.pick([0, 300, 1e5]);
	return { rainThresholdMm, ...(rng.bool(0.1) ? { catchmentAreaKm2: rng.logFloat(0.1, 1000) } : {}) };
}

/** Deep copy (inputs are plain JSON). */
export function cloneInput(input: ModelInput): ModelInput {
	return JSON.parse(JSON.stringify(input)) as ModelInput;
}

/**
 * The same model with every display order scrambled: node array order and
 * sortOrder, crop order and sortOrder, crop-area and transfer order.
 */
export function scrambleOrder(input: ModelInput, seed: number): ModelInput {
	const rng = new Rng(seed);
	const x = cloneInput(input);
	const m = x.model;
	rng.shuffle(m.nodes);
	for (const nd of m.nodes) nd.sortOrder = rng.int(-100, 100);
	rng.shuffle(m.crops);
	m.crops.forEach((c) => (c.sortOrder = rng.int(-100, 100)));
	rng.shuffle(m.cropAreas);
	rng.shuffle(m.transfers);
	// Rule tables (engine ≥ 0.21.0) are assessed outlet first, then by site id, whatever their order.
	if (Array.isArray(x.settings.ewrRules)) rng.shuffle(x.settings.ewrRules);
	if (m.landCover) rng.shuffle(m.landCover);
	if (m.boreholes) rng.shuffle(m.boreholes);
	if (m.allocations) rng.shuffle(m.allocations);
	if (m.demandObjects) rng.shuffle(m.demandObjects);
	return x;
}

/**
 * Candidate smaller inputs for shrinking a failure: drop a transfer, a crop,
 * a leaf node (re-pointing nothing: leaves have no upstream), crop areas, or
 * cut the run in half.
 */
export function* shrinkCandidates(input: ModelInput): Generator<ModelInput> {
	const m = input.model;
	for (let k = 0; k < m.transfers.length; k++) {
		const x = cloneInput(input);
		x.model.transfers.splice(k, 1);
		yield x;
	}
	for (let k = 0; k < (m.landCover?.length ?? 0); k++) {
		const x = cloneInput(input);
		x.model.landCover!.splice(k, 1);
		yield x;
	}
	for (let k = 0; k < (m.allocations?.length ?? 0); k++) {
		const x = cloneInput(input);
		x.model.allocations!.splice(k, 1);
		yield x;
	}
	for (let k = 0; k < (m.boreholes?.length ?? 0); k++) {
		const x = cloneInput(input);
		x.model.boreholes!.splice(k, 1);
		yield x;
	}
	for (let k = 0; k < (m.demandObjects?.length ?? 0); k++) {
		const x = cloneInput(input);
		x.model.demandObjects!.splice(k, 1);
		yield x;
	}
	const hasUpstream = new Set(m.nodes.map((nd) => nd.downstreamNodeId).filter((v): v is string => v !== null));
	for (const nd of m.nodes) {
		if (hasUpstream.has(nd.id) || nd.downstreamNodeId === null) continue;
		const x = cloneInput(input);
		x.model.nodes = x.model.nodes.filter((y) => y.id !== nd.id);
		x.model.cropAreas = x.model.cropAreas.filter((a) => a.nodeId !== nd.id);
		x.model.transfers = x.model.transfers.filter((t) => t.fromNodeId !== nd.id && t.toNodeId !== nd.id);
		yield x;
	}
	// Splice out a node with exactly one upstream node: its upstream drains past it.
	for (const nd of m.nodes) {
		const ups = m.nodes.filter((y) => y.downstreamNodeId === nd.id);
		if (ups.length !== 1 || nd.downstreamNodeId === null) continue;
		const x = cloneInput(input);
		x.model.nodes = x.model.nodes.filter((y) => y.id !== nd.id);
		x.model.nodes.find((y) => y.id === ups[0]!.id)!.downstreamNodeId = nd.downstreamNodeId;
		x.model.cropAreas = x.model.cropAreas.filter((a) => a.nodeId !== nd.id);
		x.model.transfers = x.model.transfers.filter((t) => t.fromNodeId !== nd.id && t.toNodeId !== nd.id);
		yield x;
	}
	for (let c = 0; c < m.crops.length; c++) {
		const x = cloneInput(input);
		const [gone] = x.model.crops.splice(c, 1);
		x.model.cropAreas = x.model.cropAreas.filter((a) => a.cropId !== gone!.id);
		yield x;
	}
	// Shorten every series (and drop the explicit windows, which may then point outside).
	const longest = Math.max(0, ...Object.values(input.series).map((s) => s?.values.length ?? 0));
	if (longest > 1) {
		for (const keep of [Math.ceil(longest / 2), longest - 1]) {
			const x = cloneInput(input);
			for (const s of Object.values(x.series)) if (s) s.values = s.values.slice(0, keep);
			for (const k of ['simulationStart', 'simulationEnd'] as const) delete x.settings[k];
			yield x;
			const y = cloneInput(input);
			for (const s of Object.values(y.series)) {
				if (!s) continue;
				const drop = Math.max(0, s.values.length - keep);
				s.values = s.values.slice(drop);
				s.startDate = fromEpochDay(toEpochDay(s.startDate) + drop);
			}
			for (const k of ['simulationStart', 'simulationEnd'] as const) delete y.settings[k];
			yield y;
		}
	}
	for (const kind of Object.keys(input.series) as SeriesKind[]) {
		const x = cloneInput(input);
		delete x.series[kind];
		yield x;
	}
}

/**
 * Greedy shrink: keep taking the first smaller candidate that still fails,
 * until none does (or the step budget runs out).
 */
export function shrink(input: ModelInput, fails: (x: ModelInput) => boolean, maxSteps = 400): ModelInput {
	let cur = input;
	for (let step = 0; step < maxSteps; step++) {
		let next: ModelInput | null = null;
		for (const cand of shrinkCandidates(cur)) {
			let bad = false;
			try {
				bad = fails(cand);
			} catch {
				bad = false;
			}
			if (bad) {
				next = cand;
				break;
			}
		}
		if (!next) break;
		cur = next;
	}
	return cur;
}
