// Physical invariants of a model run, shared by the random-network fuzz tests
// (../run.invariants.test.ts), the example catchments (backend) and
// the client catchment (when data/ is present). Each check returns the first broken
// property as text, or null. They state what must hold for *any* sound water
// balance (mass conservation, bounds, limits honoured, totals that add up),
// not what the workbook happens to produce, so they stay valid when the
// algorithms change. See docs/model.md §6 "Verification".
import { monthOfEpochDay, toEpochDay } from '../calendar';
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
		// The engine keeps full precision (docs/engine-audit.md R1): no rounding here either.
		const cap = n.damCapacityM3;
		let qPrev = n.damInitialPct * cap;
		totIn += qPrev;
		for (let t = 0; t < out.days; t++) {
			const T = G![t]! * n.returnFlowPct;
			const lhs = H![t]! + I![t]! + J![t]! + qPrev;
			const rhs = U[t]! + G![t]! - T + Q![t]!;
			const where = `${n.id} day ${t}`;
			if (Math.abs(lhs - rhs) > tol(lhs)) return `${where}: farm balance ${lhs} ≠ ${rhs}`;
			if (Q![t]! < -1e-9 || Q![t]! > cap + 1e-9) return `${where}: storage ${Q![t]} outside [0, ${cap}]`;
			if (R![t]! < 0 || (R![t]! > 0 && Math.abs(Q![t]! - cap) > 1e-9)) return `${where}: spill ${R![t]} with storage ${Q![t]}/${cap}`;
			if (G![t]! > F![t]! + 1e-9) return `${where}: supplied ${G![t]} > demand ${F![t]}`;
			if (G![t]! < -1e-9) return `${where}: supplied ${G![t]} < 0`;
			if (Math.abs(W![t]! - (F![t]! - G![t]!)) > 1e-9) return `${where}: deficit ≠ demand − supplied`;
			// The engine reports float noise below 1e-12 of the volumes as no shortfall (review F8).
			const noise = 1e-12 * Math.max(Math.abs(U[t]!), Math.abs(Z![t]!));
			if (AA![t]! > 0 || Math.abs(AA![t]! - Math.min(U[t]! - Z![t]!, 0)) > tol(U[t]!) + noise) return `${where}: EWR shortfall ${AA![t]}`;
			const upAA = ups.reduce((sum, u) => sum + get.get(`${u.id}|ewr_shortfall`)![t]!, 0);
			const AB = get.get(`${n.id}|ewr_shortfall_incremental`)![t]!;
			const abNoise = noise + 1e-12 * ups.reduce((sum, u) => sum + Math.abs(get.get(`${u.id}|ewr_shortfall`)![t]!), 0);
			if (AB > 0 || Math.abs(AB - Math.min(AA![t]! - upAA, 0)) > tol(upAA) + abNoise) return `${where}: incremental EWR shortfall ${AB} ≠ MIN(${AA![t]} − ${upAA}, 0)`;
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
		if (sh > 0 || Math.abs(sh - Math.min(sim[t]! - e, 0)) > 1e-12 * Math.max(Math.abs(sim[t]!), Math.abs(e))) return `day ${t}: catchment EWR shortfall ${sh}`;
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
 *   −J ≤ Σ limits of today's rules out of it (limit = MIN(rate × 86 400,
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
		let maxDaily = tr.maxRateM3s * SEC_PER_DAY;
		if (tr.dailyCapM3 !== null) maxDaily = Math.min(maxDaily, tr.dailyCapM3);
		rules.push({ from: a.id, to: b.id, months: new Set(tr.months), maxDaily: Math.max(0, maxDaily), reserve: a.damCapacityM3 * tr.minStoragePct });
	}
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const d0 = toEpochDay(out.startDate);
	const storage = (id: string, t: number) => {
		if (t > 0) return get.get(`${id}|dam_storage`)![t - 1]!;
		const n = byId.get(id)!;
		return n.damInitialPct * n.damCapacityM3;
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
 * - curtailment: H, I, R are the window means of demand, supplied and
 *   incremental EWR shortfall (unrounded, R1); I ≤ H and R ≤ 0; totals are
 *   the column sums; the equitable fraction is ΣI / ΣH; targets redistribute
 *   the supplied water (Σ M = Σ I) and never exceed demand; N = M − I,
 *   S = N + R, U = M + R and the l/s columns are m³/day ÷ 86.4.
 * Tolerances are float noise only: 1e-12 of the operands' magnitude for single
 * operations, 1e-10 of Σ|x| for sums over a run.
 */
export function checkReportTotals(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const sum = (a: number[], from = 0, to = a.length - 1) => {
		let s = 0;
		for (let t = from; t <= to; t++) s += a[t]!;
		return s;
	};
	const sumAbs = (a: number[]) => a.reduce((s, v) => s + Math.abs(v), 0);
	/** |a − b| within `rel` of `scale` (default: the larger magnitude). */
	const close = (a: number, b: number, rel = 1e-12, scale = Math.max(Math.abs(a), Math.abs(b))) => Math.abs(a - b) <= rel * scale;
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
		if (!close(vol, -sum(daily), 1e-10, sumAbs(daily))) return `EWR grid ${label}: Σ volume ${vol} ≠ −Σ daily shortfall ${-sum(daily)}`;
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
	let sumH = 0;
	let sumI = 0;
	let sumM = 0;
	for (const row of k.farms) {
		const w = `curtailment ${row.nodeId}`;
		const mean = (key: string) => sum(get.get(`${row.nodeId}|${key}`)!, from, to) / n;
		const [mH, mI, mR] = [mean('demand'), mean('supplied'), mean('ewr_shortfall_incremental')] as [number, number, number];
		if (!close(row.demandM3Day, mH) || !close(row.suppliedM3Day, mI) || !close(row.ewrShortfallM3Day, mR))
			return `${w}: H/I/R ${row.demandM3Day}/${row.suppliedM3Day}/${row.ewrShortfallM3Day} ≠ window means ${mH}/${mI}/${mR}`;
		// Daily supplied ≤ demand and shortfall ≤ 0, so their means are too (float sums are monotone).
		if (row.ewrShortfallM3Day > 0 || row.suppliedM3Day > row.demandM3Day) return `${w}: shortfall ${row.ewrShortfallM3Day} > 0 or supplied ${row.suppliedM3Day} > demand ${row.demandM3Day}`;
		if (row.targetM3Day > row.demandM3Day || row.targetM3Day < 0) return `${w}: target ${row.targetM3Day} outside [0, demand ${row.demandM3Day}]`;
		const M = row.targetM3Day;
		const id = (x: CurtailmentFarm, a: number, b: number, what: string, ...ops: number[]) =>
			close(a, b, 1e-12, Math.max(Math.abs(a), Math.abs(b), ...ops.map(Math.abs))) ? null : `${w}: ${what} (${a} vs ${b}) in ${JSON.stringify(x)}`;
		const e =
			id(row, row.reduceGainM3Day, M - row.suppliedM3Day, 'N ≠ M − I', M, row.suppliedM3Day) ??
			id(row, row.totalChangeM3Day, row.reduceGainM3Day + row.ewrShortfallM3Day, 'S ≠ N + R', row.reduceGainM3Day, row.ewrShortfallM3Day) ??
			id(row, row.volumeLeftM3Day, M + row.ewrShortfallM3Day, 'U ≠ M + R', M, row.ewrShortfallM3Day) ??
			id(row, row.reduceGainLs, row.reduceGainM3Day / 86.4, 'l/s ≠ m³/day ÷ 86.4') ??
			id(row, row.totalChangeLs, row.totalChangeM3Day / 86.4, 'total l/s ≠ m³/day ÷ 86.4');
		if (e) return e;
		const H = row.demandM3Day;
		const I = row.suppliedM3Day;
		if ((row.fractionSupplied === null) !== (H === 0)) return `${w}: fraction supplied null iff demand 0`;
		sumH += H;
		sumI += I;
		sumM += row.targetM3Day;
	}
	if (!close(k.totals.demandM3Day, sumH) || !close(k.totals.suppliedM3Day, sumI)) return `curtailment totals ${k.totals.demandM3Day}/${k.totals.suppliedM3Day} ≠ Σ farms ${sumH}/${sumI}`;
	if (sumH === 0 ? k.equitableFraction !== null : !close(k.equitableFraction!, sumI / sumH)) return `curtailment equitable fraction ${k.equitableFraction} ≠ ${sumI}/${sumH}`;
	if (sumH > 0 && !close(sumM, sumI, 1e-12 * Math.max(1, k.farms.length))) return `curtailment targets Σ ${sumM} do not redistribute the supplied ${sumI}`;
	return null;
}

function waterYearOfDay(day: number): number {
	const d = new Date(day * 86_400_000);
	return d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

/**
 * The runoff model's water balance, from the run's own series (conceptual
 * models; nothing to check for legacy runs, which have no summary.runoff):
 * - every day, rain − AET − Q + exchange = Δ(Σ stores), Q = natural flow in
 *   mm over the catchment, starting from the post-warm-up storage;
 * - Q ≥ 0, 0 ≤ AET ≤ PET, stores ≥ 0 and the production store ≤ X1;
 * - the summary's totals are the sums of the series and close the balance.
 */
export function checkRunoffBalance(input: ModelInput, out: ModelOutput): string | null {
	const b = out.summary.runoff;
	const legacy = (input.settings.runoffModel ?? 'legacy') === 'legacy';
	if (!b) return legacy ? null : `runoff model ${String(input.settings.runoffModel)} reported no water balance`;
	if (legacy) return 'a legacy run reported a runoff balance';
	const get = seriesMap(out);
	const s = (k: string) => get.get(`null|${k}`);
	const rain = s('rain_used')!;
	const pet = s('pet')!;
	const aet = s('aet')!;
	const nat = s('natural_flow')!;
	const stores = ['production_store', 'routing_store', 'uh_store'].map((k) => s(k)!);
	const ex = s('exchange');
	if (!rain || !pet || !aet || stores.some((x) => !x)) return 'runoff series missing';
	if (!ex && b.params.x2 !== 0) return 'exchange series missing with X2 ≠ 0';
	const toMm = 1 / (b.areaKm2 * 1000);
	const t9 = (x: number) => 1e-9 + 1e-12 * Math.abs(x);
	let before = b.storageStartMm;
	const tot = { rain: 0, pet: 0, aet: 0, flow: 0, ex: 0 };
	for (let t = 0; t < out.days; t++) {
		const q = nat[t]! * toMm;
		const e = ex ? ex[t]! : 0;
		const after = stores[0]![t]! + stores[1]![t]! + stores[2]![t]!;
		const d = rain[t]! - aet[t]! - q + e - (after - before);
		if (Math.abs(d) > t9(Math.max(before, after, rain[t]!))) return `runoff day ${t}: rain − AET − Q + exchange − Δstorage = ${d}`;
		if (q < 0 || aet[t]! < 0 || aet[t]! > pet[t]! + t9(pet[t]!)) return `runoff day ${t}: Q ${q}, AET ${aet[t]}, PET ${pet[t]}`;
		if (stores.some((x) => x[t]! < -t9(0)) || stores[0]![t]! > b.params.x1! + t9(b.params.x1!)) return `runoff day ${t}: a store is outside its bounds`;
		tot.rain += rain[t]!;
		tot.pet += pet[t]!;
		tot.aet += aet[t]!;
		tot.flow += q;
		tot.ex += e;
		before = after;
	}
	const scale = Math.max(1, tot.rain + tot.aet + tot.flow + Math.abs(tot.ex) + b.storageStartMm + before);
	const near = (a: number, c: number) => Math.abs(a - c) <= 1e-9 * scale;
	if (!near(b.rainMm, tot.rain) || !near(b.petMm, tot.pet) || !near(b.aetMm, tot.aet) || !near(b.flowMm, tot.flow) || !near(b.exchangeMm, tot.ex) || !near(b.storageEndMm, before))
		return `runoff summary ${JSON.stringify(b)} disagrees with the series`;
	if (!near(b.rainMm - b.aetMm - b.flowMm + b.exchangeMm, b.storageEndMm - b.storageStartMm)) return 'runoff summary does not close its balance';
	return null;
}

/** Every per-run invariant. */
export function checkInvariants(input: ModelInput, out: ModelOutput): string | null {
	return checkBalance(input, out) ?? checkRunoffBalance(input, out) ?? checkTransferLimits(input, out) ?? checkReportTotals(input, out);
}

/**
 * Deep equality for two runs of the same model. NaN equals NaN; whole numbers
 * (day counts, water years) must match exactly. Other numbers may differ by
 * float noise, 1e-9 of their scale: summing upstream flows or crop areas in
 * another order changes the last bits, and 1e-7 m³ in a catchment moving
 * 10⁹ m³/day is noise, not a different result. The scale of a volume (a field
 * named …M3…, …Mm3…, …Ls, or a numeric array) is `volume`, the largest volume
 * in either run. A fraction of a farm's demand (fractionSupplied,
 * targetFraction, fractionOfDemandLeft) carries that volume noise divided by
 * the demand, so its scale is volume / demand; any other ratio is compared to
 * 1e-9 of itself.
 */
function sameValue(a: unknown, b: unknown, path: string, scale = 1, volume = 1): string | null {
	if (typeof a === 'number' && typeof b === 'number') {
		if (Number.isNaN(a) && Number.isNaN(b)) return null;
		if (Number.isInteger(a) && Number.isInteger(b)) return a === b ? null : `${path}: ${a} vs ${b}`;
		return Math.abs(a - b) <= 1e-9 * Math.max(scale, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = sameValue(a[i], b[i], `${path}[${i}]`, scale, volume);
			if (d) return d;
		}
		return null;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const ra = a as Record<string, unknown>;
		const rb = b as Record<string, unknown>;
		const demand = Math.min(...[ra.demandM3Day, rb.demandM3Day, ra.avgDemandM3Day, rb.avgDemandM3Day].filter((v): v is number => typeof v === 'number').map(Math.abs));
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) {
			const isVolume = /M3|Mm3|Ls$/.test(k);
			const ofDemand = /^fraction|Fraction$/.test(k) && demand > 0 && Number.isFinite(demand);
			const d = sameValue(ra[k], rb[k], `${path}.${k}`, isVolume ? volume : ofDemand ? volume / demand : scale, volume);
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
		d ??= sameValue(ca.series[k]?.values, cb.series[k]?.values, `series ${k}`, scale, scale);
	}
	d ??= sameValue({ ...ca, series: null }, { ...cb, series: null }, 'output', 1, scale);
	return d ? `order invariance (seed ${seed}${shared ? ', transfer order kept' : ''}): ${d}` : null;
}

/**
 * More irrigated land can't leave anyone better supplied. Doubling every crop
 * area never raises any farm's supply fraction (avg supplied / avg demand), nor
 * the catchment's Σ supplied / Σ demand.
 *
 * This is a law only without return flow, so both runs set every
 * returnFlowPct to 0. With return flow it can fail legitimately: a farm that
 * doubles its draw on stored water that would otherwise have stayed in its dam
 * returns part of it to the river, and a starved farm downstream gets more
 * than twice the water (found by the soak, seed 4660: 25.43 % → 25.72 %).
 * Without return flow extra use upstream can only lower the water available
 * downstream on every later day, which is what the property relies on.
 * Demand is not rounded (R1), so it doubles exactly and the only slack is
 * float noise.
 */
export function checkDoubledCropAreas(input: ModelInput): string | null {
	const base = cloneInput(input);
	for (const n of base.model.nodes) n.returnFlowPct = 0;
	const x = cloneInput(base);
	for (const a of x.model.cropAreas) a.areaM2 *= 2;
	let o1: ModelOutput;
	let o2: ModelOutput;
	try {
		o1 = runModel(base);
		o2 = runModel(x);
	} catch (e) {
		return `doubled crop areas threw ${(e as Error).message}`;
	}
	const slack = 1e-12;
	const before = new Map(o1.summary.farms.map((f) => [f.nodeId, f]));
	for (const f2 of o2.summary.farms) {
		const f1 = before.get(f2.nodeId)!;
		if (!(f1.avgDemandM3Day > 0)) continue;
		if (f2.fractionSupplied > f1.fractionSupplied + slack)
			return `doubling crop areas raised ${f2.nodeId}'s supply fraction ${f1.fractionSupplied} → ${f2.fractionSupplied}`;
	}
	const tot = (o: ModelOutput) => o.summary.farms.reduce((s, f) => [s[0]! + f.avgDemandM3Day, s[1]! + f.avgSuppliedM3Day], [0, 0]);
	const [d1, s1] = tot(o1);
	const [d2, s2] = tot(o2);
	if (!(d1! > 0) || !(d2! > 0)) return null;
	const c1 = s1! / d1!;
	const c2 = s2! / d2!;
	return c2 > c1 + slack ? `doubling crop areas raised the catchment supply fraction ${c1} → ${c2}` : null;
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
	return checkOrderInvariance(input, out, seed) ?? checkDoubledCropAreas(input);
}
