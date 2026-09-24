// Physical invariants of a model run. runModel runs them on every run and
// reports the result in summary.verification (./verify.ts); the random-network
// fuzz tests (../run.invariants.test.ts), the example catchments (backend) and
// the client catchment (when data/ is present) assert them. Each check returns the first broken
// property as text, or null. They state what must hold for *any* sound water
// balance (mass conservation, bounds, limits honoured, totals that add up),
// not what the workbook happens to produce, so they stay valid when the
// algorithms change. See docs/model.md §6 "Verification".
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { defaultProjectSettings, type CurtailmentFarm, type EwrComplianceGrid, type ModelInput, type ModelOutput } from '../project';

const SEC_PER_DAY = 86_400;
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);

type SeriesMap = Map<string, number[]>;
const seriesMap = (out: ModelOutput): SeriesMap => new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));

/**
 * Daily balance identities and bounds, every node, every day:
 * - every value finite (observed flow may be NaN on missing days);
 * - routed inflow = Σ upstream outflow (gauges pass it through);
 * - farm balance H + I + J + Q[t−1] = U + G − T + Q (T = return flow
 *   β·(1 − e)·G, audit N1);
 * - 0 ≤ storage ≤ capacity, spill only from a full dam, 0 ≤ supplied ≤ demand,
 *   deficit = demand − supplied, EWR shortfall = MIN(U − Z, 0) ≤ 0;
 * - transfers net to zero across farms each day;
 * - the catchment balance closes over the run: opening storage + runoff =
 *   outflow + consumptive use + closing storage.
 */
const GAPPY_SERIES = new Set(['observed_flow', 'rain_final', 'rain_chirps', 'rain_chirps_corrected', 'chirps_factor']);

export function checkBalance(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	for (const s of out.series) {
		// Inputs shown as they are: a missing day is NaN (a gap), never a made-up value.
		if (GAPPY_SERIES.has(s.key)) continue;
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
		// Series looked up once per node, not per day: this runs on every saved run.
		const upU = ups.map((u) => get.get(`${u.id}|outflow`)!);
		const upAAs = ups.map((u) => get.get(`${u.id}|ewr_shortfall`)!);
		const routed = n.kind === 'gauge' ? U : get.get(`${n.id}|inflow_upstream`)!;
		for (let t = 0; t < out.days; t++) {
			let H = 0;
			for (const a of upU) H += a[t]!;
			if (Math.abs(routed[t]! - H) > tol(H))
				return `${n.id} day ${t}: routed inflow ${H} ≠ upstream sum`;
		}
		if (n.kind === 'gauge') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`)!;
		const [F, G, W, H, I, J, Q, R, AA, Z, ABs] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_cumulative', 'ewr_shortfall_incremental'].map(g) as number[][];
		// The engine keeps full precision (docs/engine-audit.md R1): no rounding here either.
		const cap = n.damCapacityM3;
		let qPrev = n.damInitialPct * cap;
		totIn += qPrev;
		// Return flow: the share β of the application losses (1 − e)·G (audit N1).
		const returnPerSupplied = n.lossReturnFraction * (1 - n.irrigationEfficiency);
		for (let t = 0; t < out.days; t++) {
			const T = G![t]! * returnPerSupplied;
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
			let upAA = 0;
			let upAbs = 0;
			for (const a of upAAs) {
				upAA += a[t]!;
				upAbs += Math.abs(a[t]!);
			}
			const AB = ABs![t]!;
			const abNoise = noise + 1e-12 * upAbs;
			if (AB > 0 || Math.abs(AB - Math.min(AA![t]! - upAA, 0)) > tol(upAA) + abNoise) return `${where}: incremental EWR shortfall ${AB} ≠ MIN(${AA![t]} − ${upAA}, 0)`;
			totIn += I![t]!;
			totOut += G![t]! - T;
			qPrev = Q![t]!;
		}
		totOut += qPrev;
	}
	const sim = get.get('null|simulated_outflow')!;
	const outletU = get.get(`${outlet.id}|outflow`)!;
	const farmJ = nodes.filter((n) => n.kind === 'farm').map((n) => get.get(`${n.id}|transfer`)!);
	const catEwr = get.get('null|ewr')!;
	const catShort = get.get('null|ewr_shortfall')!;
	for (let t = 0; t < out.days; t++) {
		if (sim[t] !== outletU[t]) return `day ${t}: simulated outflow ≠ outlet node outflow`;
		totOut += sim[t]!;
		let Jsum = 0;
		for (const a of farmJ) Jsum += a[t]!;
		if (Math.abs(Jsum) > 1e-6) return `day ${t}: transfers do not net to 0 (${Jsum})`;
		const e = catEwr[t]!;
		const sh = catShort[t]!;
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
 *   today's outgoing rules (never below 0); a rule's reserve is the source
 *   dam's capacity × MAX(the rule's minimum, the dam's minimum operating level);
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
		// The source keeps the rule's minimum or its dam's minimum operating level, whichever is higher (audit Q5).
		rules.push({ from: a.id, to: b.id, months: new Set(tr.months), maxDaily: Math.max(0, maxDaily), reserve: a.damCapacityM3 * Math.max(tr.minStoragePct, a.damMinPct) });
	}
	const farms = input.model.nodes.filter((n) => n.kind === 'farm');
	const d0 = toEpochDay(out.startDate);
	const storage = (id: string, t: number) => {
		if (t > 0) return get.get(`${id}|dam_storage`)![t - 1]!;
		const n = byId.get(id)!;
		return n.damInitialPct * n.damCapacityM3;
	};
	// Per calendar month, the active rules and each farm's incoming and outgoing
	// ones, worked out once rather than every day.
	const byMonth = Array.from({ length: 13 }, (_, month) => {
		const active = rules.filter((r) => r.months.has(month));
		return { active, ins: farms.map((f) => active.filter((r) => r.to === f.id)), outs: farms.map((f) => active.filter((r) => r.from === f.id)) };
	});
	const farmJ = farms.map((f) => get.get(`${f.id}|transfer`)!);
	for (let t = 0; t < out.days; t++) {
		const month = monthOfEpochDay(d0 + t);
		const { active, ins: insOf, outs: outsOf } = byMonth[month]!;
		for (const [fi, f] of farms.entries()) {
			const J = farmJ[fi]![t]!;
			const ins = insOf[fi]!;
			const outs = outsOf[fi]!;
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
		for (const [fi, f] of farms.entries()) {
			const outs = outsOf[fi]!;
			if (outs.length === 0 || insOf[fi]!.length) continue;
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

	// EWR agreement with the observed record: it counts every observed day once,
	// the model side is exactly the outlet test, and the breakdowns add back up.
	const ag = out.summary.catchment.ewrAgreement;
	const obsSeries = get.get('null|observed_flow');
	if (ag) {
		if (!obsSeries) return 'EWR agreement without an observed_flow series';
		const shortDaily = get.get('null|ewr_shortfall')!;
		let observed = 0;
		let modelBelow = 0;
		for (let t = 0; t < out.days; t++) {
			if (!Number.isFinite(obsSeries[t]!)) continue;
			observed++;
			if (shortDaily[t]! < 0) modelBelow++;
		}
		const o = ag.overall;
		if (ag.days + ag.excludedDays !== observed || o.days !== ag.days) return `EWR agreement: ${ag.days} days counted, ${observed} observed`;
		if (o.bothBelow + o.falseAlarm + o.miss + o.bothAbove !== o.days) return 'EWR agreement: the 2×2 cells do not add up to its days';
		if (o.bothBelow + o.falseAlarm !== modelBelow) return `EWR agreement: model below on ${o.bothBelow + o.falseAlarm} days, the outlet test on ${modelBelow}`;
		for (const k of ['days', 'bothBelow', 'falseAlarm', 'miss', 'bothAbove'] as const) {
			if (sum(ag.byMonth.map((m) => m[k])) !== o[k] || sum(ag.byWaterYear.map((y) => y[k])) !== o[k]) return `EWR agreement: ${k} by month / water year ≠ overall`;
		}
	} else if (obsSeries) {
		return 'EWR agreement missing although the run has a gauge or logger record';
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
	// An absent setting runs the engine's default model, as runModel does.
	const legacy = (input.settings.runoffModel ?? defaultProjectSettings().runoffModel) === 'legacy';
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

/**
 * A farm's intermediate columns (verify/columns.ts) follow their formulas and
 * add up to the published ones, so the export can be trusted for redoing a
 * day by hand:
 * - crop requirement F = MAX(0, gross demand) − effective rain used, F ≥ 0
 *   (checkSoilWater checks where the effective rain used came from), and the
 *   abstraction demand D = F / e (audit N1);
 * - the splits conserve water: K + L = H, M + N = I, with 0 ≤ K ≤ H × % and
 *   0 ≤ M ≤ I × %; 0 ≤ O ≤ MIN(diversion capacity, L + N);
 * - G = MIN(MAX(Q[t−1] + M + O + K + J − dead storage, 0), D): irrigation
 *   takes what is above the minimum operating level, up to demand (Q5);
 * - P = Q[t−1] + M + O + K + J − G, Q = MIN(P, capacity), R = MAX(P − capacity, 0);
 * - S = L + N − O, T = β·(1 − e)·G, U = R + S + T;
 * - V is the recomputed balance residual and is float noise.
 */
export function checkWorkings(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const keys = ['gross_demand', 'effective_rain', 'crop_requirement', 'demand', 'supplied', 'inflow_upstream', 'runoff', 'transfer', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam', 'diverted_to_dam', 'interim_storage', 'dam_storage', 'spill', 'below_dam_not_diverted', 'return_flow', 'outflow', 'balance_residual'];
		const cols = keys.map(g);
		const missing = keys.find((_, i) => !cols[i]);
		if (missing) return `${n.id}: working column ${missing} missing`;
		const [gross, eff, F, D, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V] = cols as number[][];
		const e = n.irrigationEfficiency;
		const returnPerSupplied = n.lossReturnFraction * (1 - e);
		const cap = n.damCapacityM3;
		const dead = n.damMinPct * cap;
		let qPrev = n.damInitialPct * cap;
		const near = (a: number, b: number, scale: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b), scale));
		for (let t = 0; t < out.days; t++) {
			const gr = gross![t]!, ef = eff![t]!, f = F![t]!, d = D![t]!, gg = G![t]!, h = H![t]!, i = I![t]!, j = J![t]!, k = K![t]!, l = L![t]!, m = M![t]!;
			const nn = N![t]!, o = O![t]!, p = P![t]!, q = Q![t]!, r = R![t]!, ss = S![t]!, tt = T![t]!, u = U![t]!, v = V![t]!;
			const where = `${n.id} day ${t}`;
			if (!near(f, Math.max(0, gr) - ef, Math.max(Math.abs(gr), Math.abs(ef))) || f < 0)
				return `${where}: crop requirement ${f} ≠ MAX(0, gross ${gr}) − effective rain used ${ef}`;
			if (!near(d, f / e, f)) return `${where}: demand ${d} ≠ crop requirement ${f} ÷ efficiency ${e}`;
			if (!near(k + l, h, 0) || k < 0 || k > h * n.pctUpstreamToDam + tol(h)) return `${where}: upstream split K ${k} + L ${l} ≠ H ${h}`;
			if (!near(m + nn, i, 0) || m < 0 || m > i * n.pctRunoffToDam + tol(i)) return `${where}: runoff split M ${m} + N ${nn} ≠ I ${i}`;
			if (o < 0 || o > Math.min(n.divertCapacityM3Day, l + nn) + tol(l + nn)) return `${where}: diverted ${o} outside [0, MIN(capacity, L + N)]`;
			const avail = qPrev + m + o + k + j;
			if (!near(gg, Math.min(Math.max(avail - dead, 0), d), Math.max(Math.abs(qPrev), m, o, k, Math.abs(j), dead, d)))
				return `${where}: supplied ${gg} ≠ MIN(MAX(Q[t−1] + M + O + K + J − dead storage ${dead}, 0), D ${d})`;
			if (!near(p, avail - gg, Math.max(Math.abs(qPrev), m, o, k, Math.abs(j), gg))) return `${where}: interim storage ${p} ≠ Q[t−1] + M + O + K + J − G`;
			if (!near(q, Math.min(p, cap), cap) || !near(r, Math.max(p - cap, 0), cap)) return `${where}: storage ${q} / spill ${r} don't split interim storage ${p} at capacity ${cap}`;
			if (!near(ss, l + nn - o, Math.max(l, nn, o))) return `${where}: below-dam flow S ${ss} ≠ L + N − O`;
			if (!near(tt, gg * returnPerSupplied, 0)) return `${where}: return flow ${tt} ≠ β·(1 − e)·G = G × ${returnPerSupplied}`;
			if (!near(u, r + ss + tt, Math.max(r, ss, tt))) return `${where}: outflow ${u} ≠ R + S + T`;
			const vv = h + i + j - (gg - tt) - (q - qPrev) - u;
			const scale = Math.max(Math.abs(h), Math.abs(i), Math.abs(j), Math.abs(gg), Math.abs(q), Math.abs(qPrev), Math.abs(u));
			if (Math.abs(v - vv) > tol(scale) || Math.abs(v) > tol(scale)) return `${where}: balance check V ${v} (recomputed ${vv}) is not float noise`;
			qPrev = q;
		}
	}
	return null;
}

/**
 * Each farm's soil-water store (N3, engine ≥ 0.14.0, ../demand.ts
 * farmDailyDemand), redone from the run's own rain (rain_final, zeroed at or
 * below the threshold) and settings, every day:
 * - 0 ≤ store ≤ its size (effectiveRainStoreMm);
 * - effective rain used = MIN(store[t−1] + Pe, MAX(0, gross)) ≥ 0, so it
 *   never takes more than the store held plus the day's effective rain Pe;
 * - store = MIN(size, store[t−1] + Pe − used): nothing appears from nowhere;
 * - over the run, Σ used ≤ Σ Pe: the store hands out no more rain than fell.
 * A run from before engine 0.14.0 has no soil_water column: nothing to check.
 */
export function checkSoilWater(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const d = defaultProjectSettings();
	const s = input.settings ?? {};
	const fraction = typeof s.effectiveRainFraction === 'number' ? s.effectiveRainFraction : d.effectiveRainFraction;
	const size = s.effectiveRainStoreMm;
	// runModel falls back to the default for a size that isn't one (and warns).
	const sizeMm = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : d.effectiveRainStoreMm;
	const thr = (s.calibration as { rainThresholdMm?: number } | undefined)?.rainThresholdMm ?? d.calibration.rainThresholdMm;
	const rainFinal = get.get('null|rain_final');
	const rain = Array.from({ length: out.days }, (_, t) => {
		const v = rainFinal?.[t];
		return typeof v === 'number' && Number.isFinite(v) && v > thr ? v : 0;
	});
	const cropIds = new Set(input.model.crops.map((c) => c.id));
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const W = get.get(`${n.id}|soil_water`);
		if (!W) continue;
		const used = get.get(`${n.id}|effective_rain`);
		const gross = get.get(`${n.id}|gross_demand`);
		if (!used || !gross) return `${n.id}: effective rain or gross demand column missing`;
		let area = 0;
		for (const ca of input.model.cropAreas) if (ca.nodeId === n.id && cropIds.has(ca.cropId)) area += ca.areaM2;
		const toM3 = area / 1000;
		const sizeM3 = sizeMm * toM3;
		let prev = 0;
		let sumUsed = 0;
		let sumPe = 0;
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const w = W[t]!;
			const u = used[t]!;
			const pe = area * (fraction / 1000) * rain[t]!;
			const available = prev + pe;
			const scale = Math.max(available, Math.abs(gross[t]!), sizeM3);
			if (w < -tol(sizeMm) || w > sizeMm + tol(sizeMm)) return `${where}: soil-water store ${w} mm outside 0 … ${sizeMm} mm`;
			if (u < 0 || Math.abs(u - Math.min(available, Math.max(0, gross[t]!))) > tol(scale))
				return `${where}: effective rain used ${u} ≠ MIN(store ${prev} + effective rain ${pe}, gross ${gross[t]}) m³`;
			const wM3 = w * toM3;
			if (Math.abs(wM3 - Math.min(sizeM3, available - u)) > tol(scale))
				return `${where}: soil-water store ${wM3} m³ ≠ MIN(size ${sizeM3}, ${prev} + ${pe} − ${u})`;
			sumUsed += u;
			sumPe += pe;
			prev = wM3;
		}
		if (sumUsed > sumPe + tol(sumPe)) return `${n.id}: effective rain used ${sumUsed} m³ over the run > effective rain ${sumPe} m³`;
	}
	return null;
}

/** Every per-run invariant. */
export function checkInvariants(input: ModelInput, out: ModelOutput): string | null {
	return (
		checkBalance(input, out) ??
		checkWorkings(input, out) ??
		checkSoilWater(input, out) ??
		checkRunoffBalance(input, out) ??
		checkTransferLimits(input, out) ??
		checkReportTotals(input, out)
	);
}
