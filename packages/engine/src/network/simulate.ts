// Daily network water balance — port of the b023 Element sheets (FarmTemplate
// / GaugeTemplate, formula row 17) plus [Transfers], [Fragmented flow] and
// [Fragmented EWR]. Column letters in comments are the FarmTemplate columns;
// see ./README.md for the full mapping and the workbook quirks we mirror.
import { excelRound, WBT_PRECISION } from './round';

export interface PlanNode {
	kind: 'farm' | 'gauge';
	/** Fraction of natural flow / EWR generated on this farm's land. */
	share: number;
	/** b023 "Upstream inflow above dam (%)" — see README: it drives the *below-dam* split (L). */
	pctUpstreamToDam: number;
	pctRunoffToDam: number;
	divertCapacityM3Day: number;
	/** Dam capacity, already rounded to whole m³ like the Element sheet's P14. */
	damCapacityM3: number;
	/** Storage on the day before the first simulated day. */
	initialStorageM3: number;
	returnFlowPct: number;
	/** Daily net irrigation demand (F); zeros for gauges. */
	demand: Float64Array;
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

export interface NetworkResult {
	nodes: NodeResult[];
	/** Volume moved by each transfer per day (m³). */
	transfers: Float64Array[];
}

const R0 = (x: number) => excelRound(x, 0);

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

export function simulateNetwork(plan: NetworkPlan): NetworkResult {
	const { days, nodes, order, upstream, transfers, month, naturalFlow, ewr } = plan;
	const res = nodes.map(() => allocNode(days));
	const trOut = transfers.map(() => new Float64Array(days));
	const jToday = new Float64Array(nodes.length);
	const fragDigits = WBT_PRECISION.fragmentedM3Day;

	for (let t = 0; t < days; t++) {
		// [Transfers] "Draw from dam": uses the source dam's storage at the end of
		// the previous day (Q, row N-1), so all transfers can be settled first.
		jToday.fill(0);
		for (let k = 0; k < transfers.length; k++) {
			const tr = transfers[k]!;
			if (!tr.activeMonth[month[t]!]) continue;
			const prev = t === 0 ? nodes[tr.from]!.initialStorageM3 : res[tr.from]!.storage[t - 1]!;
			// fGetTrfVolCapped: MIN(MAX(Qprev − cap × min%, 0), capMax)
			const v = Math.min(Math.max(prev - tr.reserveM3, 0), tr.maxDailyM3);
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
			for (let u = 0; u < ups.length; u++) {
				const ur = res[ups[u]!]!;
				sumU += ur.outflow[t]!;
				sumZ += ur.ewrCumulative[t]!;
				sumAA += ur.ewrShortfall[t]!;
			}

			if (node.kind === 'gauge') {
				// GaugeTemplate: G = Σ upstream U, H = Σ upstream Z, I = Σ upstream AA.
				r.inflowUpstream[t] = sumU;
				r.outflow[t] = sumU;
				r.ewrCumulative[t] = sumZ;
				r.ewrShortfall[t] = sumAA;
				continue;
			}

			const F = node.demand[t]!;
			const H = sumU;
			const I = excelRound(nat * node.share, fragDigits);
			const J = jToday[i]!;
			const L = R0(H * node.pctUpstreamToDam);
			const K = H - L;
			const M = R0(I * node.pctRunoffToDam);
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
			const T = R0(G * node.returnFlowPct);
			const U = Rr + S + T;
			const Y = excelRound(ewrT * node.share, fragDigits);
			const Z = Y + sumZ;
			const AA = Math.min(U - Z, 0);
			const AB = Math.min(AA - sumAA, 0);

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
		}
	}
	return { nodes: res, transfers: trOut };
}
