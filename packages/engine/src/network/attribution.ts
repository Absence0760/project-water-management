// Who is charged for an EWR shortfall (engine ≥ 0.17.0, audit Q17; decided on
// a simulated CMA-assessor recommendation, 2026-09-24, pending the real
// assessor and hydrologist). docs/model.md §2.7b has the rule in words.
//
// The EWR is assessed at EWR sites: the catchment outlet and every gauge.
// Per site s and day t:
//   D_s   = MAX(Z_s − U_s, 0)                    the site's shortfall (positive)
//   e_f,s = H + I + J_int − U                    net impact of farm f upstream of s,
//           where J_int counts only the transfers with both ends upstream of s
//           (an export out of s's catchment is charged to its source, an
//           import is credited to its receiver)
//   E_s   = Σ_f MAX(e_f,s, 0)
//   D*_s  = MIN(D_s, E_s)                        charged to farms
//   N_s   = D_s − D*_s                           natural: not caused by use
//   A_f,s = D*_s · MAX(e_f,s, 0) / E_s           (0 when E_s = 0)
// Other water users (engine ≥ 0.22.0, WP-1.33) are charged the same way as
// farms: their net impact is e = H − U = what they take less what they return.
// A farm upstream of several sites carries R_f = max_s A_f,s (not the sum: a
// cut upstream raises the flow at every site below it), and the site that
// sets it is its binding site (on a tie, the most downstream one).
//
// Each farm's charge splits by what the farm can change: c = G − T (its
// consumptive irrigation, G·k with k = 1 − β(1 − e)), o = e − c (storage
// gain and net export), A_irr = A · c / (c + MAX(o, 0)), A_store = A − A_irr.
//
// Outputs keep the engine's shortfall sign: ≤ 0.
import { SHORTFALL_NOISE } from './simulate';

export interface AttributionSite {
	/** Node index of the site: the outlet node, or a gauge. */
	node: number;
	/** The site's daily EWR shortfall, ≤ 0 (the engine's MIN(flow − EWR, 0), noise already 0). */
	shortfall: ArrayLike<number>;
}

export interface AttributionInput {
	days: number;
	/** Farms and other water users (WP-1.33) are charged; gauges only measure. */
	kind: readonly ('farm' | 'gauge' | 'user')[];
	/** upstream[i] = nodes draining directly into node i. */
	upstream: readonly ArrayLike<number>[];
	/**
	 * Calculation order: every node after all of its upstream nodes (the outlet
	 * last). Impacts are summed in it and a tie between sites goes to the
	 * later one, so runModel passes an order that doesn't follow the display
	 * order (./topology.ts canonicalOrder).
	 */
	order: ArrayLike<number>;
	/** Per node, daily: H upstream inflow, I own runoff, U outflow, G supplied. */
	inflow: readonly ArrayLike<number>[];
	runoff: readonly ArrayLike<number>[];
	outflow: readonly ArrayLike<number>[];
	supplied: readonly ArrayLike<number>[];
	/** Per node, daily: Q dam storage at the end of the day (only sizes float noise; omitted = no dams). */
	storage?: readonly ArrayLike<number>[];
	/** Per node: Q the day before day 0, for a run resumed part-way through a record (engine ≥ 1.1.0); omitted = 0. */
	storageBefore?: ArrayLike<number>;
	/** Per node: consumptive share of what is supplied, k = 1 − β(1 − e), so c = G·k = G − T (audit N1). */
	consumptivePerSupplied: ArrayLike<number>;
	/**
	 * Per node, daily consumptive use c = G − T where it isn't G·k: a unit with
	 * demand objects (engine ≥ 1.7.0), whose objects return their own shares.
	 * Omitted (or undefined for a node) = G·k.
	 */
	consumptive?: readonly (ArrayLike<number> | undefined)[];
	/** Each transfer rule's daily volume. */
	transfers: readonly { from: number; to: number; volume: ArrayLike<number> }[];
	/** The EWR sites, the outlet first by convention (any order gives the same result). */
	sites: readonly AttributionSite[];
}

export interface AttributionSiteResult {
	node: number;
	/** Farms whose outflow reaches the site (the site's node itself when it is a farm), in `order`. */
	farms: Int32Array;
	/** −D*_s: the part of the shortfall charged to farms, ≤ 0. */
	charged: Float64Array;
	/** −N_s: the natural part, ≤ 0. charged + natural = the site's shortfall. */
	natural: Float64Array;
}

export interface AttributionResult {
	sites: AttributionSiteResult[];
	/** Per node, −R_f: the farm's charge (max over the sites it is upstream of), ≤ 0; gauges 0. */
	charge: Float64Array[];
	/** Per node, −A_irr: the part of the charge met by irrigating less, charge ≤ it ≤ 0. */
	chargeIrrigation: Float64Array[];
	/** Per node, index into `sites` of the binding site each day; −1 when not charged. */
	binding: Int32Array[];
	/** Only with { perSite: true } (tests): perSite[site][node][t] = −A_f,s. */
	perSite?: Float64Array[][];
}

/**
 * The float residue a volume leaves when a larger one cancels: a few units in
 * the last place (ulp ≈ 2.2e-16 relative), so 1e-14 is about 45 ulp. Used for
 * the dam storage and upstream flows an impact is computed next to. Far below
 * SHORTFALL_NOISE on purpose: 1e-12 of a 10⁶ m³ dam would call a real
 * 1e-6 m³ impact noise (fuzz seeds 9051, 11240, 15426).
 */
const RESIDUE = 1e-14;

/** Two charges within this relative difference are a tie (float noise from summing in another order). */
const TIE = 1e-9;

/** 1 for `node` and every node draining into it, 0 elsewhere. */
function upstreamMask(upstream: readonly ArrayLike<number>[], node: number): Uint8Array {
	const inF = new Uint8Array(upstream.length);
	const stack = [node];
	while (stack.length) {
		const i = stack.pop()!;
		if (inF[i]) continue;
		inF[i] = 1;
		const ups = upstream[i]!;
		for (let u = 0; u < ups.length; u++) stack.push(ups[u]!);
	}
	return inF;
}

/**
 * The units a site charges: the farms and other water users whose outflow
 * reaches `node` (the node itself when it is one), in `order`, so Σ impacts
 * runs in the caller's (canonical) order, not the node array's. The same set
 * as the site's AttributionSiteResult.farms, without the attribution.
 */
export function siteUnits(
	kind: readonly ('farm' | 'gauge' | 'user')[],
	upstream: readonly ArrayLike<number>[],
	order: ArrayLike<number>,
	node: number,
	mask: Uint8Array = upstreamMask(upstream, node)
): Int32Array {
	const farms: number[] = [];
	for (let k = 0; k < order.length; k++) {
		const i = order[k]!;
		if (mask[i] && kind[i] !== 'gauge') farms.push(i);
	}
	return Int32Array.from(farms);
}

export function attributeEwrShortfall(input: AttributionInput, opts: { perSite?: boolean } = {}): AttributionResult {
	const { days, kind, upstream, order, inflow, runoff, outflow, supplied, consumptivePerSupplied, consumptive, transfers } = input;
	const n = kind.length;
	const pos = new Int32Array(n);
	for (let i = 0; i < order.length; i++) pos[order[i]!] = i;

	// Upstream farm sets, and which transfers stay inside each.
	const sites = input.sites.map((site) => {
		const inF = upstreamMask(upstream, site.node);
		const internal = transfers.filter((tr) => inF[tr.from] && inF[tr.to]);
		return { site, farms: siteUnits(kind, upstream, order, site.node, inF), internal };
	});

	const charge = kind.map(() => new Float64Array(days));
	const chargeIrrigation = kind.map(() => new Float64Array(days));
	const binding = kind.map(() => new Int32Array(days).fill(-1));
	const siteOut: AttributionSiteResult[] = sites.map(({ site, farms }) => ({ node: site.node, farms, charged: new Float64Array(days), natural: new Float64Array(days) }));
	const perSite = opts.perSite ? sites.map(() => kind.map(() => new Float64Array(days))) : undefined;

	const storage = input.storage;
	/** A dam's storage today and yesterday: the scale its spill and storage gain are computed at. */
	const before = input.storageBefore;
	const dam = (i: number, t: number) => (storage ? Math.max(Math.abs(storage[i]![t]!), t > 0 ? Math.abs(storage[i]![t - 1]!) : before ? Math.abs(before[i]!) : 0) : 0);
	const jInt = new Float64Array(n);
	const ePlus = new Float64Array(n);
	const eRaw = new Float64Array(n);
	// The binding site's charge and net impact, per farm, today.
	const best = new Float64Array(n);
	const bestE = new Float64Array(n);

	for (let t = 0; t < days; t++) {
		best.fill(0);
		for (let si = 0; si < sites.length; si++) {
			const { site, farms, internal } = sites[si]!;
			const D = Math.max(-site.shortfall[t]!, 0);
			if (!(D > 0)) continue;
			for (const tr of internal) {
				jInt[tr.to]! += tr.volume[t]!;
				jInt[tr.from]! -= tr.volume[t]!;
			}
			let E = 0;
			let scale = D;
			for (let k = 0; k < farms.length; k++) {
				const f = farms[k]!;
				const inW = inflow[f]![t]! + runoff[f]![t]! + jInt[f]!;
				const U = outflow[f]![t]!;
				const e = inW - U;
				// A difference of volumes that cancels exactly in real arithmetic is float noise, not an
				// impact. Judged against the farm's own flows (SHORTFALL_NOISE) and, at the tighter
				// RESIDUE, its dam storage, the nodes draining into it (engine 0.19.2) and the dams at both ends
				// of its transfers (0.21.1). Otherwise a full dam spilling its
				// runoff (e = I − spill, a cancellation at the scale of the storage), or an empty farm below
				// one whose outflow carries a 1e-13 residue, passes the test on flows alone and is charged
				// for a day in one node order and not in another.
				const s = Math.max(Math.abs(inflow[f]![t]!) + Math.abs(runoff[f]![t]!) + Math.abs(jInt[f]!), Math.abs(U));
				let far = dam(f, t);
				const ups = upstream[f]!;
				for (let u = 0; u < ups.length; u++) {
					const j = ups[u]!;
					far = Math.max(far, Math.abs(inflow[j]![t]!) + Math.abs(runoff[j]![t]!), Math.abs(outflow[j]![t]!), dam(j, t));
				}
				// A transfer's volume is computed next to its source dam's storage (free = Q − reserve), so a
				// source sitting at its reserve can send a one-ulp residue in one node order and 0 in another
				// (fuzz seed 14313). Size the noise by the dams at both ends of the day's transfers too.
				for (const tr of transfers) {
					if (tr.to === f || tr.from === f) far = Math.max(far, dam(tr.from, t), dam(tr.to, t));
				}
				eRaw[f] = e;
				ePlus[f] = e > Math.max(SHORTFALL_NOISE * s, RESIDUE * far) ? e : 0;
				E += ePlus[f]!;
				scale = Math.max(scale, s);
			}
			for (const tr of internal) {
				jInt[tr.to] = 0;
				jInt[tr.from] = 0;
			}
			const Dstar = E > SHORTFALL_NOISE * scale ? Math.min(D, E) : 0;
			const out = siteOut[si]!;
			out.charged[t] = Dstar > 0 ? -Dstar : 0;
			out.natural[t] = D - Dstar > 0 ? -(D - Dstar) : 0;
			if (!(Dstar > 0)) continue;
			for (let k = 0; k < farms.length; k++) {
				const f = farms[k]!;
				if (!(ePlus[f]! > 0)) continue;
				// Never more than the farm's own impact, even by a rounding bit.
				const A = Math.min((Dstar * ePlus[f]!) / E, ePlus[f]!);
				if (perSite) perSite[si]![f]![t] = -A;
				const cur = binding[f]![t]!;
				let take = cur < 0;
				if (!take) {
					const b = best[f]!;
					// Equal up to float noise: the more downstream site binds, whatever order the sites are listed in.
					take = Math.abs(A - b) <= TIE * Math.max(A, b) ? pos[site.node]! > pos[sites[cur]!.site.node]! : A > b;
				}
				if (take) {
					best[f] = Math.max(A, best[f]!);
					bestE[f] = eRaw[f]!;
					binding[f]![t] = si;
				}
			}
		}
		for (let f = 0; f < n; f++) {
			const A = best[f]!;
			if (!(A > 0)) continue;
			charge[f]![t] = -A;
			const own = consumptive?.[f];
			const c = own ? own[t]! : supplied[f]![t]! * consumptivePerSupplied[f]!;
			const o = bestE[f]! - c;
			const denom = c + Math.max(o, 0);
			const irr = denom > 0 ? Math.min((A * c) / denom, A) : 0;
			chargeIrrigation[f]![t] = irr > 0 ? -irr : 0;
		}
	}
	return { sites: siteOut, charge, chargeIrrigation, binding, ...(perSite ? { perSite } : {}) };
}

/**
 * The site that bound a farm's charge over days from…to: the one that set the
 * most charged volume (on a tie, the most downstream). −1 when never charged.
 */
export function bindingSite(res: AttributionResult, f: number, from: number, to: number, pos: (node: number) => number): number {
	const vol = new Float64Array(res.sites.length);
	for (let t = from; t <= to; t++) {
		const s = res.binding[f]![t]!;
		if (s >= 0) vol[s]! -= res.charge[f]![t]!;
	}
	let bestSite = -1;
	for (let s = 0; s < vol.length; s++) {
		if (!(vol[s]! > 0)) continue;
		if (bestSite < 0) {
			bestSite = s;
			continue;
		}
		const b = vol[bestSite]!;
		const tie = Math.abs(vol[s]! - b) <= TIE * Math.max(vol[s]!, b);
		if ((!tie && vol[s]! > b) || (tie && pos(res.sites[s]!.node) > pos(res.sites[bestSite]!.node))) bestSite = s;
	}
	return bestSite;
}
