// Daily network water balance — port of the b023 Element sheets (FarmTemplate
// / GaugeTemplate, formula row 17) plus [Transfers], [Fragmented flow] and
// [Fragmented EWR]. Column letters in comments are the FarmTemplate columns;
// see ./README.md for the full mapping and the workbook quirks we mirror.
// Unlike the workbook nothing is rounded: every split conserves water exactly
// (docs/engine-audit.md R1).

/**
 * Relative size of float noise treated as zero in a shortfall. A difference
 * of large volumes (outflow − requirement, or a shortfall minus its upstream
 * shortfalls) that is exact in real arithmetic comes out as ±1e-16 of the
 * volumes involved; 1e-12 of them is far below anything measurable (0.01 m³
 * on a 10⁹ m³/day requirement) and far above the noise.
 */
export const SHORTFALL_NOISE = 1e-12;

/**
 * MIN(a − b, 0) with float noise reported as 0: the result is negative only
 * when it exceeds SHORTFALL_NOISE × `scale` (the largest magnitude that went
 * into a and b). Without this a residue of −4.8e-7 m³ counted as a day the
 * EWR was not met, and whether it appeared depended on the order upstream
 * values were summed in (engine review F8).
 */
export function shortfall(a: number, b: number, scale: number): number {
	const d = a - b;
	return d < -SHORTFALL_NOISE * scale ? d : 0;
}

export interface PlanNode {
	kind: 'farm' | 'gauge';
	/** Fraction of natural flow / EWR generated on this farm's land. */
	share: number;
	/** Share of the upstream inflow (H) that enters the dam (K); the rest passes below it (L). Engine ≥ 0.9.0 (model.md §3 Q1). */
	pctUpstreamToDam: number;
	pctRunoffToDam: number;
	divertCapacityM3Day: number;
	/** Dam capacity (m³). */
	damCapacityM3: number;
	/** Storage on the day before the first simulated day. */
	initialStorageM3: number;
	/**
	 * Dead storage: capacity × the dam's minimum operating level (engine ≥
	 * 0.16.0, audit Q5). Irrigation draws only the storage above it, and
	 * transfers keep at least this much in the source dam.
	 */
	deadStorageM3: number;
	/** Irrigation application efficiency e, 0 < e ≤ 1 (audit N1): abstraction demand D = F / e. */
	irrigationEfficiency: number;
	/** Share β of the application losses (1 − e)·G that returns to the river the same day (audit N1). */
	lossReturnFraction: number;
	/**
	 * Dam surface area when full (m²), as entered or estimated (capacity ÷ 3 m
	 * mean depth); the area on a day is A = full × (Q[t−1] / capacity)^b
	 * (engine ≥ 0.16.0, audit N2). 0 for a node without a dam.
	 */
	damAreaFullM2: number;
	/** Exponent b of the area–storage relation (Liebe et al. 2005: 0.7). */
	damAreaExponent: number;
	/** Seepage per day as a fraction of the storage at the start of the day (audit N2). */
	damSeepagePerDay: number;
	/** Daily crop water requirement (F, net irrigation need); zeros for gauges. */
	demand: Float64Array;
	/**
	 * Gross demand before effective rain, the effective rain used against it
	 * (m³/day) and the soil-water store at the end of the day (mm); only
	 * needed for workings (../demand.ts farmDailyDemand).
	 */
	grossDemand?: Float64Array;
	rainOffset?: Float64Array;
	soilWater?: Float64Array;
}

export interface PlanTransfer {
	from: number;
	to: number;
	/** activeMonth[m] for calendar month m (1–12). */
	activeMonth: Uint8Array;
	/** Source storage kept back: dam capacity × MAX(min storage %, the dam's minimum operating level). */
	reserveM3: number;
	/** Most that can move in one day (m³). */
	maxDailyM3: number;
	/**
	 * Lower moves first (engine ≥ 0.16.0, audit Q18). Rules of equal priority
	 * share the water pro rata, so the list order never matters.
	 */
	priority: number;
}

export interface NetworkPlan {
	days: number;
	nodes: PlanNode[];
	order: Int32Array;
	/**
	 * upstream[i] = nodes draining directly into node i, in a fixed order
	 * (runModel uses node-id order) so sums over them don't depend on how the
	 * nodes are listed.
	 */
	upstream: Int32Array[];
	transfers: PlanTransfer[];
	/** Calendar month (1–12) of each day. */
	month: Uint8Array;
	/** Catchment natural flow, m³/day. */
	naturalFlow: Float64Array;
	/** Unfragmented pragmatic EWR at the outflow, m³/day. */
	ewr: Float64Array;
	/**
	 * Open-water evaporation depth per day (mm): lake factor × A-pan for the
	 * month ÷ days in the month (engine ≥ 0.16.0, audit N2). Absent = none.
	 */
	lakeEvapMmDay?: Float64Array;
	/** Rain falling on a dam's surface per day (mm): the day's rain before any threshold (audit N2). Absent = none. */
	damRainMm?: Float64Array;
}

/** Per-node daily results. Gauges fill inflowUpstream/outflow/ewrCumulative/ewrShortfall only. */
export interface NodeResult {
	/** Abstraction demand D = F / e (engine ≥ 0.16.0, audit N1). */
	demand: Float64Array;
	/** Crop water requirement F (net irrigation need). */
	cropRequirement: Float64Array;
	supplied: Float64Array; // G
	inflowUpstream: Float64Array; // H
	runoff: Float64Array; // I
	transfer: Float64Array; // J
	storage: Float64Array; // Q
	spill: Float64Array; // R
	outflow: Float64Array; // U
	deficit: Float64Array; // W
	ewr: Float64Array; // Y
	ewrCumulative: Float64Array; // Z
	ewrShortfall: Float64Array; // AA
	ewrShortfallIncremental: Float64Array; // AB
}

/**
 * A farm's intermediate columns (model.md §2.7), recorded only when asked
 * (simulateNetwork(plan, { workings: true })) so calibration's thousands of
 * runs don't pay for them. They let a user redo any day by hand.
 */
export interface FarmWorkings {
	grossDemand: Float64Array; // before effective rain
	rainOffset: Float64Array; // effective rain used: MIN(soil store + today's effective rain, gross)
	soilWater: Float64Array; // soil-water store at the end of the day (mm)
	upstreamToDam: Float64Array; // K
	upstreamBelowDam: Float64Array; // L
	runoffToDam: Float64Array; // M
	runoffBelowDam: Float64Array; // N
	divertedToDam: Float64Array; // O
	interimStorage: Float64Array; // P
	belowDamNotDiverted: Float64Array; // S
	returnFlow: Float64Array; // T = β·(1 − e)·G
	/** Dam surface area at the start of the day (m²), audit N2. */
	damArea: Float64Array;
	/** Open-water evaporation from the dam, after the clamp (m³/day). */
	damEvaporation: Float64Array;
	/** Rain falling on the dam's surface (m³/day). */
	rainOnDam: Float64Array;
	/** Seepage out of the dam, after the clamp (m³/day); it joins the outflow U. */
	damSeepage: Float64Array;
	/** V, signed: (H + I + J + rain on dam) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U. Float noise only. */
	balanceResidual: Float64Array;
}

export interface NetworkResult {
	nodes: NodeResult[];
	/** Per node when simulated with { workings: true } (gauges get none). */
	workings?: (FarmWorkings | null)[];
	/** Volume moved by each transfer per day (m³). */
	transfers: Float64Array[];
}

function allocNode(days: number): NodeResult {
	const f = () => new Float64Array(days);
	return {
		demand: f(),
		cropRequirement: f(),
		supplied: f(),
		inflowUpstream: f(),
		runoff: f(),
		transfer: f(),
		storage: f(),
		spill: f(),
		outflow: f(),
		deficit: f(),
		ewr: f(),
		ewrCumulative: f(),
		ewrShortfall: f(),
		ewrShortfallIncremental: f()
	};
}

function allocWorkings(node: PlanNode, days: number): FarmWorkings {
	const f = () => new Float64Array(days);
	return {
		grossDemand: node.grossDemand ?? node.demand,
		rainOffset: node.rainOffset ?? f(),
		soilWater: node.soilWater ?? f(),
		upstreamToDam: f(),
		upstreamBelowDam: f(),
		runoffToDam: f(),
		runoffBelowDam: f(),
		divertedToDam: f(),
		interimStorage: f(),
		belowDamNotDiverted: f(),
		returnFlow: f(),
		damArea: f(),
		damEvaporation: f(),
		rainOnDam: f(),
		damSeepage: f(),
		balanceResidual: f()
	};
}

/**
 * A dam's surface area, rain on it, open-water evaporation and seepage today
 * (audit N2), all from yesterday's storage and before any cap: the routing
 * caps evaporation and seepage at what is in the dam once today's transfer
 * has landed, and the transfer room (N4) counts them as they are. Zero for a
 * node without a dam or an empty one.
 */
function damDay(node: PlanNode, qPrev: number, t: number, lakeEvapMmDay: Float64Array | undefined, damRainMm: Float64Array | undefined): { A: number; Pd: number; E: number; Sp: number } {
	const cap = node.damCapacityM3;
	if (!(cap > 0 && qPrev > 0)) return { A: 0, Pd: 0, E: 0, Sp: 0 };
	const A = node.damAreaFullM2 * Math.pow(Math.min(qPrev / cap, 1), node.damAreaExponent);
	return {
		A,
		Pd: damRainMm ? (damRainMm[t]! * A) / 1000 : 0,
		E: lakeEvapMmDay ? (lakeEvapMmDay[t]! * A) / 1000 : 0,
		Sp: node.damSeepagePerDay * qPrev
	};
}

export function simulateNetwork(plan: NetworkPlan, opts: { workings?: boolean } = {}): NetworkResult {
	const { days, nodes, order, upstream, transfers, month, naturalFlow, ewr, lakeEvapMmDay, damRainMm } = plan;
	const res = nodes.map(() => allocNode(days));
	const work = opts.workings ? nodes.map((n) => (n.kind === 'farm' ? allocWorkings(n, days) : null)) : null;
	const trOut = transfers.map(() => new Float64Array(days));
	const jToday = new Float64Array(nodes.length);
	// Volume already committed today by earlier transfers from each source dam,
	// and already scheduled into each destination.
	const drawnToday = new Float64Array(nodes.length);
	const intoToday = new Float64Array(nodes.length);
	// Transfer rules by priority, lowest first (audit Q18).
	const levels = [...new Set(transfers.map((tr) => tr.priority))].sort((a, b) => a - b).map((p) => transfers.flatMap((tr, k) => (tr.priority === p ? [k] : [])));
	const want = new Float64Array(transfers.length);
	const sumBy = new Float64Array(nodes.length);
	const freeBy = new Float64Array(nodes.length);

	for (let t = 0; t < days; t++) {
		// [Transfers] "Draw from dam": uses the storage at the end of the
		// previous day (Q, row N-1), so all transfers are settled before any farm
		// irrigates, the source's own irrigation included (quirk Q3: the source
		// doesn't irrigate first). Each rule moves
		//   v = MAX(0, MIN(source free, destination room, max daily))
		// with source free = Q_src[t−1] − drawn today − reserve and destination
		// room = cap_dst − (Q_dst[t−1] + rain on it − evaporation − seepage)
		// + D_dst[t] − scheduled into it today, so a transfer never pumps into a
		// full dam only to spill, and one to a farm with no dam still serves its
		// demand (audit N4). The dam's own gains and losses today (N2) count:
		// they follow yesterday's storage alone, so they are known before the
		// transfer, and a room that ignored them left a leaking dam short of
		// its demand by a fixed volume while the source had water to spare,
		// which a larger demand would have hidden (engine 0.19.0; fuzz seed
		// 921, "doubling crop areas raised the supply fraction"). Rules run by priority,
		// lowest first (Q18); within a priority, rules into one destination share
		// its room and rules from one source share its free water, each pro rata
		// to its own limit, so the result never depends on the list order.
		jToday.fill(0);
		drawnToday.fill(0);
		intoToday.fill(0);
		const prevQ = (n: number) => (t === 0 ? nodes[n]!.initialStorageM3 : res[n]!.storage[t - 1]!);
		for (const level of levels) {
			// 1. Each active rule's own limit: its daily cap and its source's free water.
			for (const k of level) {
				const tr = transfers[k]!;
				if (!tr.activeMonth[month[t]!]) {
					want[k] = 0;
					continue;
				}
				const free = prevQ(tr.from) - drawnToday[tr.from]! - tr.reserveM3;
				want[k] = Math.max(0, Math.min(free, tr.maxDailyM3));
			}
			// 2. Rules into one destination share its room, pro rata to their limits.
			sumBy.fill(0);
			for (const k of level) sumBy[transfers[k]!.to]! += want[k]!;
			for (const k of level) {
				const tr = transfers[k]!;
				const total = sumBy[tr.to]!;
				const dst = nodes[tr.to]!;
				const q = prevQ(tr.to);
				const loss = damDay(dst, q, t, lakeEvapMmDay, damRainMm);
				const room = Math.max(0, dst.damCapacityM3 - (q + loss.Pd - loss.E - loss.Sp) + dst.demand[t]! / dst.irrigationEfficiency - intoToday[tr.to]!);
				if (total > room) want[k] = (want[k]! * room) / total;
			}
			// 3. Rules from one source share its free water, pro rata (the most a rule of this priority may leave it).
			sumBy.fill(0);
			freeBy.fill(0);
			for (const k of level) {
				const tr = transfers[k]!;
				sumBy[tr.from]! += want[k]!;
				if (tr.activeMonth[month[t]!]) freeBy[tr.from] = Math.max(freeBy[tr.from]!, prevQ(tr.from) - drawnToday[tr.from]! - tr.reserveM3);
			}
			for (const k of level) {
				const tr = transfers[k]!;
				const total = sumBy[tr.from]!;
				const free = freeBy[tr.from]!;
				if (total > free) want[k] = (want[k]! * free) / total;
			}
			// 4. Move the water.
			for (const k of level) {
				const tr = transfers[k]!;
				const v = want[k]!;
				trOut[k]![t] = v;
				drawnToday[tr.from]! += v;
				intoToday[tr.to]! += v;
				jToday[tr.to]! += v;
				jToday[tr.from]! -= v;
			}
		}

		const nat = naturalFlow[t]!;
		const ewrT = ewr[t]!;
		for (let oi = 0; oi < order.length; oi++) {
			const i = order[oi]!;
			const node = nodes[i]!;
			const r = res[i]!;
			const ups = upstream[i]!;
			let sumU = 0;
			let sumZ = 0;
			let sumAA = 0;
			// Magnitude of the upstream shortfalls, the scale of their float noise.
			let absAA = 0;
			for (let u = 0; u < ups.length; u++) {
				const ur = res[ups[u]!]!;
				sumU += ur.outflow[t]!;
				sumZ += ur.ewrCumulative[t]!;
				sumAA += ur.ewrShortfall[t]!;
				absAA += Math.abs(ur.ewrShortfall[t]!);
			}

			if (node.kind === 'gauge') {
				// GaugeTemplate: G = Σ upstream U, H = Σ upstream Z. The shortfall is
				// the gauge's own flow against its own requirement, like a farm's AA.
				// The workbook sums the branches' AA (I = Σ upstream AA), which
				// reports a shortfall at a confluence whose flow meets the EWR when
				// one branch is short and another has water to spare (audit G1).
				r.inflowUpstream[t] = sumU;
				r.outflow[t] = sumU;
				r.ewrCumulative[t] = sumZ;
				r.ewrShortfall[t] = shortfall(sumU, sumZ, Math.max(sumU, sumZ));
				continue;
			}

			const F = node.demand[t]!;
			// Abstraction demand: the crop requirement plus the application losses (audit N1).
			const D = F / node.irrigationEfficiency;
			const H = sumU;
			const I = nat * node.share;
			const J = jToday[i]!;
			// The percentage is the share of upstream inflow that enters the dam
			// (K); the rest passes below it (L), where the diversion capacity (O)
			// can still take some back. The b023 formula had it the other way
			// round (L = H × %), against its own label and [Models] sheet; the
			// client confirmed the label's meaning (engine 0.9.0, model.md §3 Q1).
			// A split never exceeds the volume it splits.
			const K = Math.min(H * node.pctUpstreamToDam, H);
			const L = H - K;
			const M = Math.min(I * node.pctRunoffToDam, I);
			const N = I - M;
			const O = Math.min(node.divertCapacityM3Day, L + N);
			const qPrev = t === 0 ? node.initialStorageM3 : r.storage[t - 1]!;
			// Dam losses and gains before irrigation (audit N2). The surface area
			// follows yesterday's storage, A = A_full × (Q[t−1] / cap)^b; rain on
			// that surface is a gain, open-water evaporation and seepage losses.
			// Evaporation takes at most what is there (yesterday's storage, the
			// rain and today's net transfer, which was settled first), seepage at
			// most what evaporation leaves, so storage stays ≥ 0.
			const cap = node.damCapacityM3;
			const day = damDay(node, qPrev, t, lakeEvapMmDay, damRainMm);
			const A = day.A;
			const Pd = day.Pd;
			// A transfer out never takes more than yesterday's storage, so this is ≥ 0 up to float noise.
			const there = Math.max(qPrev + Pd + J, 0);
			const E = Math.min(day.E, there);
			const Sp = Math.min(day.Sp, there - E);
			const qStart = qPrev + Pd - E - Sp;
			const avail = qStart + M + O + K + J;
			// Irrigation draws only what is above the dam's minimum operating
			// level (dead storage, audit Q5); a dam below it supplies nothing.
			const G = Math.min(Math.max(avail - node.deadStorageM3, 0), D);
			const P = avail - G;
			const Q = Math.min(P, cap);
			const Rr = Math.max(P - cap, 0);
			const S = L + N - O;
			// The crop gets e·G; of the losses (1 − e)·G, the share β returns below the farm (audit N1).
			const T = node.lossReturnFraction * (1 - node.irrigationEfficiency) * G;
			// Seepage leaves the dam below the wall and joins the outflow the same day (N2).
			const U = Rr + S + T + Sp;
			const Y = ewrT * node.share;
			const Z = Y + sumZ;
			// AA = MIN(U − Z, 0) and AB = MIN(AA − Σ upstream AA, 0), with float
			// noise of the volumes involved reported as 0 (review F8).
			const scale = Math.max(U, Z, absAA);
			const AA = shortfall(U, Z, scale);
			const AB = shortfall(AA, sumAA, scale);

			r.demand[t] = D;
			r.cropRequirement[t] = F;
			r.supplied[t] = G;
			r.inflowUpstream[t] = H;
			r.runoff[t] = I;
			r.transfer[t] = J;
			r.storage[t] = Q;
			r.spill[t] = Rr;
			r.outflow[t] = U;
			r.deficit[t] = D - G;
			r.ewr[t] = Y;
			r.ewrCumulative[t] = Z;
			r.ewrShortfall[t] = AA;
			r.ewrShortfallIncremental[t] = AB;
			const w = work?.[i];
			if (w) {
				w.upstreamToDam[t] = K;
				w.upstreamBelowDam[t] = L;
				w.runoffToDam[t] = M;
				w.runoffBelowDam[t] = N;
				w.divertedToDam[t] = O;
				w.interimStorage[t] = P;
				w.belowDamNotDiverted[t] = S;
				w.returnFlow[t] = T;
				w.damArea[t] = A;
				w.damEvaporation[t] = E;
				w.rainOnDam[t] = Pd;
				w.damSeepage[t] = Sp;
				w.balanceResidual[t] = H + I + J + Pd - (G - T) - E - (Q - qPrev) - U;
			}
		}
	}
	return { nodes: res, transfers: trOut, ...(work ? { workings: work } : {}) };
}
