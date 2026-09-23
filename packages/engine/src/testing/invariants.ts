// Physical invariants of a model run, shared by the random-network fuzz tests
// (../run.invariants.test.ts), the example catchments (backend) and
// client catchment (when data/ is present). Each check returns the first broken
// property as text, or null. They state what must hold for *any* sound water
// balance (mass conservation, bounds, limits honoured, totals that add up),
// not what the workbook happens to produce, so they stay valid when the
// algorithms change. See docs/model.md §6 "Verification".
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { excelRound } from '../network/round';
import type { CurtailmentFarm, EwrComplianceGrid, ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { cloneInput, scrambleOrder } from './fuzz';

const SEC_PER_DAY = 86_400;
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);

type SeriesMap = Map<string, number[]>;
const seriesMap = (out: ModelOutput): SeriesMap => new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));

/**
 * Daily balance identities and bounds, every node, every day:
 * - every value finite (observed flow may be NaN on missing days);
 * - routed inflow = Σ upstream outflow (gauges pass it through);
 * - farm balance H + I + J + Q[t−1] = U + G − T + Q (T = return flow);
 * - 0 ≤ storage ≤ capacity, spill only from a full dam, 0 ≤ supplied ≤ demand,
 *   deficit = demand − supplied, EWR shortfall = MIN(U − Z, 0) ≤ 0;
 * - transfers net to zero across farms each day;
 * - the catchment balance closes over the run: opening storage + runoff =
 *   outflow + consumptive use + closing storage.
 */
export function checkBalance(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	for (const s of out.series) {
		if (s.key === 'observed_flow') continue;
		for (let t = 0; t < s.values.length; t++) {
			if (!Number.isFinite(s.values[t]!)) return `${s.nodeId}/${s.key}[${t}] is ${s.values[t]}`;
		}
	}
	const nodes = input.model.nodes;
	const outlet = nodes.find((n) => n.downstreamNodeId === null)!;
	let totIn = 0;
	let totOut = 0;
	for (const n of nodes) {
		const ups = nodes.filter((u) => u.downstreamNodeId === n.id);
		const U = get.get(`${n.id}|outflow`)!;
		for (let t = 0; t < out.days; t++) {
			const H = ups.reduce((s, u) => s + get.get(`${u.id}|outflow`)![t]!, 0);
			if (Math.abs((n.kind === 'gauge' ? U[t]! : get.get(`${n.id}|inflow_upstream`)![t]!) - H) > tol(H))
				return `${n.id} day ${t}: routed inflow ${H} ≠ upstream sum`;
		}
		if (n.kind === 'gauge') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`)!;
		const [F, G, W, H, I, J, Q, R, AA, Z] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_cumulative'].map(g) as number[][];
		const cap = excelRound(n.damCapacityM3, 0);
		let qPrev = excelRound(n.damInitialPct * cap, 0);
		totIn += qPrev;
		for (let t = 0; t < out.days; t++) {
			const T = excelRound(G![t]! * n.returnFlowPct, 0);
			const lhs = H![t]! + I![t]! + J![t]! + qPrev;
			const rhs = U[t]! + G![t]! - T + Q![t]!;
			const where = `${n.id} day ${t}`;
			if (Math.abs(lhs - rhs) > tol(lhs)) return `${where}: farm balance ${lhs} ≠ ${rhs}`;
			if (Q![t]! < -1e-9 || Q![t]! > cap + 1e-9) return `${where}: storage ${Q![t]} outside [0, ${cap}]`;
			if (R![t]! < 0 || (R![t]! > 0 && Math.abs(Q![t]! - cap) > 1e-9)) return `${where}: spill ${R![t]} with storage ${Q![t]}/${cap}`;
			if (G![t]! > F![t]! + 1e-9) return `${where}: supplied ${G![t]} > demand ${F![t]}`;
			if (G![t]! < -1e-9) return `${where}: supplied ${G![t]} < 0`;
			if (Math.abs(W![t]! - (F![t]! - G![t]!)) > 1e-9) return `${where}: deficit ≠ demand − supplied`;
			if (AA![t]! > 0 || Math.abs(AA![t]! - Math.min(U[t]! - Z![t]!, 0)) > tol(U[t]!)) return `${where}: EWR shortfall ${AA![t]}`;
			totIn += I![t]!;
			totOut += G![t]! - T;
			qPrev = Q![t]!;
		}
		totOut += qPrev;
	}
	const sim = get.get('null|simulated_outflow')!;
	const outletU = get.get(`${outlet.id}|outflow`)!;
	for (let t = 0; t < out.days; t++) {
		if (sim[t] !== outletU[t]) return `day ${t}: simulated outflow ≠ outlet node outflow`;
		totOut += sim[t]!;
		const Jsum = nodes.filter((n) => n.kind === 'farm').reduce((s, n) => s + get.get(`${n.id}|transfer`)![t]!, 0);
		if (Math.abs(Jsum) > 1e-6) return `day ${t}: transfers do not net to 0 (${Jsum})`;
		const e = get.get('null|ewr')![t]!;
		const sh = get.get('null|ewr_shortfall')![t]!;
		if (sh !== Math.min(sim[t]! - e, 0) && !(sh === 0 && sim[t]! - e >= 0)) return `day ${t}: catchment EWR shortfall ${sh}`;
	}
	if (Math.abs(totIn - totOut) > 1e-6 * Math.max(1, totIn)) return `catchment mass balance: in ${totIn} ≠ out ${totOut}`;
	return null;
}

interface Rule {
	from: string;
	to: string;
	months: Set<number>;
	maxDaily: number;
	reserve: number;
}

/**
 * Per-day transfer limits, whatever the priority between rules (docs/model.md
 * Q18), checked on each farm's net transfer J:
 * - months: a farm no active rule touches today has J = 0;
 * - rate and daily cap: J ≤ Σ limits of today's rules into the farm, and
 *   −J ≤ Σ limits of today's rules out of it (limit = MIN(ROUND(rate × 86 400),
 *   daily cap));
 * - minimum storage: −J ≤ yesterday's storage − the lowest reserve among
 *   today's outgoing rules (never below 0);
 * - no water left on the table: for a source whose rules all go to farms fed
 *   only by it, the volume that left is at least MIN(Σ limits, yesterday's
 *   storage − the highest reserve), and exactly that when the reserves agree.
 */
export function checkTransferLimits(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const byId = new Map(input.model.nodes.map((n) => [n.id, n]));
	const rules: Rule[] = [];
	for (const tr of input.model.transfers) {
		const a = byId.get(tr.fromNodeId);
		const b = byId.get(tr.toNodeId);
		if (!tr.enabled || !a || !b || a.kind !== 'farm' || b.kind !== 'farm') continue;
		let maxDaily = excelRound(tr.maxRateM3s * SEC_PER_DAY, 0);
		if (tr.dailyCapM3 !== null) maxDaily = Math.min(maxDaily, tr.dailyCapM3);
		rules.push({ from: a.id, to: b.id, months: new Set(tr.months), maxDaily: Math.max(0, maxDaily), reserve: a.damCapacityM3 * tr.minStoragePct });
	}
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const d0 = toEpochDay(out.startDate);
	const storage = (id: string, t: number) => {
		if (t > 0) return get.get(`${id}|dam_storage`)![t - 1]!;
		const n = byId.get(id)!;
		return excelRound(n.damInitialPct * excelRound(n.damCapacityM3, 0), 0);
	};
	for (let t = 0; t < out.days; t++) {
		const month = monthOfEpochDay(d0 + t);
		const active = rules.filter((r) => r.months.has(month));
		for (const f of farms) {
			const J = get.get(`${f.id}|transfer`)![t]!;
			const ins = active.filter((r) => r.to === f.id);
			const outs = active.filter((r) => r.from === f.id);
			const where = `${f.id} day ${t}`;
			if (ins.length === 0 && outs.length === 0) {
				if (J !== 0) return `${where}: transfer ${J} with no rule active in month ${month}`;
				continue;
			}
			const inMax = ins.reduce((s, r) => s + r.maxDaily, 0);
			const outMax = outs.reduce((s, r) => s + r.maxDaily, 0);
			if (J > inMax + tol(inMax)) return `${where}: received ${J} > the rules' limit ${inMax}`;
			const prev = storage(f.id, t);
			const avail = outs.length ? Math.max(prev - Math.min(...outs.map((r) => r.reserve)), 0) : 0;
			const outCap = Math.min(outMax, avail);
			if (-J > outCap + tol(outCap)) return `${where}: sent ${-J} > MIN(limit ${outMax}, storage ${prev} − reserve) = ${outCap}`;
		}
		// Identifiable sources: every destination is fed by this source alone and sends nothing.
		for (const f of farms) {
			const outs = active.filter((r) => r.from === f.id);
			if (outs.length === 0 || active.some((r) => r.to === f.id)) continue;
			const dests = new Set(outs.map((r) => r.to));
			if ([...dests].some((d) => active.some((r) => (r.to === d && r.from !== f.id) || r.from === d))) continue;
			const sent = -get.get(`${f.id}|transfer`)![t]!;
			const got = [...dests].reduce((s, d) => s + get.get(`${d}|transfer`)![t]!, 0);
			const where = `${f.id} day ${t}`;
			if (Math.abs(sent - got) > tol(sent)) return `${where}: sent ${sent} but its destinations got ${got}`;
			const prev = storage(f.id, t);
			const limit = outs.reduce((s, r) => s + r.maxDaily, 0);
			const floor = Math.min(limit, Math.max(prev - Math.max(...outs.map((r) => r.reserve)), 0));
			if (sent < floor - tol(floor)) return `${where}: sent only ${sent}; the rules allowed ${floor} (storage ${prev})`;
		}
	}
	return null;
}

/**
 * The EWR compliance grid and the curtailment report agree with the daily
 * series they summarise:
 * - grid days add up to the run, every cell has 0 ≤ not met ≤ days ≤ days in
 *   the month, volumes are ≥ 0, and each site's Σ volume and Σ days not met
 *   equal −Σ daily shortfall and the count of short days (outlet: the
 *   catchment summary; farm: its FarmSummary);
 * - curtailment: H, I, R are the rounded window means of demand, supplied and
 *   incremental EWR shortfall; totals are the column sums; the equitable
 *   fraction is ΣI / ΣH; targets redistribute the supplied water (Σ M = Σ I
 *   within the 0.05 m³/day rounding per farm), never exceed demand, and
 *   N = M − I, S = N + R, U = M + R.
 */
export function checkReportTotals(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const sum = (a: number[], from = 0, to = a.length - 1) => {
		let s = 0;
		for (let t = from; t <= to; t++) s += a[t]!;
		return s;
	};
	const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
	const c = out.summary.ewrCompliance!;
	const cellDays = c.days.flat();
	if (sum(cellDays) !== out.days) return `EWR grid: cells hold ${sum(cellDays)} days, the run has ${out.days}`;
	const d0 = toEpochDay(out.startDate);
	const monthLen = (wy: number, m: number) => {
		const cal = ((m + 9) % 12) + 1; // water-year index 0 = Oct
		const year = cal >= 10 ? wy : wy + 1;
		return new Date(Date.UTC(year, cal, 0)).getUTCDate();
	};
	const grid = (g: EwrComplianceGrid, daily: number[], label: string, daysNotMet: number): string | null => {
		for (let r = 0; r < c.waterYears.length; r++) {
			for (let m = 0; m < 12; m++) {
				const n = c.days[r]![m]!;
				const nm = g.daysNotMet[r]![m]!;
				const v = g.shortfallM3[r]![m]!;
				if (n > monthLen(c.waterYears[r]!, m)) return `EWR grid ${label} ${c.waterYears[r]}/${m}: ${n} days in a month`;
				if (nm < 0 || nm > n || v < 0 || (n === 0 && v !== 0)) return `EWR grid ${label} ${c.waterYears[r]}/${m}: ${nm} of ${n} days, ${v} m³`;
			}
		}
		const vol = sum(g.shortfallM3.flat());
		if (!close(vol, -sum(daily), 1e-6 * out.days)) return `EWR grid ${label}: Σ volume ${vol} ≠ −Σ daily shortfall ${-sum(daily)}`;
		const short = daily.filter((v) => v < 0).length;
		if (sum(g.daysNotMet.flat()) !== short || short !== daysNotMet) return `EWR grid ${label}: ${sum(g.daysNotMet.flat())} days not met, daily series ${short}, summary ${daysNotMet}`;
		return null;
	};
	if (c.waterYears[0] !== waterYearOfDay(d0) || c.waterYears.at(-1) !== waterYearOfDay(d0 + out.days - 1)) return 'EWR grid: water years do not span the run';
	const bad = grid(c.outlet, get.get('null|ewr_shortfall')!, 'outlet', out.summary.catchment.ewrDaysNotMet);
	if (bad) return bad;
	for (const g of c.farms) {
		const fs = out.summary.farms.find((f) => f.nodeId === g.nodeId)!;
		const b = grid(g, get.get(`${g.nodeId}|ewr_shortfall_incremental`)!, g.nodeId ?? '?', fs.daysEwrNotMet);
		if (b) return b;
	}

	// FarmSummary: whole-run means of the daily series.
	for (const f of out.summary.farms) {
		const dm = sum(get.get(`${f.nodeId}|demand`)!) / out.days;
		const sp = sum(get.get(`${f.nodeId}|supplied`)!) / out.days;
		if (!close(f.avgDemandM3Day, dm) || !close(f.avgSuppliedM3Day, sp)) return `farm summary ${f.nodeId}: means differ from the daily series`;
		if (f.fractionSupplied < 0 || f.fractionSupplied > 1 + 1e-12) return `farm summary ${f.nodeId}: fraction supplied ${f.fractionSupplied}`;
	}

	// Curtailment over its reporting window.
	const k = out.summary.curtailment!;
	const from = toEpochDay(k.reportStart) - d0;
	const to = toEpochDay(k.reportEnd) - d0;
	if (from < 0 || to >= out.days || to < from || k.days !== to - from + 1) return `curtailment window ${k.reportStart} … ${k.reportEnd} outside the run`;
	const n = to - from + 1;
	const r0 = (x: number) => excelRound(x, 0) || 0;
	let sumH = 0;
	let sumI = 0;
	let sumM = 0;
	for (const row of k.farms) {
		const w = `curtailment ${row.nodeId}`;
		const H = r0(sum(get.get(`${row.nodeId}|demand`)!, from, to) / n);
		const I = r0(sum(get.get(`${row.nodeId}|supplied`)!, from, to) / n);
		const R = r0(sum(get.get(`${row.nodeId}|ewr_shortfall_incremental`)!, from, to) / n);
		if (row.demandM3Day !== H || row.suppliedM3Day !== I || row.ewrShortfallM3Day !== R) return `${w}: H/I/R ${row.demandM3Day}/${row.suppliedM3Day}/${row.ewrShortfallM3Day} ≠ window means ${H}/${I}/${R}`;
		if (R > 0 || I > H) return `${w}: shortfall ${R} > 0 or supplied ${I} > demand ${H}`;
		if (row.targetM3Day > H + 1e-9 || row.targetM3Day < 0) return `${w}: target ${row.targetM3Day} outside [0, demand ${H}]`;
		const id = (x: CurtailmentFarm, a: number, b: number, what: string) => (close(a, b, 0.051) ? null : `${w}: ${what} (${a} vs ${b}) in ${JSON.stringify(x)}`);
		const e = id(row, row.reduceGainM3Day, row.targetM3Day - I, 'N ≠ M − I') ?? id(row, row.totalChangeM3Day, row.reduceGainM3Day + R, 'S ≠ N + R') ?? id(row, row.volumeLeftM3Day, row.targetM3Day + R, 'U ≠ M + R');
		if (e) return e;
		if ((row.fractionSupplied === null) !== (H === 0)) return `${w}: fraction supplied null iff demand 0`;
		sumH += H;
		sumI += I;
		sumM += row.targetM3Day;
	}
	if (k.totals.demandM3Day !== sumH || k.totals.suppliedM3Day !== sumI) return `curtailment totals ${k.totals.demandM3Day}/${k.totals.suppliedM3Day} ≠ Σ farms ${sumH}/${sumI}`;
	if (sumH === 0 ? k.equitableFraction !== null : !close(k.equitableFraction!, sumI / sumH, 1e-12)) return `curtailment equitable fraction ${k.equitableFraction} ≠ ${sumI}/${sumH}`;
	if (sumH > 0 && !close(sumM, sumI, 0.05 * k.farms.length + 1e-6)) return `curtailment targets Σ ${sumM} do not redistribute the supplied ${sumI}`;
	return null;
}

function waterYearOfDay(day: number): number {
	const d = new Date(day * 86_400_000);
	return d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/** Every per-run invariant. */
export function checkInvariants(input: ModelInput, out: ModelOutput): string | null {
	return checkBalance(input, out) ?? checkTransferLimits(input, out) ?? checkReportTotals(input, out);
}

/**
 * Numbers equal to 1e-9 of their scale; objects/arrays compared recursively;
 * NaN equals NaN. The scale of a number inside a numeric array is the array's
 * largest magnitude: summing upstream flows in another order changes the last
 * bits, and a difference of 1e-7 m³ in a series of 10⁹ m³ values is rounding,
 * not a different result. Whole-number results (day counts) must match exactly.
 */
function sameValue(a: unknown, b: unknown, path: string, scale = 1): string | null {
	if (typeof a === 'number' && typeof b === 'number') {
		if (Number.isNaN(a) && Number.isNaN(b)) return null;
		return Math.abs(a - b) <= 1e-9 * Math.max(scale, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
		let s = scale;
		for (const v of [...a, ...b]) if (typeof v === 'number' && Number.isFinite(v)) s = Math.max(s, Math.abs(v));
		for (let i = 0; i < a.length; i++) {
			const d = sameValue(a[i], b[i], `${path}[${i}]`, s);
			if (d) return d;
		}
		return null;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) {
			const d = sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
			if (d) return d;
		}
		return null;
	}
	return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/** The output with every list that follows input order put into a canonical order. */
function canonical(out: ModelOutput) {
	const byNode = <T extends { nodeId: string | null }>(xs: T[]) => [...xs].sort((p, q) => String(p.nodeId).localeCompare(String(q.nodeId)));
	const s = out.summary;
	return {
		...out,
		series: Object.fromEntries(out.series.map((s) => [`${s.nodeId}|${s.key}`, s])),
		summary: {
			...s,
			farms: byNode(s.farms),
			curtailment: s.curtailment && { ...s.curtailment, farms: byNode(s.curtailment.farms) },
			ewrCompliance: s.ewrCompliance && { ...s.ewrCompliance, farms: byNode(s.ewrCompliance.farms) },
			dataQuality: s.dataQuality && { ...s.dataQuality, areaMismatches: s.dataQuality.areaMismatches && byNode(s.dataQuality.areaMismatches) },
			// Warnings name elements in input order; compare them as a multiset of
			// sentences with the name lists sorted.
			warnings: s.warnings.map(sortNameLists).sort()
		}
	};
}
const sortNameLists = (w: string) => w.replace(/\(([^()]*;[^()]*)\)/g, (_, inner: string) => `(${inner.split('; ').sort().join('; ')})`);

/**
 * Display order must not matter: the node array and every sortOrder, the crop
 * list and crop-area rows give the same results. Transfer order is kept when
 * two enabled rules share a source dam, because their priority (document
 * order today) is an open modelling question (docs/model.md Q18); otherwise it
 * is shuffled too.
 */
export function checkOrderInvariance(input: ModelInput, out: ModelOutput, seed: number): string | null {
	const sources = input.model.transfers.filter((t) => t.enabled).map((t) => t.fromNodeId);
	const shared = new Set(sources).size !== sources.length;
	const x = scrambleOrder(input, seed);
	if (shared) x.model.transfers = cloneInput(input).model.transfers;
	let y: ModelOutput;
	try {
		y = runModel(x);
	} catch (e) {
		return `order invariance: scrambled input threw ${(e as Error).message}`;
	}
	// Every series is a volume (or flow) of the same catchment, so their common
	// scale is the largest magnitude in either run: a residue of 1e-7 m³ from
	// cancelling two 10⁹ m³ sums is rounding, whatever series it lands in.
	let scale = 1;
	for (const o of [out, y]) for (const s of o.series) for (const v of s.values) if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
	const ca = canonical(out);
	const cb = canonical(y);
	let d: string | null = null;
	for (const k of new Set([...Object.keys(ca.series), ...Object.keys(cb.series)])) {
		d ??= sameValue(ca.series[k]?.values, cb.series[k]?.values, `series ${k}`, scale);
	}
	d ??= sameValue({ ...ca, series: null }, { ...cb, series: null }, 'output');
	return d ? `order invariance (seed ${seed}${shared ? ', transfer order kept' : ''}): ${d}` : null;
}

/**
 * More irrigated land can't make the catchment better supplied: doubling every
 * crop area never raises Σ supplied / Σ demand over the run. The slack allows
 * for the workbook's rounding of daily demand to whole m³ (±1 m³ per farm-day
 * after doubling).
 */
export function checkDoubledCropAreas(input: ModelInput, out: ModelOutput): string | null {
	const x = cloneInput(input);
	for (const a of x.model.cropAreas) a.areaM2 *= 2;
	let y: ModelOutput;
	try {
		y = runModel(x);
	} catch (e) {
		return `doubled crop areas threw ${(e as Error).message}`;
	}
	const tot = (o: ModelOutput) => o.summary.farms.reduce((s, f) => [s[0]! + f.avgDemandM3Day, s[1]! + f.avgSuppliedM3Day], [0, 0]);
	const [d1, s1] = tot(out);
	const [d2, s2] = tot(y);
	if (!(d1! > 0) || !(d2! > 0)) return null;
	const cropped = new Set(x.model.cropAreas.filter((a) => a.areaM2 > 0).map((a) => a.nodeId)).size;
	const slack = (2 * cropped) / d2! + 1e-9; // average m³/day per farm of rounding over total average demand
	const f1 = s1! / d1!;
	const f2 = s2! / d2!;
	return f2 > f1 + slack ? `doubling crop areas raised the supply fraction ${f1} → ${f2} (slack ${slack})` : null;
}

/** runModel + every invariant, including the ones that re-run the model. */
export function checkAll(input: ModelInput, seed = 1): string | null {
	let out: ModelOutput;
	try {
		out = runModel(input);
	} catch (e) {
		return `threw: ${(e as Error).message}`;
	}
	const bad = checkInvariants(input, out);
	if (bad) return bad;
	if (JSON.stringify(runModel(input)) !== JSON.stringify(out)) return 'not deterministic';
	return checkOrderInvariance(input, out, seed) ?? checkDoubledCropAreas(input, out);
}
