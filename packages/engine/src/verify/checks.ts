// Physical invariants of a model run. runModel runs them on every run and
// reports the result in summary.verification (./verify.ts); the random-network
// fuzz tests (../run.invariants.test.ts), the example catchments (backend) and
// the client catchment (when data/ is present) assert them. Each check returns the first broken
// property as text, or null. They state what must hold for *any* sound water
// balance (mass conservation, bounds, limits honoured, totals that add up),
// not what the workbook happens to produce, so they stay valid when the
// algorithms change. See docs/model.md §6 "Verification".
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { excludedDayMask, exclusionRanges, sanitizeExclusions } from '../calibrate/provenance';
import { boreholeOf, boreholesByNode, type PlanBorehole } from '../network/boreholes';
import { demandFactorOf } from '../demand';
import { curveAreaAt, resolveDamCurve, resolveRelease, seepageReturnOf } from '../network/dam';
import { landCoverReduction, lowFlowThreshold, resolveLandCover } from '../network/landcover';
import { flowShares } from '../network/shares';
import { supplyOf, type PlanSupply } from '../network/supply';
import { DAM_AREA_EXPONENT, defaultProjectSettings, ESTIMATED_DAM_DEPTH_M, type CurtailmentFarm, type EwrComplianceGrid, type ModelInput, type ModelOutput } from '../project';

const SEC_PER_DAY = 86_400;
const tol = (x: number) => 1e-6 + 1e-9 * Math.abs(x);

type SeriesMap = Map<string, number[]>;
const seriesMap = (out: ModelOutput): SeriesMap => new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));

/**
 * Daily balance identities and bounds, every node, every day:
 * - every value finite (observed flow may be NaN on missing days, the Reserve
 *   rule requirement outside complete months);
 * - routed inflow = Σ upstream outflow (gauges pass it through);
 * - farm balance H + I + J + rain on dam + Q[t−1] = U + G − T + evaporation
 *   + Q (T = return flow β·(1 − e)·G, audit N1; rain on the dam and
 *   evaporation from it, audit N2; seepage is part of U, less the share lost
 *   from the catchment, WP-3.5, which is a loss here), each loss ≥ 0;
 * - 0 ≤ storage ≤ capacity, spill only from a full dam, 0 ≤ supplied ≤ demand,
 *   deficit = demand − supplied, EWR shortfall = MIN(U − Z, 0) ≤ 0;
 * - transfers net to zero across farms each day;
 * - the catchment balance closes over the run: opening storage + runoff =
 *   outflow + consumptive use + closing storage.
 */
// ewr_rule (engine ≥ 0.21.0) is NaN outside complete calendar months: a part
// month at either end of the run is not assessed against the Reserve rules.
const GAPPY_SERIES = new Set(['observed_flow', 'observed_flow_other', 'rain_final', 'rain_chirps', 'rain_chirps_corrected', 'chirps_factor', 'ewr_rule']);

export function checkBalance(input: ModelInput, out: ModelOutput): string | null {
	const bores = boreholesByNode(input.model, []);
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
		if (n.kind === 'user') {
			const bad = checkUserDay(n, bores.get(n.id) ?? [], toEpochDay(out.startDate), get, ups.map((u) => u.id), out.days);
			if (bad) return bad;
			const G = get.get(`${n.id}|supplied`)!;
			const T = get.get(`${n.id}|return_flow`)!;
			const GW = get.get(`${n.id}|groundwater_used`);
			const DEP = get.get(`${n.id}|baseflow_depletion`);
			for (let t = 0; t < out.days; t++) {
				totOut += G[t]! - T[t]! + (DEP?.[t] ?? 0);
				totIn += GW?.[t] ?? 0;
			}
			continue;
		}
		const g = (k: string) => get.get(`${n.id}|${k}`)!;
		const [F, G, W, H, I, J, Q, R, AA, Z, ABs] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'runoff', 'transfer', 'dam_storage', 'spill', 'ewr_shortfall', 'ewr_cumulative', 'ewr_shortfall_incremental'].map(g) as number[][];
		// The engine keeps full precision (docs/engine-audit.md R1): no rounding here either.
		const cap = n.damCapacityM3;
		let qPrev = n.damInitialPct * cap;
		totIn += qPrev;
		// Return flow: the share β of the application losses (1 − e)·G (audit N1).
		const returnPerSupplied = n.lossReturnFraction * (1 - n.irrigationEfficiency);
		// Rain on the dam and evaporation from it (audit N2); runs before engine 0.16.0 have neither.
		const Pd = get.get(`${n.id}|rain_on_dam`);
		const Ev = get.get(`${n.id}|dam_evaporation`);
		const Sp = get.get(`${n.id}|dam_seepage`);
		// Seepage lost from the catchment (WP-3.5): present only when a share of it is.
		const SPL = get.get(`${n.id}|dam_seepage_lost`);
		// Boreholes (WP-1.34, WP-3.9): groundwater comes in with the supply and into the dam, stream depletion leaves with the river.
		const GW = get.get(`${n.id}|groundwater_used`);
		const GD = get.get(`${n.id}|groundwater_to_dam`);
		const DEP = get.get(`${n.id}|baseflow_depletion`);
		for (let t = 0; t < out.days; t++) {
			const T = G![t]! * returnPerSupplied;
			const pd = Pd?.[t] ?? 0;
			const ev = Ev?.[t] ?? 0;
			const gw = (GW?.[t] ?? 0) + (GD?.[t] ?? 0);
			const dep = DEP?.[t] ?? 0;
			const spl = SPL?.[t] ?? 0;
			const lhs = H![t]! + I![t]! + J![t]! + qPrev + pd + gw;
			const rhs = U[t]! + G![t]! - T + Q![t]! + ev + dep + spl;
			const where = `${n.id} day ${t}`;
			if (Math.abs(lhs - rhs) > tol(lhs)) return `${where}: farm balance ${lhs} ≠ ${rhs}`;
			if (spl < 0 || spl > (Sp?.[t] ?? 0) + tol(spl)) return `${where}: seepage lost ${spl} outside [0, seepage ${Sp?.[t]}]`;
			if (pd < 0 || ev < 0 || (Sp?.[t] ?? 0) < 0) return `${where}: rain on dam ${pd}, evaporation ${ev} and seepage ${Sp?.[t]} must be ≥ 0`;
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
			totIn += I![t]! + pd + gw;
			totOut += G![t]! - T + ev + dep + spl;
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

/**
 * The checks' own replay of a node's borehole supply order (WP-1.34, WP-3.9,
 * docs/model.md §2.7d), from the day's published columns: primary units to
 * the crop first, then the units that pump into the dam (primary fill it,
 * supplemental add what it lacks for the demand left, emergency fill it while
 * triggered; never above capacity), then the dam and river, then supplemental
 * and triggered emergency units. Each unit pumps at most MIN(capacity, its
 * annual cap − what it pumped since 1 October). A farm's river pump (WP-3.8,
 * `river` what it may take today) is part of the surface: before the dam
 * under rules 1 and 2, after it under run of river (rule 3); a supplemental
 * dam-target unit fills only for the demand the river leaves. Call it once
 * per day, in order.
 */
function boreholeReplay(b: PlanBorehole | undefined, day0: number) {
	const used = b ? b.units.map(() => 0) : [];
	const units = b?.units ?? [];
	const ks = units.map((_, k) => k);
	const primary = ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 1);
	const toDam = ks.filter((k) => units[k]!.toDam);
	const later = [...ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 0), ...ks.filter((k) => !units[k]!.toDam && units[k]!.mode === 2)];
	return (t: number, D: number, qPrev: number, avail: number, dead: number, cap: number, river = 0, rule: PlanSupply['rule'] = 1) => {
		if (monthOfEpochDay(day0 + t) === 10 && (t === 0 || monthOfEpochDay(day0 + t - 1) !== 10)) used.fill(0);
		const pump = (k: number, want: number) => {
			const u = units[k]!;
			const v = Math.max(0, Math.min(u.capacityM3Day, u.annualCapM3 - used[k]!, want));
			used[k]! += v;
			return v;
		};
		let direct = 0;
		for (const k of primary) direct += pump(k, D - direct);
		let dam = 0;
		const left = rule !== 3 ? D - direct - Math.min(river, D - direct) : D - direct;
		for (const k of toDam) {
			const u = units[k]!;
			const room = cap - avail - dam;
			const want = u.mode === 1 ? room : u.mode === 2 ? (qPrev < u.triggerM3 ? room : 0) : left - (avail + dam - dead);
			dam += pump(k, Math.min(want, room));
		}
		const fromDam = Math.max(avail + dam - dead, 0);
		let surface: number;
		let fromRiver: number;
		if (rule === 3) {
			surface = Math.min(fromDam, D - direct);
			fromRiver = Math.max(0, Math.min(river, D - direct - surface));
		} else {
			fromRiver = Math.max(0, Math.min(river, D - direct));
			surface = Math.min(fromDam, D - direct - fromRiver);
		}
		for (const k of later) if (units[k]!.mode === 0 || qPrev < units[k]!.triggerM3) direct += pump(k, D - surface - fromRiver - direct);
		return { direct, dam, surface, river: fromRiver };
	};
}

/**
 * One other water user's day (WP-1.33, docs/model.md §2.7c): it takes
 * 0 ≤ G ≤ D from what reaches it, G = MIN(D, H) when senior and
 * MIN(D, MAX(0, H − Zs)) when junior (Zs = the senior requirement passing it);
 * it returns T = r × G; U = H − G + T; deficit = D − G; its EWR shortfall is
 * MIN(U − Z, 0) with Z the upstream requirement (it has no share of its own);
 * a senior user takes its demand out of the senior requirement below it.
 */
function checkUserDay(n: ModelInput['model']['nodes'][number], own: NonNullable<ModelInput['model']['boreholes']>, day0: number, get: SeriesMap, ups: string[], days: number): string | null {
	const g = (k: string) => get.get(`${n.id}|${k}`);
	const [D, G, W, H, U, T, Z, AA] = ['demand', 'supplied', 'deficit', 'inflow_upstream', 'outflow', 'return_flow', 'ewr_cumulative', 'ewr_shortfall'].map(g);
	if (!D || !G || !W || !H || !U || !T || !Z || !AA) return `${n.id}: user series missing`;
	const r = Math.min(Math.max(Number.isFinite(n.userReturnPct) ? n.userReturnPct! : 0, 0), 1);
	const senior = (n.userPriority ?? 'senior') !== 'junior';
	const Zs = g('senior_requirement');
	const upZs = ups.map((u) => get.get(`${u}|senior_requirement`));
	// Boreholes (WP-1.34): G = river take + groundwater; the river part follows the priority rule.
	const GW = g('groundwater_used');
	const DEP = g('baseflow_depletion');
	const bore = boreholeOf(n, own, []).borehole;
	const replay = boreholeReplay(bore, day0);
	for (let t = 0; t < days; t++) {
		const where = `${n.id} day ${t}`;
		let zIn = 0;
		for (const a of upZs) zIn += a?.[t] ?? 0;
		const h = H[t]!;
		const d = D[t]!;
		const gw = GW?.[t] ?? 0;
		const dep = DEP?.[t] ?? 0;
		const river = senior ? h : Math.max(0, h - zIn);
		// Primary boreholes pump first; otherwise the river goes first and groundwater tops it up.
		const rp = replay(t, d, 0, river, 0, 0);
		const wantGw = rp.direct;
		const want = rp.surface + wantGw;
		if (G[t]! < 0 || G[t]! > d + tol(d) || Math.abs(G[t]! - want) > tol(Math.max(h, d, zIn))) return `${where}: user took ${G[t]} ≠ MIN(demand ${d}, ${senior ? 'inflow' : 'inflow − senior requirement'} ${senior ? h : h - zIn})${bore ? ` + groundwater ${wantGw}` : ''}`;
		if (Math.abs(gw - wantGw) > tol(d)) return `${where}: user pumped ${gw} ≠ ${wantGw} (borehole rule)`;
		if (Math.abs(W[t]! - (d - G[t]!)) > tol(d)) return `${where}: user deficit ≠ demand − taken`;
		if (Math.abs(T[t]! - r * G[t]!) > tol(G[t]!)) return `${where}: user return ${T[t]} ≠ ${r} × taken ${G[t]}`;
		if (Math.abs(U[t]! - (h - (G[t]! - gw) + T[t]! - dep)) > tol(Math.max(h, gw))) return `${where}: user balance: outflow ${U[t]} ≠ inflow ${h} − taken from the river ${G[t]! - gw} + returned ${T[t]} − depletion ${dep}`;
		const noise = 1e-12 * Math.max(Math.abs(U[t]!), Math.abs(Z[t]!));
		if (AA[t]! > 0 || Math.abs(AA[t]! - Math.min(U[t]! - Z[t]!, 0)) > tol(U[t]!) + noise) return `${where}: EWR shortfall ${AA[t]}`;
		if (Zs && (Zs[t]! < 0 || Zs[t]! > zIn + tol(zIn))) return `${where}: senior requirement ${Zs[t]} below the user outside [0, ${zIn}]`;
	}
	return null;
}

interface Rule {
	from: string;
	to: string;
	months: Set<number>;
	maxDaily: number;
	reserve: number;
	priority: number;
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
 * - room at the destination (audit N4): a farm that sends nothing receives
 *   at most MAX(0, capacity − (yesterday's storage + rain on the dam −
 *   evaporation − seepage) + today's demand D);
 * - no water left on the table: for a source whose rules all go to farms fed
 *   only by it, the volume that left is at least MIN(Σ over its destinations
 *   of MIN(Σ limits into it, its room), yesterday's storage − the highest
 *   reserve).
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
		rules.push({ from: a.id, to: b.id, months: new Set(tr.months), maxDaily: Math.max(0, maxDaily), reserve: a.damCapacityM3 * Math.max(tr.minStoragePct, a.damMinPct), priority: tr.priority ?? 0 });
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
	const farmIndex = new Map(farms.map((f, i) => [f.id, i]));
	const farmD = farms.map((f) => get.get(`${f.id}|demand`)!);
	const farmLoss = farms.map((f) => ['rain_on_dam', 'dam_evaporation', 'dam_seepage'].map((k) => get.get(`${f.id}|${k}`)));
	/**
	 * A destination's room that day (audit N4): capacity − (yesterday's storage
	 * + rain on the dam − evaporation − seepage) + today's demand D (engine ≥
	 * 0.19.0 counts the dam's gains and losses, N2). The reported evaporation
	 * and seepage are capped at what the dam held with the transfer in; on the
	 * days that cap bites the room read here is smaller than the engine's but
	 * still at least capacity + the volume that moved + D, so neither check
	 * below can trip on it.
	 */
	const roomOf = (fi: number, t: number) => {
		const [pd, e, sp] = farmLoss[fi]!.map((v) => v?.[t] ?? 0);
		return farms[fi]!.damCapacityM3 - (storage(farms[fi]!.id, t) + pd! - e! - sp!) + farmD[fi]![t]!;
	};
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
			if (outs.length === 0 && J > 0) {
				const room = roomOf(fi, t);
				if (J > Math.max(0, room) + tol(Math.max(Math.abs(room), J))) return `${where}: received ${J} > its room ${room} (capacity − storage after the dam's gains and losses + demand)`;
			}
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
			// What the destinations could take: per destination MIN(Σ limits into it, its room).
			let limit = 0;
			for (const d of dests) {
				const di = farmIndex.get(d)!;
				limit += Math.min(
					outs.filter((r) => r.to === d).reduce((s, r) => s + r.maxDaily, 0),
					Math.max(0, roomOf(di, t))
				);
			}
			const floor = Math.min(limit, Math.max(prev - Math.max(...outs.map((r) => r.reserve)), 0));
			if (sent < floor - tol(Math.max(floor, prev))) return `${where}: sent only ${sent}; the rules and the destinations' room allowed ${floor} (storage ${prev})`;
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
 *   the EWR charge (unrounded, R1; the incremental shortfall AB before engine
 *   0.17.0); I ≤ H and R ≤ 0; totals are
 *   the column sums; the equitable fraction is ΣI / ΣH; targets redistribute
 *   the supplied water (Σ M = Σ I) and never exceed demand; N = M − I,
 *   the l/s columns are m³/day ÷ 86.4; from engine 0.17.0 (audit Q13)
 *   R_irr + R_store = R, R ≤ R_irr ≤ 0, the supply cut −ΔG ≤ 0, S = N − ΔG,
 *   U = MAX(M − ΔG, 0), the cut beyond the share = MAX(ΔG − M, 0) and
 *   demand left U / H lies in 0–1; before 0.17.0 S = N + R and U = M + R.
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
	// A farm's grid is its EWR charge (engine ≥ 0.17.0, audit Q17); older runs gridded AB.
	const farmEwr = (id: string) => get.get(`${id}|ewr_charge`) ?? get.get(`${id}|ewr_shortfall_incremental`)!;
	for (const g of c.farms) {
		const fs = out.summary.farms.find((f) => f.nodeId === g.nodeId)!;
		const b = grid(g, farmEwr(g.nodeId!), g.nodeId ?? '?', fs.daysEwrNotMet);
		if (b) return b;
	}

	// EWR agreement with the observed record: it counts every observed day once,
	// either scored or left out by a calibration exclusion; on the scored days
	// the model side is exactly the outlet test, and the breakdowns add back up.
	const ag = out.summary.catchment.ewrAgreement;
	const obsSeries = get.get('null|observed_flow');
	if (ag) {
		if (!obsSeries) return 'EWR agreement without an observed_flow series';
		const shortDaily = get.get('null|ewr_shortfall')!;
		const excluded = excludedDayMask(exclusionRanges(sanitizeExclusions(input.settings.calibrationExclusions, [])), out.startDate, out.days);
		let observed = 0;
		let modelBelow = 0;
		for (let t = 0; t < out.days; t++) {
			if (!Number.isFinite(obsSeries[t]!)) continue;
			observed++;
			if (!excluded[t] && shortDaily[t]! < 0) modelBelow++;
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
		// Boreholes (WP-1.34): means present exactly when the farm has them.
		const gwS = get.get(`${f.nodeId}|groundwater_used`);
		if (!!gwS !== (f.avgGroundwaterM3Day !== undefined)) return `farm summary ${f.nodeId}: groundwater mean ${gwS ? 'missing' : 'without boreholes'}`;
		if (gwS && (!close(f.avgGroundwaterM3Day!, sum(gwS) / out.days) || !close(f.avgBaseflowDepletionM3Day!, sum(get.get(`${f.nodeId}|baseflow_depletion`)!) / out.days)))
			return `farm summary ${f.nodeId}: groundwater means differ from the daily series`;
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
		const mH = mean('demand');
		const mI = mean('supplied');
		const mR = sum(farmEwr(row.nodeId), from, to) / n;
		if (!close(row.demandM3Day, mH) || !close(row.suppliedM3Day, mI) || !close(row.ewrShortfallM3Day, mR))
			return `${w}: H/I/R ${row.demandM3Day}/${row.suppliedM3Day}/${row.ewrShortfallM3Day} ≠ window means ${mH}/${mI}/${mR}`;
		// Daily supplied ≤ demand and shortfall ≤ 0, so their means are too (float sums are monotone).
		if (row.ewrShortfallM3Day > 0 || row.suppliedM3Day > row.demandM3Day) return `${w}: shortfall ${row.ewrShortfallM3Day} > 0 or supplied ${row.suppliedM3Day} > demand ${row.demandM3Day}`;
		if (row.targetM3Day > row.demandM3Day || row.targetM3Day < 0) return `${w}: target ${row.targetM3Day} outside [0, demand ${row.demandM3Day}]`;
		const M = row.targetM3Day;
		// Engine ≥ 0.17.0: −ΔG, the supply cut for the EWR (audit Q13).
		const cut = row.ewrSupplyCutM3Day;
		const id = (x: CurtailmentFarm, a: number, b: number, what: string, ...ops: number[]) =>
			close(a, b, 1e-12, Math.max(Math.abs(a), Math.abs(b), ...ops.map(Math.abs))) ? null : `${w}: ${what} (${a} vs ${b}) in ${JSON.stringify(x)}`;
		const e =
			id(row, row.reduceGainM3Day, M - row.suppliedM3Day, 'N ≠ M − I', M, row.suppliedM3Day) ??
			(cut === undefined
				? id(row, row.totalChangeM3Day, row.reduceGainM3Day + row.ewrShortfallM3Day, 'S ≠ N + R', row.reduceGainM3Day, row.ewrShortfallM3Day) ??
					id(row, row.volumeLeftM3Day, M + row.ewrShortfallM3Day, 'U ≠ M + R', M, row.ewrShortfallM3Day)
				: id(row, row.ewrChargeIrrigationM3Day! + row.ewrChargeStorageM3Day!, row.ewrShortfallM3Day, 'R_irr + R_store ≠ R', row.ewrChargeIrrigationM3Day!, row.ewrChargeStorageM3Day!) ??
					id(row, row.totalChangeM3Day, row.reduceGainM3Day + cut, 'S ≠ N − ΔG', row.reduceGainM3Day, cut) ??
					id(row, row.volumeLeftM3Day, Math.max(M + cut, 0), 'U ≠ MAX(M − ΔG, 0)', M, cut) ??
					id(row, row.ewrCutBeyondShareM3Day ?? NaN, Math.max(-cut - M, 0), 'cut beyond share ≠ MAX(ΔG − M, 0)', M, cut) ??
					(row.ewrChargeIrrigationM3Day! > 0 || row.ewrChargeIrrigationM3Day! < row.ewrShortfallM3Day - 1e-12 * Math.abs(row.ewrShortfallM3Day) || cut > 0
						? `${w}: EWR charge ${row.ewrShortfallM3Day}, irrigation part ${row.ewrChargeIrrigationM3Day}, supply cut ${cut}`
						: null) ??
					(row.fractionOfDemandLeft !== null && (row.fractionOfDemandLeft < 0 || row.fractionOfDemandLeft > 1 + 1e-12)
						? `${w}: demand left ${row.fractionOfDemandLeft} outside 0–1`
						: null)) ??
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
	return checkUserReports(input, out, get, from, to);
}

/**
 * Other water users' summaries and curtailment rows (WP-1.33): present exactly
 * when the network has users; whole-run and window means of the daily series;
 * 0 ≤ supplied ≤ demand; a senior user is never cut and keeps its whole
 * charge; a junior user's cut −ΔG = MAX(charge ÷ k, −supplied) ≤ 0 with
 * k = 1 − return share, and the charge left standing = MIN(0, charge − k·cut).
 */
function checkUserReports(input: ModelInput, out: ModelOutput, get: SeriesMap, from: number, to: number): string | null {
	const users = input.model.nodes.filter((n) => n.kind === 'user');
	const sum = (a: number[], a0 = 0, b = a.length - 1) => {
		let x = 0;
		for (let t = a0; t <= b; t++) x += a[t]!;
		return x;
	};
	const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b)) + 1e-12;
	const us = out.summary.users;
	const rows = out.summary.curtailment?.otherUsers;
	if (!users.length) return us || rows ? 'user summaries without user nodes' : null;
	if (!us || !rows || us.length !== users.length || rows.length !== users.length) return 'user summaries missing for the user nodes';
	const n = to - from + 1;
	for (const u of users) {
		const s = us.find((x) => x.nodeId === u.id);
		const row = rows.find((x) => x.nodeId === u.id);
		if (!s || !row) return `user ${u.id}: no summary or curtailment row`;
		const col = (k: string) => get.get(`${u.id}|${k}`)!;
		const [D, G, T, C] = ['demand', 'supplied', 'return_flow', 'ewr_charge'].map(col) as number[][];
		if (!close(s.avgDemandM3Day, sum(D!) / out.days) || !close(s.avgSuppliedM3Day, sum(G!) / out.days) || !close(s.avgReturnedM3Day, sum(T!) / out.days) || !close(s.avgEwrChargeM3Day, -sum(C!) / out.days))
			return `user summary ${u.id}: means differ from the daily series`;
		if (s.fractionSupplied < 0 || s.fractionSupplied > 1 + 1e-12) return `user summary ${u.id}: fraction supplied ${s.fractionSupplied}`;
		const w = `curtailment user ${u.id}`;
		if (!close(row.demandM3Day, sum(D!, from, to) / n) || !close(row.suppliedM3Day, sum(G!, from, to) / n) || !close(row.ewrChargeM3Day, sum(C!, from, to) / n)) return `${w}: window means differ from the daily series`;
		if (row.suppliedM3Day > row.demandM3Day || row.ewrChargeM3Day > 0) return `${w}: supplied ${row.suppliedM3Day} > demand or charge ${row.ewrChargeM3Day} > 0`;
		const k = 1 - Math.min(Math.max(u.userReturnPct ?? 0, 0), 1);
		const senior = (u.userPriority ?? 'senior') !== 'junior';
		const cut = senior || !(k > 0) ? 0 : Math.max(row.ewrChargeM3Day / k, -row.suppliedM3Day);
		if (row.curtailed === senior || !close(row.supplyCutM3Day, cut) || row.supplyCutM3Day > 0) return `${w}: supply cut ${row.supplyCutM3Day} ≠ ${cut} (${senior ? 'senior: not curtailed' : 'junior'})`;
		if (!close(row.uncurtailedChargeM3Day, Math.min(0, row.ewrChargeM3Day - cut * k))) return `${w}: charge left standing ${row.uncurtailedChargeM3Day}`;
		if (!close(row.supplyCutLs, row.supplyCutM3Day / 86.4)) return `${w}: l/s ≠ m³/day ÷ 86.4`;
	}
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
 * - the dam's surface A = A_full × (Q[t−1] / capacity)^b (A_full as entered,
 *   or capacity ÷ 3 m), or linear in the survey curve when there is one
 *   (WP-3.5); rain on it Pd = rain × A / 1000; evaporation
 *   E = MIN(lake factor (that month's, when monthly) × A-pan ÷ days in month
 *   × A / 1000, Q[t−1] + Pd + J), and for b > 1 also ≤ (1 − seepage) ×
 *   Q[t−1] / b (engine 0.21.1; a curve's local b = Q·A′/A);
 *   seepage Sp = MIN(seepage × Q[t−1], Q[t−1] + Pd + J − E) (audit N2), and
 *   S0 = Q[t−1] + Pd − E − Sp is what the day starts from;
 * - the release (WP-3.5) X ≤ the outlet: under pass inflow X = MIN(K + M + O,
 *   required below the dam − S, outlet, S0 + M + O + K + J), the requirement
 *   being the rule's monthly amount or the EWR required at the node (Z);
 *   under fixed X = MIN(the month's amount, outlet, S0 + M + O + K + J −
 *   dead storage), never < 0; no rule, no release column;
 * - G = MIN(MAX(S0 + M + O + K + J − X − dead storage, 0), D): irrigation
 *   takes what is above the minimum operating level, up to demand (Q5);
 * - a farm with a supply rule that pumps from the river (WP-3.8) has the
 *   column river_abstraction Gr, and only such a farm: while it pumps from
 *   the river (always under river first and run of river; under trigger from
 *   the day the start-of-day storage falls below the trigger until the day it
 *   is back at the stop level) Gr = MIN(pump capacity, MAX(0, S − MAX(Zs,
 *   a pass-inflow release's target)), demand) taken before the dam, or after
 *   it under run of river, and 0 otherwise; run of river sends everything
 *   below the dam (K = M = O = 0); the dam gives G − Gr;
 * - P = S0 + M + O + K + J − X − (G − Gr), Q = MIN(P, capacity), R = MAX(P − capacity, 0);
 * - S = L + N − O, T = β·(1 − e)·G, U = R + S − Gr + T + returned seepage + X,
 *   returned seepage = Sp × the seepage return share (WP-3.5), the rest lost;
 * - V is the recomputed balance residual and is float noise.
 */
export function checkWorkings(input: ModelInput, out: ModelOutput): string | null {
	const bores = boreholesByNode(input.model, []);
	const get = seriesMap(out);
	// Open-water evaporation depth per day and the day's rain on a dam (audit N2), from the run's own settings and rain.
	const d0 = defaultProjectSettings();
	const st = input.settings ?? {};
	const lakeK = typeof st.lakeEvapFactor === 'number' && Number.isFinite(st.lakeEvapFactor) && st.lakeEvapFactor >= 0 ? st.lakeEvapFactor : d0.lakeEvapFactor;
	// Monthly lake factors (WP-3.5): used only when all twelve are numbers ≥ 0, as runModel does.
	const lakeM = st.lakeEvapFactorMonthly;
	const lakeMonthly = Array.isArray(lakeM) && lakeM.length === 12 && lakeM.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? lakeM : null;
	const feb = typeof st.februaryDays === 'number' ? st.februaryDays : d0.februaryDays;
	const apan = Array.isArray(st.apanMm) ? st.apanMm.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0)) : [...d0.apanMm];
	const monthLen = [31, 30, 31, 31, feb, 31, 30, 31, 30, 31, 31, 30];
	const day0 = toEpochDay(out.startDate);
	// A daily A-pan series (engine ≥ 0.38.0, issue #45) sets the day's A-pan wherever it has a number ≥ 0.
	const apanSeries = input.series?.evap_apan_mm;
	const apanOffset = apanSeries ? day0 - toEpochDay(apanSeries.startDate) : 0;
	const evapMmDay = Array.from({ length: out.days }, (_, t) => {
		const wy = (monthOfEpochDay(day0 + t) + 2) % 12;
		const k = lakeMonthly ? lakeMonthly[wy]! : lakeK;
		const a = apanSeries && t + apanOffset >= 0 ? apanSeries.values[t + apanOffset] : undefined;
		if (typeof a === 'number' && Number.isFinite(a) && a >= 0) return k * a;
		return (k * (apan[wy] ?? 0)) / monthLen[wy]!;
	});
	const rainFinal = get.get('null|rain_final');
	const damRain = (t: number) => {
		const v = rainFinal?.[t];
		return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
	};
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const keys = ['gross_demand', 'effective_rain', 'crop_requirement', 'demand', 'supplied', 'inflow_upstream', 'runoff', 'transfer', 'upstream_to_dam', 'upstream_below_dam', 'runoff_to_dam', 'runoff_below_dam', 'diverted_to_dam', 'dam_area', 'rain_on_dam', 'dam_evaporation', 'dam_seepage', 'interim_storage', 'dam_storage', 'spill', 'below_dam_not_diverted', 'return_flow', 'outflow', 'balance_residual'];
		const cols = keys.map(g);
		const missing = keys.find((_, i) => !cols[i]);
		if (missing) return `${n.id}: working column ${missing} missing`;
		const [gross, eff, F, D, G, H, I, J, K, L, M, N, O, AREA, PD, EV, SP, P, Q, R, S, T, U, V] = cols as number[][];
		// The senior users' requirement (WP-1.33): present only when a senior user's demand is passed down.
		const ZS = g('senior_requirement');
		const PASSED = g('passed_for_senior');
		if (ZS && !PASSED) return `${n.id}: working column passed_for_senior missing`;
		const upZS = input.model.nodes.filter((u) => u.downstreamNodeId === n.id).map((u) => get.get(`${u.id}|senior_requirement`));
		// Boreholes (WP-1.34, WP-3.9).
		const bore = boreholeOf(n, bores.get(n.id) ?? [], []).borehole;
		const replay = boreholeReplay(bore, day0);
		const GW = g('groundwater_used');
		const GD = g('groundwater_to_dam');
		const DEP = g('baseflow_depletion');
		if (bore && (!GW || !DEP)) return `${n.id}: groundwater columns missing for a farm with boreholes`;
		if (!!GD !== !!bore?.units.some((u) => u.toDam)) return `${n.id}: groundwater_to_dam ${GD ? 'without' : 'missing for'} a borehole that pumps into the dam`;
		if (ZS && upZS.some((a) => !a)) return `${n.id}: an upstream node has no senior_requirement series`;
		// The dam's area–storage relation, as runModel resolves it (audit N2).
		const areaFull = n.damCapacityM3 > 0 ? (n.damAreaFullM2 ?? n.damCapacityM3 / ESTIMATED_DAM_DEPTH_M) : 0;
		// Survey curve, release and seepage destination (WP-3.5).
		const curve = n.damCapacityM3 > 0 ? resolveDamCurve(n) : null;
		const rel = resolveRelease(n, []);
		const REL = g('dam_release');
		const SPL = g('dam_seepage_lost');
		// A farm without a dam has no seepage to split (runModel ignores the share there).
		const seepRet = n.damCapacityM3 > 0 ? seepageReturnOf(n) : 1;
		if (!!rel !== !!REL) return `${n.id}: dam_release column ${REL ? 'without' : 'missing for'} a release rule`;
		// Supply rule and river pump (WP-3.8).
		const sup = supplyOf(n, []).supply;
		const RA = g('river_abstraction');
		if (!!sup !== !!RA) return `${n.id}: river_abstraction column ${RA ? 'without' : 'missing for'} a supply rule that pumps from the river`;
		let onRiver = false;
		if ((seepRet < 1) !== !!SPL) return `${n.id}: dam_seepage_lost column ${SPL ? 'with all seepage returning' : 'missing'}`;
		const Zc = g('ewr_cumulative')!;
		const b = n.damAreaExponent > 0 && n.damAreaExponent <= 3 ? n.damAreaExponent : DAM_AREA_EXPONENT;
		const seep = Math.min(Math.max(Number.isFinite(n.damSeepagePerDay) ? n.damSeepagePerDay : 0, 0), 1);
		const e = n.irrigationEfficiency;
		// The demand factor (engine ≥ 0.41.0, the demand.scale scenario op) scales F after the soil-water store.
		const factor = demandFactorOf(n, []);
		const returnPerSupplied = n.lossReturnFraction * (1 - e);
		const cap = n.damCapacityM3;
		const dead = n.damMinPct * cap;
		let qPrev = n.damInitialPct * cap;
		const near = (a: number, b: number, scale: number) => Math.abs(a - b) <= tol(Math.max(Math.abs(a), Math.abs(b), scale));
		for (let t = 0; t < out.days; t++) {
			const gr = gross![t]!, ef = eff![t]!, f = F![t]!, d = D![t]!, gg = G![t]!, h = H![t]!, i = I![t]!, j = J![t]!, k = K![t]!, l = L![t]!, m = M![t]!;
			const nn = N![t]!, o = O![t]!, p = P![t]!, q = Q![t]!, r = R![t]!, ss = S![t]!, tt = T![t]!, u = U![t]!, v = V![t]!;
			const where = `${n.id} day ${t}`;
			const df = factor ? factor[(monthOfEpochDay(day0 + t) + 2) % 12]! : 1;
			if (!near(f, df * (Math.max(0, gr) - ef), df * Math.max(Math.abs(gr), Math.abs(ef))) || f < 0)
				return `${where}: crop requirement ${f} ≠ ${factor ? `demand factor ${df} × (` : ''}MAX(0, gross ${gr}) − effective rain used ${ef}${factor ? ')' : ''}`;
			if (!near(d, f / e, f)) return `${where}: demand ${d} ≠ crop requirement ${f} ÷ efficiency ${e}`;
			if (!near(k + l, h, 0) || k < 0 || k > h * n.pctUpstreamToDam + tol(h)) return `${where}: upstream split K ${k} + L ${l} ≠ H ${h}`;
			if (!near(m + nn, i, 0) || m < 0 || m > i * n.pctRunoffToDam + tol(i)) return `${where}: runoff split M ${m} + N ${nn} ≠ I ${i}`;
			if (o < 0 || o > Math.min(n.divertCapacityM3Day, l + nn) + tol(l + nn)) return `${where}: diverted ${o} outside [0, MIN(capacity, L + N)]`;
			const area = AREA![t]!, pd = PD![t]!, ev = EV![t]!, sp = SP![t]!;
			const onCurve = curve && cap > 0 && qPrev > 0 ? curveAreaAt(curve, qPrev) : null;
			const a = !(cap > 0 && qPrev > 0) ? 0 : onCurve ? onCurve.area : areaFull * Math.pow(Math.min(qPrev / cap, 1), b);
			if (!near(area, a, a)) return `${where}: dam area ${area} ≠ ${onCurve ? 'the survey curve at' : `A_full ${areaFull} × (`}Q[t−1] ${qPrev}${onCurve ? '' : ` / capacity ${cap})^${b}`}`;
			const pdWant = (damRain(t) * a) / 1000;
			const there = Math.max(qPrev + pdWant + j, 0);
			const evRaw = (evapMmDay[t]! * a) / 1000;
			const limited = onCurve
				? a > 0 && qPrev * onCurve.slope > a
					? Math.min(evRaw, ((1 - seep) * a) / onCurve.slope)
					: evRaw
				: b > 1
					? Math.min(evRaw, ((1 - seep) * qPrev) / b)
					: evRaw;
			const evWant = Math.min(limited, there);
			const spWant = Math.min(seep * qPrev, there - evWant);
			if (!near(pd, pdWant, qPrev) || !near(ev, evWant, qPrev) || !near(sp, spWant, qPrev))
				return `${where}: rain on dam ${pd} / evaporation ${ev} / seepage ${sp} ≠ ${pdWant} / ${evWant} / ${spWant}`;
			const s0 = qPrev + pd - ev - sp;
			if (s0 + j < -tol(qPrev)) return `${where}: the dam losses and transfers take it below empty (${s0 + j})`;
			const avail0 = s0 + m + o + k + j;
			const availScale = Math.max(Math.abs(qPrev), pd, ev, sp, m, o, k, Math.abs(j), dead, d);
			// Release (WP-3.5), before irrigation.
			const x = REL?.[t] ?? 0;
			if (rel) {
				const month = monthOfEpochDay(day0 + t);
				const passing = l + nn - o;
				const want =
					rel.rule === 1
						? Math.max(0, Math.min(m + o + k, (rel.m3DayByMonth ? rel.m3DayByMonth[month]! : Zc[t]!) - passing, rel.outletM3Day, Math.max(avail0, 0)))
						: Math.max(0, Math.min(rel.m3DayByMonth![month]!, rel.outletM3Day, Math.max(avail0, 0) - dead));
				if (x < 0 || x > rel.outletM3Day + tol(x)) return `${where}: release ${x} outside [0, outlet ${rel.outletM3Day}]`;
				if (!near(x, want, availScale)) return `${where}: release ${x} ≠ ${want} (${rel.rule === 1 ? 'pass inflow' : 'fixed'} rule)`;
			}
			const avail = avail0 - x;
			const surface = Math.max(avail - dead, 0);
			const gw = GW?.[t] ?? 0;
			const gd = GD?.[t] ?? 0;
			const dep = DEP?.[t] ?? 0;
			// The river pump (WP-3.8): what it may take today, from the flow below the dam above what must pass it.
			const gRiv = RA?.[t] ?? 0;
			let room = 0;
			let keep = 0;
			if (sup) {
				if (sup.rule === 3 && (k !== 0 || m !== 0 || o !== 0)) return `${where}: run of river has no dam, but K ${k}, M ${m}, O ${o} went into it`;
				onRiver = sup.rule !== 2 || (onRiver ? qPrev < sup.stopM3 : qPrev < sup.triggerM3);
				const month = monthOfEpochDay(day0 + t);
				keep = Math.max(ZS?.[t] ?? 0, rel && rel.rule === 1 ? (rel.m3DayByMonth ? rel.m3DayByMonth[month]! : Zc[t]!) : 0);
				if (onRiver) room = Math.max(0, Math.min(sup.pumpM3Day, ss - keep));
				if (gRiv < 0 || gRiv > sup.pumpM3Day + tol(gRiv)) return `${where}: pumped ${gRiv} from the river, outside [0, pump capacity ${sup.pumpM3Day}]`;
				if (gRiv > Math.max(0, ss - keep) + tol(Math.max(ss, keep))) return `${where}: pumped ${gRiv} from the river, more than the ${ss} below the dam less the ${keep} that must pass`;
			}
			// Boreholes: primary pump first, dam-target ones into the dam, supplemental (and emergency, while the dam is below its trigger) top up what the dam leaves.
			const rp = replay(t, d, qPrev, avail, dead, cap, room, sup?.rule ?? 1);
			let wantGs: number;
			let wantGr = 0;
			if (bore) {
				wantGs = rp.surface;
				wantGr = rp.river;
			} else if (sup && sup.rule === 3) {
				wantGs = Math.min(surface, d);
				wantGr = Math.max(0, Math.min(room, d - wantGs));
			} else {
				wantGr = Math.max(0, Math.min(room, d));
				wantGs = Math.min(surface, d - wantGr);
			}
			if (!near(gRiv, wantGr, Math.max(ss, d, keep))) return `${where}: pumped ${gRiv} from the river ≠ ${wantGr} (supply rule ${sup?.rule}, ${onRiver ? 'on the river' : 'on the dam'})`;
			if (!near(gw, rp.direct, Math.max(availScale, d))) return `${where}: groundwater ${gw} ≠ ${rp.direct} (borehole supply order and caps)`;
			if (!near(gd, rp.dam, Math.max(availScale, d, cap))) return `${where}: groundwater into the dam ${gd} ≠ ${rp.dam}`;
			if (gd > 0 && avail + gd > cap + tol(Math.max(cap, availScale))) return `${where}: pumped ${gd} into a dam with no room for it`;
			if (!near(gg - gw - gRiv, wantGs, Math.max(availScale, gd, gRiv)))
				return `${where}: supplied ${gg} ≠ MIN(MAX(Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J${gd ? ' + groundwater into the dam' : ''} − dead storage ${dead}, 0), D ${d})${bore ? ` + groundwater ${gw}` : ''}${sup ? ` + from the river ${gRiv}` : ''}`;
			if (!near(p, avail + gd - (gg - gw - gRiv), Math.max(availScale, gg, gd))) return `${where}: interim storage ${p} ≠ Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J + groundwater into the dam − what the dam gave`;
			if (!near(q, Math.min(p, cap), cap) || !near(r, Math.max(p - cap, 0), cap)) return `${where}: storage ${q} / spill ${r} don't split interim storage ${p} at capacity ${cap}`;
			if (!near(ss, l + nn - o, Math.max(l, nn, o))) return `${where}: below-dam flow S ${ss} ≠ L + N − O`;
			if (ZS) {
				// Senior users below (WP-1.33): the farm passes MIN(Zs, H + I) below the dam, and keeps nothing back without them.
				let zIn = 0;
				for (const a of upZS) zIn += a![t]!;
				const zs = ZS[t]!;
				const pass = PASSED![t]!;
				if (zs < zIn - tol(zIn)) return `${where}: senior requirement ${zs} below the ${zIn} arriving from upstream`;
				if (ss < Math.min(zs, h + i) - tol(Math.max(h + i, zs))) return `${where}: below-dam flow S ${ss} does not pass the senior requirement MIN(${zs}, H + I)`;
				if (pass < -tol(0) || (zs === 0 && pass !== 0)) return `${where}: kept back ${pass} for a senior requirement of ${zs}`;
			}
			if (!near(tt, gg * returnPerSupplied, 0)) return `${where}: return flow ${tt} ≠ β·(1 − e)·G = G × ${returnPerSupplied}`;
			const spl = SPL?.[t] ?? 0;
			if (!near(spl, sp * (1 - seepRet), sp)) return `${where}: seepage lost ${spl} ≠ seepage ${sp} × (1 − return ${seepRet})`;
			if (!near(u, r + (ss - gRiv) + tt + (sp - spl) + x - dep, Math.max(r, ss, tt, sp, x))) return `${where}: outflow ${u} ≠ R + S${sup ? ' − from the river' : ''} + T + returned seepage${rel ? ' + release' : ''}${bore ? ' − stream depletion' : ''}`;
			const vv = h + i + j + pd + gw + gd - (gg - tt) - ev - (q - qPrev) - u - dep - spl;
			const scale = Math.max(Math.abs(h), Math.abs(i), Math.abs(j), Math.abs(gg), Math.abs(q), Math.abs(qPrev), Math.abs(u), pd, ev, gw, gd);
			if (Math.abs(v - vv) > tol(scale) || Math.abs(v) > tol(scale)) return `${where}: balance check V ${v} (recomputed ${vv}) is not float noise`;
			qPrev = q;
		}
	}
	return null;
}

/**
 * Boreholes and stream depletion (WP-1.34, WP-3.9, docs/model.md §2.7d), on
 * every farm and other user with boreholes:
 * - 0 ≤ groundwater to the crop ≤ supplied, 0 ≤ into the dam, and together
 *   ≤ Σ the pumping units' capacities;
 * - the lag store S[t] = S[t−1] + infeed − due, due = α × (S[t−1] + infeed),
 *   S ≥ 0, starting empty, with the day's infeed between the smallest and the
 *   largest depletion factor × what was pumped;
 * - taken + unmet = due, both ≥ 0, and unmet only when nothing flows out, so
 *   the river never goes negative;
 * - the lag conserves volume: Σ infeed = Σ taken + Σ unmet + S at the end,
 *   and Σ infeed = Σ over the boreholes of d × their volume
 *   (RunSummary.groundwaterAnnualUse);
 * - groundwaterAnnualUse has one row per water year of the run, its volumes
 *   add up to the daily columns and over its boreholes, and no borehole
 *   pumps more than its annual cap in a water year.
 * A node without boreholes has none of these columns or rows.
 */
export function checkGroundwater(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const bores = boreholesByNode(input.model, []);
	const annual = out.summary.groundwaterAnnualUse ?? [];
	const day0 = toEpochDay(out.startDate);
	for (const n of input.model.nodes) {
		const b = boreholeOf(n, bores.get(n.id) ?? [], []).borehole;
		const g = (k: string) => get.get(`${n.id}|${k}`);
		const rows = annual.filter((r) => r.nodeId === n.id);
		if (!b) {
			if (g('groundwater_used') || g('groundwater_to_dam')) return `${n.id}: groundwater series without boreholes`;
			if (rows.length) return `${n.id}: groundwater annual use without boreholes`;
			continue;
		}
		const [GW, DEP, UN, ST, G, U] = ['groundwater_used', 'baseflow_depletion', 'depletion_unmet', 'depletion_store', 'supplied', 'outflow'].map(g);
		if (!GW || !DEP || !UN || !ST || !G || !U) return `${n.id}: groundwater series missing`;
		const GD = g('groundwater_to_dam');
		const capSum = b.units.reduce((s, u) => s + u.capacityM3Day, 0);
		const dMin = Math.min(...b.units.map((u) => u.depletionFrac));
		const dMax = Math.max(...b.units.map((u) => u.depletionFrac));
		let prev = 0;
		let infeed = 0;
		let gone = 0;
		let row = -1;
		let wy = NaN;
		const sums = rows.map(() => ({ days: 0, all: 0, dam: 0, dep: 0 }));
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const gw = GW[t]!;
			const gd = GD?.[t] ?? 0;
			if (gw < 0 || gw > G[t]! + tol(G[t]!) || gd < 0 || gw + gd > capSum + tol(capSum)) return `${where}: groundwater ${gw} outside [0, MIN(Σ capacity ${capSum}, supplied ${G[t]})]${gd ? ` (with ${gd} into the dam)` : ''}`;
			const scale = Math.max(prev, U[t]! + DEP[t]!, gw + gd);
			// One depletion factor: the infeed is d × pumped. Several: it lies between the smallest and largest share of it.
			const inf = dMin === dMax ? dMin * (gw + gd) : ST[t]! + DEP[t]! + UN[t]! - prev;
			if (inf < dMin * (gw + gd) - tol(scale) || inf > dMax * (gw + gd) + tol(scale)) return `${where}: depletion infeed ${inf} outside [${dMin}, ${dMax}] × pumped ${gw + gd}`;
			const inStore = prev + inf;
			const due = b.depletionAlpha * inStore;
			if (DEP[t]! < 0 || UN[t]! < -tol(0) || Math.abs(DEP[t]! + UN[t]! - due) > tol(Math.max(scale, inStore))) return `${where}: depletion ${DEP[t]} + unmet ${UN[t]} ≠ due ${due}`;
			if (Math.abs(ST[t]! - (inStore - due)) > tol(Math.max(scale, inStore)) || ST[t]! < -tol(scale)) return `${where}: depletion store ${ST[t]} ≠ ${inStore - due}`;
			if (U[t]! < -tol(scale)) return `${where}: stream depletion took the river below 0 (outflow ${U[t]})`;
			if (UN[t]! > tol(scale) && U[t]! > tol(scale)) return `${where}: depletion left unmet (${UN[t]}) while ${U[t]} still flowed`;
			infeed += inf;
			gone += DEP[t]! + UN[t]!;
			prev = ST[t]!;
			const y = waterYearOfDay(day0 + t);
			if (y !== wy) {
				wy = y;
				row++;
				if (rows[row]?.waterYear !== y) return `${n.id}: groundwater annual use has no row for water year ${y}`;
			}
			const s = sums[row]!;
			s.days++;
			s.all += gw + gd;
			s.dam += gd;
			s.dep += DEP[t]!;
		}
		if (rows.length !== row + 1) return `${n.id}: groundwater annual use has ${rows.length} rows for ${row + 1} water years`;
		if (Math.abs(infeed - gone - prev) > 1e-9 * Math.max(1, infeed)) return `${n.id}: the depletion lag does not conserve volume: Σ infeed ${infeed} ≠ Σ due ${gone} + still to come ${prev}`;
		let byBorehole = 0;
		for (const [k, r] of rows.entries()) {
			const s = sums[k]!;
			const where = `${n.id} water year ${r.label}`;
			if (r.days !== s.days || Math.abs(r.abstractionM3 - s.all) > tol(s.all) || Math.abs(r.toDamM3 - s.dam) > tol(s.all) || Math.abs(r.streamDepletionM3 - s.dep) > tol(s.dep))
				return `${where}: annual use ${r.abstractionM3} / into the dam ${r.toDamM3} / depletion ${r.streamDepletionM3} over ${r.days} days ≠ the daily columns ${s.all} / ${s.dam} / ${s.dep} over ${s.days}`;
			if (r.boreholes.length !== b.units.length) return `${where}: ${r.boreholes.length} boreholes ≠ ${b.units.length}`;
			let sum = 0;
			for (const [j, u] of r.boreholes.entries()) {
				const unit = b.units[j]!;
				if (u.abstractionM3 < 0 || u.abstractionM3 > unit.capacityM3Day * r.days + tol(unit.capacityM3Day * r.days)) return `${where}: borehole ${u.name} pumped ${u.abstractionM3}, more than its capacity allows`;
				if (u.annualCapM3 !== null && u.abstractionM3 > u.annualCapM3 + tol(u.annualCapM3)) return `${where}: borehole ${u.name} pumped ${u.abstractionM3} over its annual cap ${u.annualCapM3}`;
				sum += u.abstractionM3;
				byBorehole += unit.depletionFrac * u.abstractionM3;
			}
			if (Math.abs(sum - r.abstractionM3) > tol(r.abstractionM3)) return `${where}: the boreholes' ${sum} ≠ the node's ${r.abstractionM3}`;
		}
		if (Math.abs(byBorehole - infeed) > 1e-9 * Math.max(1, infeed)) return `${n.id}: Σ d × each borehole's volume ${byBorehole} ≠ the depletion infeed ${infeed}`;
	}
	for (const r of annual) if (!input.model.nodes.some((n) => n.id === r.nodeId)) return `groundwater annual use for unknown node ${r.nodeId}`;
	return null;
}

/**
 * Land-cover streamflow reductions (WP-1.35, docs/model.md §2.5a), from the
 * run's own natural flow and the model's patches:
 * - a farm with land cover: runoff I + reduction = natural flow × its share,
 *   0 ≤ reduction ≤ that natural runoff, and the reduction is
 *   lowFlow × MIN(I0, q) + mar × MAX(I0 − q, 0) with q = share × the natural
 *   flow exceeded 75 % of the days;
 * - the catchment `landcover_reduction` is the sum over the farms, and the
 *   summary's mean and class split add up to it;
 * - without land cover there is no reduction series or summary.
 */
export function checkLandCover(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const cover = resolveLandCover(input.model, []);
	const total = get.get('null|landcover_reduction');
	const any = cover.some(Boolean);
	if (!any) return total || out.summary.landCover ? 'land-cover reduction reported without land cover' : null;
	if (!total || !out.summary.landCover) return 'land-cover reduction series or summary missing';
	const natural = get.get('null|natural_flow')!;
	const d = defaultProjectSettings();
	const method = ['area', 'hiLo', 'manual'].includes(String(input.settings.flowShareMethod)) ? (input.settings.flowShareMethod as 'area' | 'hiLo' | 'manual') : d.flowShareMethod;
	const share = flowShares(input.model.nodes, method, { ...d.hiLoSplit, ...((input.settings.hiLoSplit as object | undefined) ?? {}) }).share;
	const q0 = lowFlowThreshold(natural);
	if (Math.abs(out.summary.landCover.lowFlowThresholdM3Day - q0) > tol(q0)) return `land-cover low-flow threshold ${out.summary.landCover.lowFlowThresholdM3Day} ≠ ${q0}`;
	const sum = new Float64Array(out.days);
	for (const [i, n] of input.model.nodes.entries()) {
		const u = cover[i];
		const red = get.get(`${n.id}|landcover_reduction`);
		if (!u) {
			if (red) return `${n.id}: land-cover reduction without land cover`;
			continue;
		}
		if (!red) return `${n.id}: land-cover reduction series missing`;
		const I = get.get(`${n.id}|runoff`)!;
		for (let t = 0; t < out.days; t++) {
			const where = `${n.id} day ${t}`;
			const i0 = natural[t]! * share[i]!;
			if (Math.abs(I[t]! + red[t]! - i0) > tol(i0)) return `${where}: runoff ${I[t]} + land-cover reduction ${red[t]} ≠ natural × share ${i0}`;
			const want = landCoverReduction(i0, q0 * share[i]!, u);
			if (red[t]! < 0 || red[t]! > i0 + tol(i0) || Math.abs(red[t]! - want) > tol(i0)) return `${where}: land-cover reduction ${red[t]} ≠ ${want}`;
			sum[t]! += red[t]!;
		}
	}
	let tot = 0;
	for (let t = 0; t < out.days; t++) {
		if (Math.abs(total[t]! - sum[t]!) > tol(sum[t]!)) return `day ${t}: catchment land-cover reduction ${total[t]} ≠ Σ farms ${sum[t]}`;
		tot += total[t]!;
	}
	const lc = out.summary.landCover;
	const mean = out.days ? tot / out.days : 0;
	const byClass = lc.byClass.reduce((a, c) => a + c.reductionM3Day, 0);
	if (Math.abs(lc.reductionM3Day - mean) > 1e-9 * Math.max(1, mean) || Math.abs(byClass - mean) > 1e-9 * Math.max(1, mean)) return `land-cover summary ${lc.reductionM3Day} (classes ${byClass}) ≠ the series mean ${mean}`;
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

/**
 * EWR shortfall attribution (engine ≥ 0.17.0, audit Q17; docs/model.md
 * §2.7b), from the run's own series. Sites are the outlet (the catchment
 * series) and every other gauge.
 * - per site per day: charged + natural = shortfall, both ≤ 0, and a day the
 *   EWR is met has neither;
 * - per farm per day: charge ≤ irrigation part ≤ 0, and the irrigation part is
 *   at most the farm's consumptive irrigation G − T;
 * - per site per day, where no transfer rule crosses the site's catchment
 *   boundary (always at the outlet): with e = H + I + J − U for each farm
 *   upstream, the charged part is MIN(shortfall, Σ MAX(e, 0)), each farm's
 *   share is charged × MAX(e, 0) / Σ MAX(e, 0), and a farm's charge is at
 *   least that share (it carries the largest over its sites) and, when every
 *   site it is upstream of can be recomputed, exactly the largest;
 * - Σ farm charges upstream of a site ≥ the site's charged part.
 * Runs saved before 0.17.0 have no attribution series: nothing to check.
 */
export function checkEwrAttribution(input: ModelInput, out: ModelOutput): string | null {
	const get = seriesMap(out);
	const nodes = input.model.nodes;
	// Farms and other water users (WP-1.33) are charged; gauges only measure.
	const farms = nodes.filter((n) => n.kind !== 'gauge');
	if (farms.length && !get.has(`${farms[0]!.id}|ewr_charge`)) return null;
	const outlet = nodes.find((n) => n.downstreamNodeId === null);
	if (!outlet) return null;
	const sites = [outlet, ...nodes.filter((n) => n.kind === 'gauge' && n !== outlet)];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const ancestors = (site: string) => {
		const set = new Set([site]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const n of nodes) {
				if (n.downstreamNodeId !== null && set.has(n.downstreamNodeId) && !set.has(n.id)) {
					set.add(n.id);
					grew = true;
				}
			}
		}
		return set;
	};
	const rules = input.model.transfers.filter((tr) => tr.enabled && byId.get(tr.fromNodeId)?.kind === 'farm' && byId.get(tr.toNodeId)?.kind === 'farm');
	const col = (id: string, k: string) => get.get(`${id}|${k}`)!;
	const siteInfo = sites.map((s, si) => {
		const up = ancestors(s.id);
		const key = si === 0 ? 'null' : s.id;
		return {
			name: s.id,
			farms: farms.filter((f) => up.has(f.id)),
			// A rule with one end inside: its volume can't be told apart from the farm's other transfers.
			exact: !rules.some((r) => up.has(r.fromNodeId) !== up.has(r.toNodeId)),
			D: get.get(`${key}|ewr_shortfall`)!,
			charged: get.get(`${key}|ewr_charged`),
			natural: get.get(`${key}|ewr_natural`)
		};
	});
	for (const s of siteInfo) if (!s.charged || !s.natural) return `EWR site ${s.name}: no ewr_charged / ewr_natural series`;
	const zeros = new Array<number>(out.days).fill(0);
	const F = new Map(
		farms.map((f) => {
			const user = f.kind === 'user';
			const G = col(f.id, 'supplied');
			const k = user ? 1 - Math.min(Math.max(f.userReturnPct ?? 0, 0), 1) : 1 - f.lossReturnFraction * (1 - f.irrigationEfficiency);
			// A user has no runoff or transfers, and no irrigation-part series (checked as 0).
			return [f.id, { H: col(f.id, 'inflow_upstream'), I: user ? zeros : col(f.id, 'runoff'), J: user ? zeros : col(f.id, 'transfer'), U: col(f.id, 'outflow'), G, R: col(f.id, 'ewr_charge'), Ri: user ? zeros : col(f.id, 'ewr_charge_irrigation'), k }];
		})
	);
	const allExact = new Map(farms.map((f) => [f.id, siteInfo.every((s) => s.exact || !s.farms.includes(f))]));
	const best = new Map<string, number>();
	for (let t = 0; t < out.days; t++) {
		best.clear();
		for (const s of siteInfo) {
			const D = Math.max(-s.D[t]!, 0);
			const ch = -s.charged![t]!;
			const nat = -s.natural![t]!;
			const where = `EWR site ${s.name} day ${t}`;
			if (ch < 0 || nat < 0) return `${where}: charged ${-ch} and natural ${-nat} must be ≤ 0`;
			if (Math.abs(ch + nat - D) > tol(D)) return `${where}: charged ${-ch} + natural ${-nat} ≠ shortfall ${-D}`;
			if (D === 0 && (ch !== 0 || nat !== 0)) return `${where}: the EWR is met but ${-ch} is charged`;
			let sumR = 0;
			for (const f of s.farms) sumR -= F.get(f.id)!.R[t]!;
			if (sumR < ch - tol(ch)) return `${where}: the farms upstream carry ${sumR} in all, less than the ${ch} charged`;
			if (!s.exact || D === 0) continue;
			let E = 0;
			let scale = D;
			const e = s.farms.map((f) => {
				const x = F.get(f.id)!;
				const v = x.H[t]! + x.I[t]! + x.J[t]! - x.U[t]!;
				scale = Math.max(scale, Math.abs(x.H[t]!) + Math.abs(x.I[t]!) + Math.abs(x.J[t]!), Math.abs(x.U[t]!));
				E += Math.max(v, 0);
				return Math.max(v, 0);
			});
			if (Math.abs(ch - Math.min(D, E)) > tol(scale)) return `${where}: charged ${-ch} ≠ MIN(shortfall ${D}, Σ net impact ${E})`;
			s.farms.forEach((f, k) => {
				const A = E > 0 ? (ch * e[k]!) / E : 0;
				best.set(f.id, Math.max(best.get(f.id) ?? 0, A));
			});
			for (const [k, f] of s.farms.entries()) {
				const A = E > 0 ? (ch * e[k]!) / E : 0;
				if (-F.get(f.id)!.R[t]! < A - tol(scale)) return `${f.id} day ${t}: EWR charge ${-F.get(f.id)!.R[t]!} below its share ${A} at site ${s.name}`;
			}
		}
		for (const f of farms) {
			const x = F.get(f.id)!;
			const R = -x.R[t]!;
			const Ri = -x.Ri[t]!;
			const where = `${f.id} day ${t}`;
			if (R < 0 || Ri < 0 || Ri > R + tol(R)) return `${where}: EWR charge ${-R} and its irrigation part ${-Ri} must satisfy charge ≤ irrigation part ≤ 0`;
			if (Ri > x.G[t]! * x.k + tol(x.G[t]!)) return `${where}: irrigation part ${Ri} of the EWR charge > consumptive irrigation ${x.G[t]! * x.k}`;
			if (allExact.get(f.id) && Math.abs(R - (best.get(f.id) ?? 0)) > tol(Math.max(R, x.U[t]!, x.H[t]! + x.I[t]!))) return `${where}: EWR charge ${-R} ≠ its largest share ${best.get(f.id) ?? 0} over the sites below it`;
		}
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
		checkReportTotals(input, out) ??
		checkEwrAttribution(input, out) ??
		checkGroundwater(input, out) ??
		checkLandCover(input, out)
	);
}
