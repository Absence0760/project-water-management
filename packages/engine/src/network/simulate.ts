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
	returnFlowPct: number;
	/** Daily net irrigation demand (F); zeros for gauges. */
	demand: Float64Array;
	/** Gross demand before effective rain and the rain offset taken off it (m³/day); only needed for workings. */
	grossDemand?: Float64Array;
	rainOffset?: Float64Array;
}

export interface PlanTransfer {
	from: number;
	to: number;
	/** activeMonth[m] for calendar month m (1–12). */
	activeMonth: Uint8Array;
	/** Source storage kept back: dam capacity × min storage %. */
	reserveM3: number;
	/** Most that can move in one day (m³). */
	maxDailyM3: number;
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
}

/** Per-node daily results. Gauges fill inflowUpstream/outflow/ewrCumulative/ewrShortfall only. */
export interface NodeResult {
	demand: Float64Array; // F
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
	rainOffset: Float64Array; // cropped area × effective fraction × rain
	upstreamToDam: Float64Array; // K
	upstreamBelowDam: Float64Array; // L
	runoffToDam: Float64Array; // M
	runoffBelowDam: Float64Array; // N
	divertedToDam: Float64Array; // O
	interimStorage: Float64Array; // P
	belowDamNotDiverted: Float64Array; // S
	returnFlow: Float64Array; // T
	/** V, signed: (H + I + J) − G·(1 − returnPct) − (Q[t] − Q[t−1]) − U. Float noise only. */
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
		upstreamToDam: f(),
		upstreamBelowDam: f(),
		runoffToDam: f(),
		runoffBelowDam: f(),
		divertedToDam: f(),
		interimStorage: f(),
		belowDamNotDiverted: f(),
		returnFlow: f(),
		balanceResidual: f()
	};
}

export function simulateNetwork(plan: NetworkPlan, opts: { workings?: boolean } = {}): NetworkResult {
	const { days, nodes, order, upstream, transfers, month, naturalFlow, ewr } = plan;
	const res = nodes.map(() => allocNode(days));
	const work = opts.workings ? nodes.map((n) => (n.kind === 'farm' ? allocWorkings(n, days) : null)) : null;
	const trOut = transfers.map(() => new Float64Array(days));
	const jToday = new Float64Array(nodes.length);
	// Volume already committed today by earlier transfers from each source dam.
	const drawnToday = new Float64Array(nodes.length);

	for (let t = 0; t < days; t++) {
		// [Transfers] "Draw from dam": uses the source dam's storage at the end of
		// the previous day (Q, row N-1), so all transfers can be settled first.
		jToday.fill(0);
		drawnToday.fill(0);
		for (let k = 0; k < transfers.length; k++) {
			const tr = transfers[k]!;
			if (!tr.activeMonth[month[t]!]) continue;
			const prev = t === 0 ? nodes[tr.from]!.initialStorageM3 : res[tr.from]!.storage[t - 1]!;
			// fGetTrfVolCapped: MIN(MAX(Qprev − cap × min%, 0), capMax), with Qprev
			// reduced by what earlier rules already took from this dam today. The
			// workbook caps each rule against the full Qprev, so two rules from one
			// dam could overdraw it (docs/engine-review.md F1, quirk Q18); rules
			// are served in document order. Identical for a single rule per dam.
			const v = Math.min(Math.max(prev - drawnToday[tr.from]! - tr.reserveM3, 0), tr.maxDailyM3);
			drawnToday[tr.from]! += v;
			trOut[k]![t] = v;
			jToday[tr.to]! += v;
			jToday[tr.from]! -= v;
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
			const avail = qPrev + M + O + K + J;
			const G = Math.min(avail, F);
			const P = avail - G;
			const cap = node.damCapacityM3;
			const Q = Math.min(P, cap);
			const Rr = Math.max(P - cap, 0);
			const S = L + N - O;
			const T = G * node.returnFlowPct;
			const U = Rr + S + T;
			const Y = ewrT * node.share;
			const Z = Y + sumZ;
			// AA = MIN(U − Z, 0) and AB = MIN(AA − Σ upstream AA, 0), with float
			// noise of the volumes involved reported as 0 (review F8).
			const scale = Math.max(U, Z, absAA);
			const AA = shortfall(U, Z, scale);
			const AB = shortfall(AA, sumAA, scale);

			r.demand[t] = F;
			r.supplied[t] = G;
			r.inflowUpstream[t] = H;
			r.runoff[t] = I;
			r.transfer[t] = J;
			r.storage[t] = Q;
			r.spill[t] = Rr;
			r.outflow[t] = U;
			r.deficit[t] = F - G;
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
				w.balanceResidual[t] = H + I + J - (G - T) - (Q - qPrev) - U;
			}
		}
	}
	return { nodes: res, transfers: trOut, ...(work ? { workings: work } : {}) };
}
