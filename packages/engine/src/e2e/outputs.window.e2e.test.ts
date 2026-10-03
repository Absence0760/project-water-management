// End-to-end: the run's summaries (docs/model.md §2.8, §2.11, §2.11a, §2.11b)
// against the daily series they summarise, over exactly the reporting
// window. Every figure below is worked from docs/model.md's definitions over
// the run's own daily series, never from the engine's summary code.
// Synthetic catchments only (the repo is public).
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import { runModel } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { randomInput } from '../testing';

function series(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}

function maybeSeries(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] | null {
	return out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values ?? null;
}

const sum = (a: ArrayLike<number>, from = 0, to = a.length - 1): number => {
	let v = 0;
	for (let t = from; t <= to; t++) v += a[t]!;
	return v;
};

const mean = (a: ArrayLike<number>, from: number, to: number): number => sum(a, from, to) / (to - from + 1);

/** |a − b| within rel × max(|a|, |b|, floor). */
function close(a: number | null | undefined, b: number | null | undefined, rel = 1e-9, floor = 1e-9): boolean {
	if (a === null || a === undefined || b === null || b === undefined) return a === b || (a == null && b == null);
	return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), floor);
}

/** Water-year month index 0 = Oct … 11 = Sep of an epoch day. */
function wyMonth(epochDay: number): number {
	const m = new Date(epochDay * 86_400_000).getUTCMonth() + 1; // 1–12
	return (m + 2) % 12;
}

const wyLength = (wy: number) => (Date.UTC(wy + 1, 9, 1) - Date.UTC(wy, 9, 1)) / 86_400_000;

/** The reporting window as day indices, by §2.11's rules (null = run's own end, clipped, no overlap = whole run). */
function handWindow(out: ModelOutput, reportStart: string | null, reportEnd: string | null): { from: number; to: number } {
	const s = toEpochDay(out.startDate);
	const e = s + out.days - 1;
	let a = reportStart ? toEpochDay(reportStart) : s;
	let b = reportEnd ? toEpochDay(reportEnd) : e;
	if (b < a || b < s || a > e) return { from: 0, to: out.days - 1 };
	a = Math.max(a, s);
	b = Math.min(b, e);
	return { from: a - s, to: b - s };
}

interface HandReliability {
	demandM3: number;
	suppliedM3: number;
	demandDays: number;
	metDays: number;
	timeReliability: number | null;
	volumetricReliability: number | null;
	waterYears: number;
	partWaterYears: number;
	waterYearsMet: number;
	annualReliability: number | null;
	failureRuns: number;
	meanFailureDays: number | null;
	longestFailureDays: number;
	meanFailureDeficitM3: number | null;
	maxFailureDeficitM3: number;
	monthDemandDays: number[];
	monthMetDays: number[];
}

/** §2.11a reliability measures, written from the table in the doc. */
function handReliability(startDate: string, demand: ArrayLike<number>, supplied: ArrayLike<number>, from: number, to: number, threshold: number): HandReliability {
	const d0 = toEpochDay(startDate);
	let D = 0;
	let G = 0;
	let demandDays = 0;
	let metDays = 0;
	const runs: { len: number; def: number }[] = [];
	let cur: { len: number; def: number } | null = null;
	const years = new Map<number, { D: number; G: number; days: number }>();
	const monthDemandDays = new Array(12).fill(0);
	const monthMetDays = new Array(12).fill(0);
	for (let t = from; t <= to; t++) {
		const d = demand[t]!;
		const g = supplied[t]!;
		D += d;
		G += g;
		const wy = waterYearOf(d0 + t);
		const y = years.get(wy) ?? { D: 0, G: 0, days: 0 };
		y.D += d;
		y.G += g;
		y.days++;
		years.set(wy, y);
		const fully = d - g <= 1e-9 * d;
		if (d > 0) {
			demandDays++;
			monthDemandDays[wyMonth(d0 + t)]++;
			if (fully) monthMetDays[wyMonth(d0 + t)]++;
			if (fully) metDays++;
		}
		if (d > 0 && !fully) {
			cur ??= { len: 0, def: 0 };
			cur.len++;
			cur.def += d - g;
		} else if (cur) {
			runs.push(cur);
			cur = null;
		}
	}
	if (cur) runs.push(cur);
	let wyc = 0;
	let wyMet = 0;
	let wyPart = 0;
	for (const [wy, y] of years) {
		if (!(y.D > 0)) continue;
		if (y.days < wyLength(wy)) {
			wyPart++;
			continue;
		}
		wyc++;
		if (y.G / y.D >= threshold) wyMet++;
	}
	return {
		demandM3: D,
		suppliedM3: G,
		demandDays,
		metDays,
		timeReliability: demandDays ? metDays / demandDays : null,
		volumetricReliability: D > 0 ? G / D : null,
		waterYears: wyc,
		partWaterYears: wyPart,
		waterYearsMet: wyMet,
		annualReliability: wyc ? wyMet / wyc : null,
		failureRuns: runs.length,
		meanFailureDays: runs.length ? runs.reduce((a, r) => a + r.len, 0) / runs.length : null,
		longestFailureDays: runs.reduce((a, r) => Math.max(a, r.len), 0),
		meanFailureDeficitM3: runs.length ? runs.reduce((a, r) => a + r.def, 0) / runs.length : null,
		maxFailureDeficitM3: runs.reduce((a, r) => Math.max(a, r.def), 0),
		monthDemandDays,
		monthMetDays
	};
}

/** The stress class of a supply ratio, §2.11a's thresholds. */
function handStressClass(r: number | null): string | null {
	if (r === null) return null;
	if (r >= 0.95) return 'low';
	if (r >= 0.85) return 'moderate';
	if (r >= 0.7) return 'high';
	if (r >= 0.5) return 'severe';
	return 'critical';
}

interface HandCurtailmentFarm {
	H: number;
	I: number;
	J: number;
	K: number | null;
	M: number;
	N: number;
	O: number;
	P: number | null;
	R: number;
	Rirr: number;
	cut: number;
	S: number;
	U: number;
	V: number | null;
	beyond: number;
}

/** §2.11's columns, written from the cell formulas (no basic-needs floor). */
function handCurtailment(input: ModelInput, out: ModelOutput, from: number, to: number): { Ktot: number | null; farms: Map<string, HandCurtailmentFarm> } {
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const base = new Map<string, { H: number; I: number; R: number; Rirr: number; node: NetworkNode }>();
	for (const n of farms) {
		const H = mean(series(out, n.id, 'demand'), from, to);
		const I = mean(series(out, n.id, 'supplied'), from, to);
		const ch = maybeSeries(out, n.id, 'ewr_charge');
		const chi = maybeSeries(out, n.id, 'ewr_charge_irrigation');
		base.set(n.id, { H, I, R: ch ? mean(ch, from, to) : 0, Rirr: chi ? mean(chi, from, to) : 0, node: n });
	}
	const sH = [...base.values()].reduce((a, b) => a + b.H, 0);
	const sI = [...base.values()].reduce((a, b) => a + b.I, 0);
	// ΣI ÷ ΣH has no value without demand.
	const Ktot = sH > 0 ? sI / sH : null;
	const res = new Map<string, HandCurtailmentFarm>();
	for (const [id, b] of base) {
		const e = b.node.irrigationEfficiency ?? 1;
		const beta = b.node.lossReturnFraction ?? 0;
		const M = b.H * (Ktot ?? 0);
		const N = M - b.I;
		const cut = b.H > 0 ? b.Rirr / (1 - beta * (1 - e)) : 0;
		const U = Math.max(M + cut, 0);
		res.set(id, {
			H: b.H,
			I: b.I,
			J: b.I - b.H,
			K: b.H === 0 ? null : b.I / b.H,
			M,
			N,
			O: N / 86.4,
			P: b.H === 0 ? null : M / b.H,
			R: b.R,
			Rirr: b.Rirr,
			cut,
			S: N + cut,
			U,
			V: b.H === 0 ? null : U / b.H,
			beyond: Math.max(-cut - M, 0)
		});
	}
	return { Ktot, farms: res };
}

const day = (startDate: string, t: number) => fromEpochDay(toEpochDay(startDate) + t);

// ---------------------------------------------------------------------------

const THRESHOLD = 0.9;

function withWindow(input: ModelInput, reportStart: string | null, reportEnd: string | null, extra: Record<string, unknown> = {}): ModelInput {
	return { ...input, settings: { ...input.settings, reportStart, reportEnd, ...extra } };
}

function expectClose(actual: number | null | undefined, expected: number | null | undefined, what: string, rel = 1e-9, floor = 1e-6) {
	if (!close(actual, expected, rel, floor)) throw new Error(`${what}: engine ${actual}, by hand ${expected}`);
}

/** Every curtailment column and the window's dates against §2.11's formulas. */
function checkCurtailment(input: ModelInput, out: ModelOutput, from: number, to: number) {
	const c = out.summary.curtailment!;
	expect(c.reportStart).toBe(day(out.startDate, from));
	expect(c.reportEnd).toBe(day(out.startDate, to));
	expect(c.days).toBe(to - from + 1);
	const hand = handCurtailment(input, out, from, to);
	expectClose(c.equitableFraction, hand.Ktot, 'K_tot');
	const farmIds = input.model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
	expect(c.farms.map((f) => f.nodeId)).toEqual(farmIds);
	const tot = { H: 0, I: 0, M: 0, N: 0, R: 0, S: 0, U: 0 };
	for (const f of c.farms) {
		const h = hand.farms.get(f.nodeId)!;
		const w = `${f.nodeId} ${c.reportStart}…${c.reportEnd}`;
		expectClose(f.demandM3Day, h.H, `${w} H`);
		expectClose(f.suppliedM3Day, h.I, `${w} I`);
		expectClose(f.deficitM3Day, h.J, `${w} J`);
		if (h.K === null) expect(f.fractionSupplied ?? null).toBeNull();
		else expectClose(f.fractionSupplied, h.K, `${w} K`);
		expectClose(f.targetM3Day, h.M, `${w} M`);
		expectClose(f.reduceGainM3Day, h.N, `${w} N`, 1e-9, 1e-6 * Math.max(1, h.H));
		expectClose(f.reduceGainLs, h.O, `${w} O`, 1e-9, 1e-6 * Math.max(1, h.H));
		if (h.P === null) expect(f.targetFraction ?? null).toBeNull();
		else expectClose(f.targetFraction, h.P, `${w} P`);
		expectClose(f.ewrShortfallM3Day, h.R, `${w} R`);
		expectClose(f.ewrChargeIrrigationM3Day, h.Rirr, `${w} R_irr`);
		expectClose(f.ewrChargeStorageM3Day, h.R - h.Rirr, `${w} R_store`);
		expectClose(f.ewrSupplyCutM3Day, h.cut, `${w} supply cut`);
		expectClose(f.ewrSupplyCutLs, h.cut / 86.4, `${w} supply cut l/s`);
		expectClose(f.totalChangeM3Day, h.S, `${w} S`, 1e-9, 1e-6 * Math.max(1, h.H));
		expectClose(f.totalChangeLs, h.S / 86.4, `${w} T`, 1e-9, 1e-6 * Math.max(1, h.H));
		expectClose(f.volumeLeftM3Day, h.U, `${w} U`);
		if (h.V === null) expect(f.fractionOfDemandLeft ?? null).toBeNull();
		else expectClose(f.fractionOfDemandLeft, h.V, `${w} V`);
		expectClose(f.ewrCutBeyondShareM3Day, h.beyond, `${w} beyond share`);
		tot.H += h.H;
		tot.I += h.I;
		tot.M += h.M;
		tot.N += h.N;
		tot.R += h.R;
		tot.S += h.S;
		tot.U += h.U;
	}
	expectClose(c.totals.demandM3Day, tot.H, 'ΣH');
	expectClose(c.totals.suppliedM3Day, tot.I, 'ΣI');
	expectClose(c.totals.targetM3Day, tot.M, 'ΣM');
	// N redistributes: Σ N = 0 up to float noise.
	expect(Math.abs(c.totals.reduceGainM3Day)).toBeLessThanOrEqual(1e-9 * Math.max(1, tot.H));
	expectClose(c.totals.ewrShortfallM3Day, tot.R, 'ΣR');
	expectClose(c.totals.totalChangeM3Day, tot.S, 'ΣS', 1e-9, 1e-6 * Math.max(1, tot.H));
	expectClose(c.totals.volumeLeftM3Day, tot.U, 'ΣU');
	// The outlet's EWR site over the same window: days not met and the mean shortfall.
	const outlet = c.ewrSites!.find((s) => s.isOutlet)!;
	const sh = series(out, null, 'ewr_shortfall');
	let notMet = 0;
	for (let t = from; t <= to; t++) if (sh[t]! < 0) notMet++;
	expect(outlet.daysNotMet).toBe(notMet);
	expectClose(outlet.shortfallM3Day, mean(sh, from, to), 'outlet shortfall');
	expectClose(outlet.chargedM3Day + outlet.naturalM3Day, outlet.shortfallM3Day, 'charged + natural = shortfall');
}

function checkReliability(input: ModelInput, out: ModelOutput, from: number, to: number, threshold: number) {
	const sa = out.summary.supplyAssurance!;
	expect(sa.reportStart).toBe(day(out.startDate, from));
	expect(sa.reportEnd).toBe(day(out.startDate, to));
	expect(sa.days).toBe(to - from + 1);
	expect(sa.annualThreshold).toBe(threshold);
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	expect(sa.reliability.map((r) => r.nodeId)).toEqual(farms.map((f) => f.id));
	for (const r of sa.reliability) {
		const h = handReliability(out.startDate, series(out, r.nodeId, 'demand'), series(out, r.nodeId, 'supplied'), from, to, threshold);
		const w = `${r.nodeId} ${sa.reportStart}…${sa.reportEnd}`;
		expectClose(r.demandM3, h.demandM3, `${w} ΣD`);
		expectClose(r.suppliedM3, h.suppliedM3, `${w} ΣG`);
		expect(r.demandDays, `${w} demand days`).toBe(h.demandDays);
		expect(r.metDays, `${w} met days`).toBe(h.metDays);
		expectClose(r.timeReliability, h.timeReliability, `${w} time`);
		expectClose(r.volumetricReliability, h.volumetricReliability, `${w} volumetric`);
		expect(r.waterYears, `${w} complete water years`).toBe(h.waterYears);
		expect(r.partWaterYears, `${w} part water years`).toBe(h.partWaterYears);
		expect(r.waterYearsMet, `${w} years met`).toBe(h.waterYearsMet);
		expectClose(r.annualReliability, h.annualReliability, `${w} annual`);
		expect(r.failureRuns, `${w} failure runs`).toBe(h.failureRuns);
		expectClose(r.meanFailureDays, h.meanFailureDays, `${w} mean failure days`);
		expect(r.longestFailureDays).toBe(h.longestFailureDays);
		expectClose(r.meanFailureDeficitM3, h.meanFailureDeficitM3, `${w} mean failure deficit`);
		expectClose(r.maxFailureDeficitM3, h.maxFailureDeficitM3, `${w} max failure deficit`);
		expect(r.months.map((m) => m.demandDays)).toEqual(h.monthDemandDays);
		expect(r.months.map((m) => m.metDays)).toEqual(h.monthMetDays);
		// Volumetric = the curtailment table's I ÷ H for the same farm (§2.11a invariant).
		const cf = out.summary.curtailment!.farms.find((f) => f.nodeId === r.nodeId)!;
		if (cf.demandM3Day > 0) expectClose(r.volumetricReliability, cf.suppliedM3Day / cf.demandM3Day, `${w} volumetric = I/H`);
	}
}

/** Stress grid over the whole run (not the window), per water-year month. */
function checkStress(input: ModelInput, out: ModelOutput) {
	const st = out.summary.supplyAssurance!.stress;
	const d0 = toEpochDay(out.startDate);
	const wy0 = waterYearOf(d0);
	const wyN = waterYearOf(d0 + out.days - 1);
	expect(st.waterYears).toEqual(Array.from({ length: wyN - wy0 + 1 }, (_, i) => wy0 + i));
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const cells = () => Array.from({ length: wyN - wy0 + 1 }, () => new Array(12).fill(0) as number[]);
	const days = cells();
	const sysD = cells();
	const sysG = cells();
	for (let t = 0; t < out.days; t++) days[waterYearOf(d0 + t) - wy0]![wyMonth(d0 + t)]!++;
	expect(st.days).toEqual(days);
	for (const f of farms) {
		const D = cells();
		const G = cells();
		const dem = series(out, f.id, 'demand');
		const sup = series(out, f.id, 'supplied');
		for (let t = 0; t < out.days; t++) {
			const r = waterYearOf(d0 + t) - wy0;
			const c = wyMonth(d0 + t);
			D[r]![c]! += dem[t]!;
			G[r]![c]! += sup[t]!;
			sysD[r]![c]! += dem[t]!;
			sysG[r]![c]! += sup[t]!;
		}
		const grid = st.nodes.find((n) => n.nodeId === f.id)!;
		for (let r = 0; r < D.length; r++)
			for (let c = 0; c < 12; c++) {
				const ratio = D[r]![c]! > 0 ? G[r]![c]! / D[r]![c]! : null;
				expectClose(grid.ratio[r]![c], ratio, `${f.id} stress ratio ${wy0 + r}/${c}`);
				expect(grid.stressClass[r]![c]).toBe(handStressClass(grid.ratio[r]![c]!));
			}
	}
	for (let r = 0; r < sysD.length; r++)
		for (let c = 0; c < 12; c++) expectClose(st.system.ratio[r]![c], sysD[r]![c]! > 0 ? sysG[r]![c]! / sysD[r]![c]! : null, `system ratio ${wy0 + r}/${c}`);
}

/** Water-account rows: one per water year the run touches, then the run. */
function checkWaterAccount(input: ModelInput, out: ModelOutput) {
	const wa = out.summary.supplyAssurance!.waterAccount;
	const d0 = toEpochDay(out.startDate);
	const nat = series(out, null, 'natural_flow');
	const outflow = series(out, null, 'simulated_outflow');
	const ewr = series(out, null, 'ewr');
	const sh = series(out, null, 'ewr_shortfall');
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const initial = farms.reduce((a, f) => a + f.damCapacityM3 * f.damInitialPct, 0);
	const storageEnd = (t: number) => (t < 0 ? initial : farms.reduce((a, f) => a + (maybeSeries(out, f.id, 'dam_storage')?.[t] ?? 0), 0));
	const spans: { wy: number | null; from: number; to: number }[] = [];
	for (let t = 0; t < out.days; t++) {
		const wy = waterYearOf(d0 + t);
		const last = spans.at(-1);
		if (last && last.wy === wy) last.to = t;
		else spans.push({ wy, from: t, to: t });
	}
	expect(wa.years.map((y) => [y.waterYear, y.days])).toEqual(spans.map((s) => [s.wy, s.to - s.from + 1]));
	spans.push({ wy: null, from: 0, to: out.days - 1 });
	const rows = [...wa.years, wa.total];
	spans.forEach((s, i) => {
		const row = rows[i]!;
		const w = `account ${s.wy ?? 'run'}`;
		expectClose(row.naturalFlowM3, sum(nat, s.from, s.to), `${w} natural`);
		expectClose(row.outflowM3, sum(outflow, s.from, s.to), `${w} outflow`);
		let supplied = 0;
		let returned = 0;
		let runoff = 0;
		let evap = 0;
		let rainOnDam = 0;
		for (const f of farms) {
			supplied += sum(series(out, f.id, 'supplied'), s.from, s.to);
			returned += sum(series(out, f.id, 'return_flow'), s.from, s.to);
			runoff += sum(series(out, f.id, 'runoff'), s.from, s.to);
			evap += sum(maybeSeries(out, f.id, 'dam_evaporation') ?? [], s.from, s.to);
			rainOnDam += sum(maybeSeries(out, f.id, 'rain_on_dam') ?? [], s.from, s.to);
		}
		expectClose(row.irrigationSuppliedM3, supplied, `${w} supplied`);
		expectClose(row.consumptiveIrrigationM3, supplied - returned, `${w} consumptive`);
		expectClose(row.unallocatedM3, sum(nat, s.from, s.to) - runoff - row.landCoverM3, `${w} unallocated`, 1e-9, 1e-6 * Math.max(1, row.scaleM3));
		expectClose(row.damEvaporationM3, evap, `${w} evaporation`);
		expectClose(row.rainOnDamsM3, rainOnDam, `${w} rain on dams`);
		expectClose(row.openingStorageM3, storageEnd(s.from - 1), `${w} opening`);
		expectClose(row.closingStorageM3, storageEnd(s.to), `${w} closing`);
		// Closure, from the series alone (no land cover, users, boreholes or seepage in these catchments).
		const inM3 = sum(nat, s.from, s.to) + rainOnDam;
		const outM3 = sum(nat, s.from, s.to) - runoff + (supplied - returned) + evap + sum(outflow, s.from, s.to);
		const resid = inM3 - outM3 - (storageEnd(s.to) - storageEnd(s.from - 1));
		expect(Math.abs(resid), `${w} closure`).toBeLessThanOrEqual(1e-9 * row.scaleM3);
		expect(Math.abs(row.residualM3)).toBeLessThanOrEqual(1e-10 * row.scaleM3);
		// EWR at the outlet: Σ requirement, Σ MIN(flow, requirement), days short.
		const site = row.ewr.find((e) => e.nodeId === null)!;
		let met = 0;
		let short = 0;
		for (let t = s.from; t <= s.to; t++) {
			met += Math.min(outflow[t]!, ewr[t]!);
			if (sh[t]! < 0) short++;
		}
		expectClose(site.requiredM3, sum(ewr, s.from, s.to), `${w} EWR required`);
		expectClose(site.metM3, met, `${w} EWR met = Σ MIN(flow, requirement)`, 1e-9, 1e-6 * Math.max(1, site.requiredM3));
		expect(site.daysNotMet, `${w} EWR days short`).toBe(short);
	});
}

/** FarmSummary keeps the whole-run averages whatever the window (§2.8). */
function checkFarmSummary(input: ModelInput, out: ModelOutput) {
	for (const f of out.summary.farms) {
		expectClose(f.avgDemandM3Day, mean(series(out, f.nodeId, 'demand'), 0, out.days - 1), `${f.nodeId} avg demand (whole run)`);
		expectClose(f.avgSuppliedM3Day, mean(series(out, f.nodeId, 'supplied'), 0, out.days - 1), `${f.nodeId} avg supplied (whole run)`);
	}
	expectClose(out.summary.catchment.meanNaturalFlowM3Day, mean(series(out, null, 'natural_flow'), 0, out.days - 1), 'mean natural flow');
	expectClose(out.summary.catchment.meanSimulatedOutflowM3Day, mean(series(out, null, 'simulated_outflow'), 0, out.days - 1), 'mean outflow');
	const sh = series(out, null, 'ewr_shortfall');
	const notMet = sh.filter((v) => v < 0).length;
	expect(out.summary.catchment.ewrDaysNotMet).toBe(notMet);
	expectClose(out.summary.catchment.ewrFractionDaysNotMet, notMet / out.days, 'EWR fraction of days not met');
	void input;
}

// Five complete water years (two 29 Februaries: 2004 and 2008).
const BASE = testCatchment({ start: '2003-10-01', end: '2008-09-30', seed: 11, ewrM3Day: 900 });
// A run that starts and ends mid water year, mid month (part years at both ends; 2004 and 2008 leap days inside).
const MID = testCatchment({ start: '2003-03-15', end: '2008-11-20', seed: 5, ewrM3Day: 900 });

const WINDOWS: [string, string | null, string | null][] = [
	['the whole run', null, null],
	['29 Feb 2004 to 28 Feb 2005', '2004-02-29', '2005-02-28'],
	['one day, 29 Feb 2004', '2004-02-29', '2004-02-29'],
	['one day, the run’s first', '2003-10-01', '2003-10-01'],
	['one day, the run’s last', '2008-09-30', '2008-09-30'],
	['clipped at the start', '2001-01-01', '2005-06-30'],
	['clipped at the end', '2006-10-01', '2030-01-01'],
	['inverted: falls back to the whole run', '2006-01-01', '2005-01-01'],
	['outside the run: falls back to the whole run', '2010-01-01', '2011-01-01'],
	['a part first year (from 2 Oct)', '2004-10-02', '2007-09-30'],
	['a part last year (to 29 Sep)', '2004-10-01', '2007-09-29'],
	['exactly complete water years', '2004-10-01', '2007-09-30'],
	['a leap water year alone (2007/08)', '2007-10-01', '2008-09-30'],
	['a window ending on 29 Feb 2008', '2005-03-01', '2008-02-29'],
	['start null, end mid-year', null, '2006-03-31'],
	['start mid-year, end null', '2005-04-17', null]
];

describe('outputs e2e: the reporting window (§2.11, §2.11a) on five complete water years', () => {
	const runs = new Map<string, ModelOutput>();
	for (const [name, a, b] of WINDOWS) {
		it(`curtailment and reliability equal the daily series over ${name}`, () => {
			const input = withWindow(BASE, a, b);
			const out = runModel(input);
			runs.set(name, out);
			const { from, to } = handWindow(out, a, b);
			checkCurtailment(input, out, from, to);
			checkReliability(input, out, from, to, THRESHOLD);
			// A clipped or fallen-back window says so.
			const clipped = (a && a < out.startDate) || (b && b > out.endDate);
			if (clipped || (a && b && b < a)) expect(out.summary.warnings.some((w) => /reporting window/.test(w))).toBe(true);
		});
	}
	it('the window moves nothing but the window-scoped summaries: the series, the stress grid and the account are the whole run’s', () => {
		const whole = runModel(withWindow(BASE, null, null));
		const part = runModel(withWindow(BASE, '2004-02-29', '2005-02-28'));
		expect(part.series).toEqual(whole.series);
		expect(part.summary.farms).toEqual(whole.summary.farms);
		expect(part.summary.supplyAssurance!.stress).toEqual(whole.summary.supplyAssurance!.stress);
		expect(part.summary.supplyAssurance!.waterAccount).toEqual(whole.summary.supplyAssurance!.waterAccount);
		checkStress(BASE, whole);
		checkWaterAccount(BASE, whole);
		checkFarmSummary(BASE, whole);
	});
	it('the five complete water years count as five; a window of exactly them has no part year', () => {
		const out = runModel(withWindow(BASE, null, null));
		for (const r of out.summary.supplyAssurance!.reliability) {
			expect(r.waterYears).toBe(5);
			expect(r.partWaterYears).toBe(0);
		}
	});
	it('the annual threshold is the project setting, a fraction in (0, 1]; anything else falls back to 0.9 with a warning', () => {
		for (const [th, used] of [[0.5, 0.5], [1, 1], [0.0001, 0.0001], [0, 0.9], [1.0001, 0.9], [-1, 0.9]] as const) {
			const input = withWindow(BASE, null, null, { assuranceAnnualThreshold: th });
			const out = runModel(input);
			checkReliability(input, out, 0, out.days - 1, used);
			expect(out.summary.warnings.some((w) => /annual assurance threshold/.test(w))).toBe(th !== used);
		}
	});
});

describe('outputs e2e: a run that starts and ends mid water year (§2.11a, §2.11b)', () => {
	const windows: [string | null, string | null][] = [
		[null, null],
		['2003-10-01', '2008-09-30'],
		['2004-02-29', '2004-03-01'],
		['2008-02-29', null],
		[null, '2003-09-30']
	];
	for (const [a, b] of windows) {
		it(`window ${a ?? 'start'} … ${b ?? 'end'}`, () => {
			const input = withWindow(MID, a, b);
			const out = runModel(input);
			const { from, to } = handWindow(out, a, b);
			checkCurtailment(input, out, from, to);
			checkReliability(input, out, from, to, THRESHOLD);
		});
	}
	it('part years at both ends: stress grid and water-account rows are per water year the run touches', () => {
		const out = runModel(MID);
		checkStress(MID, out);
		checkWaterAccount(MID, out);
		checkFarmSummary(MID, out);
		// 2002/03 (from 15 Mar) and 2008/09 (to 20 Nov) are part years; 2003/04 … 2007/08 complete.
		for (const r of out.summary.supplyAssurance!.reliability) {
			expect(r.waterYears).toBe(5);
			expect(r.partWaterYears).toBe(2);
		}
	});
});

describe('outputs e2e: random networks, random reporting windows (§2.11, §2.11a)', () => {
	it('every farm’s and user’s reliability, and the curtailment H, I and K_tot, equal the daily series over the window', () => {
		let checked = 0;
		for (let seed = 9100; seed < 9160; seed++) {
			const input = randomInput(seed, { maxNodes: 8, maxDays: 900 });
			let out: ModelOutput;
			try {
				out = runModel(input);
			} catch {
				continue; // an input the engine refuses is another file's concern
			}
			const s = out.summary;
			if (!s.curtailment || !s.supplyAssurance) continue;
			const ws = toEpochDay(s.curtailment.reportStart) - toEpochDay(out.startDate);
			const we = toEpochDay(s.curtailment.reportEnd) - toEpochDay(out.startDate);
			const exp = handWindow(out, (input.settings.reportStart as string | null) ?? null, (input.settings.reportEnd as string | null) ?? null);
			expect([ws, we], `seed ${seed} window`).toEqual([exp.from, exp.to]);
			const th = s.supplyAssurance.annualThreshold;
			for (const r of s.supplyAssurance.reliability) {
				const h = handReliability(out.startDate, series(out, r.nodeId, 'demand'), series(out, r.nodeId, 'supplied'), ws, we, th);
				const w = `seed ${seed} ${r.kind} ${r.nodeId}`;
				expect(r.demandDays, w).toBe(h.demandDays);
				expect(r.metDays, w).toBe(h.metDays);
				expect(r.waterYears, w).toBe(h.waterYears);
				expect(r.partWaterYears, w).toBe(h.partWaterYears);
				expect(r.waterYearsMet, w).toBe(h.waterYearsMet);
				expect(r.failureRuns, w).toBe(h.failureRuns);
				expect(r.longestFailureDays, w).toBe(h.longestFailureDays);
				expectClose(r.volumetricReliability, h.volumetricReliability, `${w} volumetric`);
				expectClose(r.maxFailureDeficitM3, h.maxFailureDeficitM3, `${w} max deficit`, 1e-9, 1e-6);
			}
			let sH = 0;
			let sI = 0;
			for (const f of s.curtailment.farms) {
				const H = mean(series(out, f.nodeId, 'demand'), ws, we);
				const I = mean(series(out, f.nodeId, 'supplied'), ws, we);
				expectClose(f.demandM3Day, H, `seed ${seed} ${f.nodeId} H`);
				expectClose(f.suppliedM3Day, I, `seed ${seed} ${f.nodeId} I`);
				sH += H;
				sI += I;
			}
			if (sH > 0) expectClose(s.curtailment.equitableFraction, sI / sH, `seed ${seed} K_tot`);
			// The system's stress grid: every farm and other water user summed per water-year month, over the whole run.
			const st = s.supplyAssurance.stress;
			const d0 = toEpochDay(out.startDate);
			const wy0 = waterYearOf(d0);
			const D = st.waterYears.map(() => new Array(12).fill(0) as number[]);
			const G = st.waterYears.map(() => new Array(12).fill(0) as number[]);
			for (const n of input.model.nodes) {
				if (n.kind === 'gauge') continue;
				const dem = maybeSeries(out, n.id, 'demand');
				const sup = maybeSeries(out, n.id, 'supplied');
				if (!dem || !sup) continue;
				for (let t = 0; t < out.days; t++) {
					D[waterYearOf(d0 + t) - wy0]![wyMonth(d0 + t)]! += dem[t]!;
					G[waterYearOf(d0 + t) - wy0]![wyMonth(d0 + t)]! += sup[t]!;
				}
			}
			for (let r = 0; r < D.length; r++)
				for (let c = 0; c < 12; c++) {
					const ratio = D[r]![c]! > 0 ? G[r]![c]! / D[r]![c]! : null;
					expectClose(st.system.ratio[r]![c], ratio, `seed ${seed} system ${wy0 + r}/${c}`, 1e-9, 1e-12);
					expect(st.system.stressClass[r]![c]).toBe(handStressClass(st.system.ratio[r]![c]!));
				}
			checked++;
		}
		expect(checked).toBeGreaterThan(30);
	});
});

describe('outputs e2e: dam figures in the farm summary (§2.8, engine ≥ 1.2.0)', () => {
	const cases: [string, ModelInput][] = [
		['five water years', BASE],
		['a mid-year run', MID],
		['a 20-day run (no figure 30 days ago)', testCatchment({ start: '2004-02-15', end: '2004-03-05', seed: 4 })],
		['a dry spell holding the dams at their minimum', testCatchment({ start: '2003-10-01', end: '2005-09-30', seed: 9, ewrM3Day: 900 })]
	];
	for (const [name, input] of cases) {
		it(`${name}: end, 30 days before, the lowest of the last 365 days and its first day, days at the minimum`, () => {
			const out = runModel(input);
			for (const n of input.model.nodes.filter((x) => x.kind === 'farm' && x.damCapacityM3 >= 1)) {
				const s = series(out, n.id, 'dam_storage');
				const last = s.length - 1;
				const f = out.summary.farms.find((x) => x.nodeId === n.id)!;
				expect(f.damEndM3).toBe(s[last]);
				expect(f.damAgoM3).toBe(last >= 30 ? s[last - 30] : null);
				const from = Math.max(0, last - 364);
				let low = from;
				let atMin = 0;
				for (let t = from; t <= last; t++) {
					if (s[t]! < s[low]!) low = t;
					if (n.damMinPct > 0 && (s[t]! / n.damCapacityM3) * 100 <= n.damMinPct * 100 + 1e-6) atMin++;
				}
				expect(f.damLowM3).toBe(s[low]);
				expect(f.damLowDate).toBe(day(out.startDate, low));
				expect(f.damDaysAtMin).toBe(atMin);
			}
		});
	}
});
