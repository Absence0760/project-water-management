// Seeded random generator of valid ModelInputs, for the invariant (property)
// tests in *.invariants.test.ts. "Valid" = passes the backend's validation
// (backend/src/model/validate.ts): one outflow node, no cycles, fractions in
// 0–1, non-negative volumes, transfers between distinct existing nodes.
//
// The generator deliberately over-weights edge values (0 and 1 fractions, empty
// dams, zero areas, huge storms, long dry spells, missing days, leap days, runs
// that start and end mid water-year) because that is where balance bugs hide.
// Everything is a pure function of the seed: a failing seed reproduces exactly.
import { irrigationFromReturnFlow, type CropArea, type CropDef, type DailySeries, type ModelInput, type NetworkNode, type ProjectSettings, type SeriesKind, type Transfer } from '../project';
import { fromEpochDay, toEpochDay, type Monthly } from '../calendar';
import { Rng } from '../random';
import { GR4J_PARAMS } from '../runoff/gr4j';
import type { RunoffModelId } from '../runoff/types';

export { Rng };

type Shape = 'chain' | 'fan' | 'random' | 'binary' | 'twoBranches';

export interface GenOptions {
	maxNodes?: number;
	maxDays?: number;
	/**
	 * Runoff model of the generated project (default legacy). A conceptual
	 * model draws its parameters from a second generator, so a seed's network
	 * and series are the same whichever model runs them.
	 */
	runoffModel?: RunoffModelId;
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
export function randomInput(seed: number, opts: GenOptions = {}): ModelInput {
	const rng = new Rng(seed);
	// Irrigation efficiency and loss return (engine ≥ 0.16.0) come from their own
	// generator, so the rest of a seed's network is what it was before them.
	const ops = new Rng(seed ^ 0x2c1b3c6d);
	// Dam evaporation and seepage (N2) likewise.
	const dl = new Rng(seed ^ 0x6a09e667);
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
			enabled: rng.bool(0.9)
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
		hiLoSplit: rng.bool(0.7) ? { hi: 0.81, lo: 0.19 } : { hi: rng.frac(), lo: rng.frac() },
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
	if (opts.runoffModel === 'gr4j') {
		const g = new Rng(seed ^ 0x5bd1e995);
		const p = Object.fromEntries(
			GR4J_PARAMS.map((s) => [s.key, s.fixedByDefault ? (g.bool(0.25) ? g.float(s.min, s.max) : s.default) : g.bool(0.1) ? g.pick([s.min, s.max]) : g.logFloat(Math.max(s.min, 1e-3), s.max)])
		) as Record<string, number>;
		settings.runoffModel = 'gr4j';
		settings.gr4j = { x1: p.x1!, x2: p.x2!, x3: p.x3!, x4: p.x4!, warmupDays: g.pick([0, 0, 30, 365, 365, 1000]) };
		settings.panCoefficient = g.bool(0.5) ? monthly(() => 0.7) : monthly(() => (g.bool(0.1) ? 0 : g.float(0.3, 1.2)));
	} else {
		// Explicit, so a change of the engine's default doesn't change what a seed runs.
		settings.runoffModel = 'legacy';
	}
	// The soil-water store (N3): none, the default, anything, or practically
	// endless. From its own stream, so a seed still builds the same network.
	const sw = new Rng(seed ^ 0x2545f491);
	settings.effectiveRainStoreMm = sw.pick([0, 25, 25, sw.float(0, 200), 1e6]);
	// Dam evaporation (N2): the default, none, anything up to well above an open-water factor.
	settings.lakeEvapFactor = dl.pick([0.75, 0.75, 0, dl.float(0, 2)]);

	return { settings, model: { nodes, crops, cropAreas, transfers }, series };
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

/** Rain-model parameters: mostly the defaults, sometimes pushed around. */
function defaultCalibrationOverrides(rng: Rng): Partial<ProjectSettings['calibration']> {
	if (rng.bool(0.5)) return {};
	return {
		a: rng.logFloat(0.001, 1),
		b: rng.float(0.5, 2),
		rainThresholdMm: rng.pick([0, 2, 5]),
		summerFactor: rng.frac(0.1, 0.1),
		winterFactor: rng.frac(0.1, 0.3),
		summerMonths: [...new Set(Array.from({ length: rng.int(0, 8) }, () => rng.int(1, 12)))],
		baseFlowInitial: rng.pick([0, 300, 1e5]),
		...(rng.bool(0.1) ? { catchmentAreaKm2: rng.logFloat(0.1, 1000) } : {})
	};
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
