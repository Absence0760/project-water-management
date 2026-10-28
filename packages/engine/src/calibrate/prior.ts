// The regional GR4J prior (issue #622, docs/model.md §2.10m): parameter
// ranges for a catchment or unit from calibrated, similar, nearby gauged
// basins ("donors"), and a soil-water-capacity relation for x1 fitted on the
// same donors. Pure: no I/O, no calibration run. What it chooses is only ever
// parameters; runModel never reads any of this.
//
// Built (engine 1.106.0): `regionalPrior`, its leave-one-out score, the soil
// x1 relation, and the helpers calibration will need (`priorPenalty`, the
// log-normal penalty value of a parameter set; `priorBox`, the p10–p90 box).
// Not yet wired into calibrate(), its objectives or its bounds: with no
// caller, every calibration is bit-identical to before (issue #622 step 4's
// wiring follows, docs/followups.md).
//
// The method (Oudin et al. 2008, Water Resour. Res. 44, W03413, combining
// physical similarity and spatial proximity):
//
//  1. Each attribute (PRIOR_ATTRIBUTES; catchment area in log space) is
//     standardised over the donors: z = (a − mean) / sd, sd the population
//     standard deviation. An attribute with no spread, or that the target
//     lacks, is left out.
//  2. A donor's similarity distance d_s is the root mean square of the z
//     differences over the attributes both have (a donor sharing none has
//     none, and is ranked on distance alone); its geographic distance d_g is
//     the great-circle distance in km between the two outlets (or centroids).
//  3. Each is scaled by its median over the donors (so neither unit
//     dominates) and mixed: D = w × d_s / med(d_s) + (1 − w) × d_g / med(d_g),
//     w = `similarityWeight` (default 0.5; 1 = similarity only, 0 =
//     proximity only).
//  4. The k donors with the smallest D (ties by id) are kept and weighted by
//     inverse dissimilarity, 1 / max(D, 1e-9), normalised to sum to 1.
//  5. Each parameter's p10, p50 and p90 are the weighted quantiles of the
//     kept donors' values (Hazen plotting positions with weights: donor i,
//     sorted, sits at (W_i − w_i / 2), W_i its cumulative weight, and a
//     quantile between two donors is interpolated linearly, in log space for
//     the positive parameters x1, x3 and x4). Outside the first and last
//     positions it is the end donor's value.
//
// The leave-one-out score scores the method on the donors themselves: each
// donor in turn is the target of a prior built from the others (same k and
// weight), and for each parameter with spread its log error at p50 is
// compared with that of the plain median of the others (the "no
// information" prior): skill = 1 − Σ err² / Σ err_null². It is in parameter
// space; a flow-space score (KGE′ of the p50 on each held-out donor) needs
// the donors' forcing and is fit-donors.ts's to add.
import { canonicalJson } from '../manifest';
import { GR4J_PARAMS, type Gr4jParams } from '../runoff/params';
import { hashText } from '../warmstart/plain';

/** The attributes donors are compared on (HydroATLAS's, read from BasinATLAS and converted, docs/model.md §2.10m). */
export const PRIOR_ATTRIBUTES = ['aridity', 'mapMm', 'slopeDeg', 'clayPct', 'sandPct', 'forestPct', 'areaKm2'] as const;
export type PriorAttribute = (typeof PRIOR_ATTRIBUTES)[number];
/**
 * A basin's attributes. `aridity` is P / PET (HydroATLAS `ari_ix_sav` ÷ 100:
 * higher is wetter), `mapMm` the mean annual precipitation (`pre_mm_syr`),
 * `slopeDeg` the mean slope (`slp_dg_sav` ÷ 10), `clayPct` and `sandPct` the
 * soil texture (`cly_pc_sav`, `snd_pc_sav`), `forestPct` the forest cover
 * (`for_pc_sse`), `areaKm2` the area. null: unknown, left out of the comparison.
 */
export type CatchmentAttributes = Record<PriorAttribute, number | null>;

/** Compared in log space: area spans orders of magnitude. */
const LOG_ATTRIBUTES: ReadonlySet<PriorAttribute> = new Set(['areaKm2']);

/** The parameters a prior describes, and whether each is spread in log space (positive) or linearly (x2 may be negative). */
export const PRIOR_PARAMS = ['x1', 'x2', 'x3', 'x4'] as const;
export type PriorParam = (typeof PRIOR_PARAMS)[number];
const LOG_PARAMS: ReadonlySet<PriorParam> = new Set(['x1', 'x3', 'x4']);

/** One calibrated gauged basin. */
export interface Gr4jDonor {
	/** Its basin id (GRDC-Caravan's gauge_id, e.g. `GRDC_1160091`). */
	id: string;
	/** The outlet (or centroid), WGS84 degrees. */
	lon: number;
	lat: number;
	attributes: CatchmentAttributes;
	/** Its calibrated parameters (x2 normally fixed at 0). */
	params: Gr4jParams;
	/** Root-zone plant-available water capacity over the basin, mm; null when the soil grid doesn't cover it. */
	pawcMm?: number | null;
}

/** The catchment or unit a prior is for. */
export interface PriorTarget {
	lon: number;
	lat: number;
	attributes: CatchmentAttributes;
	/** Its root-zone PAWC, mm, when the soil grid covers it: the soil x1 prior is then evaluated there. */
	pawcMm?: number | null;
}

export interface RegionalPriorOptions {
	/** Donors kept (default DEFAULT_PRIOR_K; fewer when fewer exist). */
	k?: number;
	/** 0–1: the share of the dissimilarity from physical similarity, the rest from distance (default 0.5). */
	similarityWeight?: number;
	/** Score the method by leave-one-out on the donors (default true). */
	leaveOneOut?: boolean;
}

/** Donors kept by default: the upper end of the 4–7 Oudin et al. (2008) found best, so p10–p90 has some donors to stand on. */
export const DEFAULT_PRIOR_K = 7;
export const DEFAULT_SIMILARITY_WEIGHT = 0.5;
/** The standard normal's 90th percentile: p10–p90 is ± this many standard deviations. */
export const Z90 = 1.2815515655446004;
/** Below this leave-one-out R², the soil x1 relation has no skill and is dropped (issue #622). */
export const SOIL_PRIOR_MIN_LOO_R2 = 0.2;
/** Fewest donors with a PAWC value the soil relation is fitted on. */
export const SOIL_PRIOR_MIN_DONORS = 4;
/** Fewest donors a leave-one-out score is computed on (each held-out donor then has two to stand on). */
export const PRIOR_LOO_MIN_DONORS = 3;

/** One parameter's prior: its weighted p10, p50 and p90. */
export interface ParamRange {
	p10: number;
	p50: number;
	p90: number;
}
export type ParamPriors = Record<PriorParam, ParamRange>;

/** A donor the prior kept, and why. */
export interface PriorDonorUse {
	id: string;
	/** Its share of the prior (the kept donors' sum to 1). */
	weight: number;
	/** D, the mixed dissimilarity it was ranked on. */
	dissimilarity: number;
	/** d_s: RMS z difference over the attributes compared; null when none could be. */
	similarity: number | null;
	distanceKm: number;
}

/** How well the method predicts a held-out donor's parameter. */
export interface ParamLooScore {
	/** Root mean square of ln(p50 ÷ the donor's value) (x2: of p50 − value, mm/day). */
	rmse: number;
	/** Share of the held-out donors whose value lies in p10–p90. */
	coverage: number;
	/** 1 − Σ err² / Σ err² of the others' plain median; null when the median is exact for every donor. */
	skill: number | null;
}

export interface PriorLooScore {
	/** Donors scored (each held out once). */
	n: number;
	/** Per parameter with spread among the donors. */
	params: Partial<Record<PriorParam, ParamLooScore>>;
	/** Over the scored parameters together: 1 − Σ err² / Σ err_null²; null as for a parameter. */
	skill: number | null;
}

/** The soil x1 relation: ln x1 = intercept + slope × ln PAWC, fitted on the donors, or why it was dropped. */
export type SoilX1Relation =
	| {
			status: 'used';
			/** Donors with a PAWC value it was fitted on. */
			n: number;
			intercept: number;
			slope: number;
			/** Residual standard deviation of ln x1, √(SSE / (n − 2)). */
			residualSd: number;
			looR2: number;
	  }
	| { status: 'dropped'; n: number; looR2: number | null; reason: string };

export type RegionalPrior =
	| {
			ok: true;
			params: ParamPriors;
			donors: PriorDonorUse[];
			k: number;
			similarityWeight: number;
			/** Donors offered (the kept ones are `donors`). */
			donorCount: number;
			donorSetHash: string;
			/** null when switched off or with fewer than PRIOR_LOO_MIN_DONORS donors. */
			leaveOneOut: PriorLooScore | null;
			soil: SoilX1Relation;
			/** The soil relation at the target's PAWC: null when it was dropped or the target has none. */
			soilX1: ParamRange | null;
	  }
	| { ok: false; reason: string; donorCount: number; donorSetHash: string };

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance, km (haversine on the mean Earth radius). */
export function greatCircleKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
	const dLat = rad(lat2 - lat1);
	const dLon = rad(lon2 - lon1);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const attrValue = (a: CatchmentAttributes, k: PriorAttribute): number | null => {
	const v = a[k];
	if (v === null || v === undefined || !Number.isFinite(v)) return null;
	if (LOG_ATTRIBUTES.has(k)) return v > 0 ? Math.log(v) : null;
	return v;
};

/** Each attribute's mean and population sd over the donors that have it; attributes with no spread are absent. */
export function attributeScales(donors: readonly Pick<Gr4jDonor, 'attributes'>[]): Partial<Record<PriorAttribute, { mean: number; sd: number }>> {
	const out: Partial<Record<PriorAttribute, { mean: number; sd: number }>> = {};
	for (const k of PRIOR_ATTRIBUTES) {
		const v = donors.map((d) => attrValue(d.attributes, k)).filter((x): x is number => x !== null);
		if (v.length < 2) continue;
		const mean = v.reduce((a, b) => a + b, 0) / v.length;
		const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
		if (sd > 1e-12) out[k] = { mean, sd };
	}
	return out;
}

/** d_s between two attribute sets on `scales`: RMS of the z differences over the attributes both have; null if none. */
export function similarityDistance(a: CatchmentAttributes, b: CatchmentAttributes, scales: Partial<Record<PriorAttribute, { mean: number; sd: number }>>): number | null {
	let sum = 0;
	let n = 0;
	for (const k of PRIOR_ATTRIBUTES) {
		const s = scales[k];
		const x = attrValue(a, k);
		const y = attrValue(b, k);
		if (!s || x === null || y === null) continue;
		sum += ((x - y) / s.sd) ** 2;
		n++;
	}
	return n ? Math.sqrt(sum / n) : null;
}

const median = (v: readonly number[]): number => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The weighted quantile `p` (0–1) of `values` with `weights` (Hazen positions,
 * see the header), interpolated in log space when `log`.
 */
export function weightedQuantile(values: readonly number[], weights: readonly number[], p: number, log = false): number {
	if (!values.length) throw new RangeError('no values');
	const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]! || a - b);
	const total = weights.reduce((a, b) => a + b, 0);
	const v = idx.map((i) => (log ? Math.log(values[i]!) : values[i]!));
	const w = idx.map((i) => weights[i]! / total);
	const pos: number[] = [];
	let cum = 0;
	for (const x of w) {
		cum += x;
		pos.push(cum - x / 2);
	}
	let q: number;
	if (p <= pos[0]!) q = v[0]!;
	else if (p >= pos.at(-1)!) q = v.at(-1)!;
	else {
		let j = 0;
		while (pos[j + 1]! < p) j++;
		const t = (p - pos[j]!) / (pos[j + 1]! - pos[j]!);
		q = v[j]! + t * (v[j + 1]! - v[j]!);
	}
	return log ? Math.exp(q) : q;
}

const rangeOf = (values: readonly number[], weights: readonly number[], log: boolean): ParamRange => ({
	p10: weightedQuantile(values, weights, 0.1, log),
	p50: weightedQuantile(values, weights, 0.5, log),
	p90: weightedQuantile(values, weights, 0.9, log)
});

const finiteOrNull = (v: number | null | undefined): number | null => (v !== null && v !== undefined && Number.isFinite(v) ? v : null);

/**
 * The donor set's canonical form: each donor's id, position, attributes,
 * parameters and PAWC, sorted by id (an unknown value as null; only valid
 * donors, regionalPrior's, have a canonical form). The backend takes its SHA-256; the prior
 * carries `donorSetHash`, a 64-bit fingerprint of it.
 */
export function donorSetCanonical(donors: readonly Gr4jDonor[]): string {
	const rows = [...donors]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((d) => ({
			id: d.id,
			lon: d.lon,
			lat: d.lat,
			attributes: Object.fromEntries(PRIOR_ATTRIBUTES.map((k) => [k, finiteOrNull(d.attributes[k])])),
			params: d.params,
			pawcMm: finiteOrNull(d.pawcMm)
		}));
	return canonicalJson(rows);
}

/** A 16-hex fingerprint of the donor set (not a security measure): two priors from the same valid donors carry the same one. */
export const donorSetHash = (donors: readonly Gr4jDonor[]): string => hashText(donorSetCanonical(donors), 'gr4j-donors/1');

// ---------------------------------------------------------------------------
// The soil x1 relation
// ---------------------------------------------------------------------------

interface Ols {
	intercept: number;
	slope: number;
	sse: number;
}

function ols(x: readonly number[], y: readonly number[]): Ols | null {
	const n = x.length;
	const mx = x.reduce((a, b) => a + b, 0) / n;
	const my = y.reduce((a, b) => a + b, 0) / n;
	let sxx = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		sxx += (x[i]! - mx) ** 2;
		sxy += (x[i]! - mx) * (y[i]! - my);
	}
	if (!(sxx > 1e-12)) return null;
	const slope = sxy / sxx;
	const intercept = my - slope * mx;
	let sse = 0;
	for (let i = 0; i < n; i++) sse += (y[i]! - intercept - slope * x[i]!) ** 2;
	return { intercept, slope, sse };
}

/**
 * ln x1 = a + b ln PAWC over the donors with a PAWC value, with its residual
 * spread and leave-one-out R² (PRESS: each donor predicted by the line fitted
 * on the others, against the others' mean). Dropped, with the reason, below
 * SOIL_PRIOR_MIN_DONORS donors, when PAWC doesn't vary, or when the LOO R² is
 * under SOIL_PRIOR_MIN_LOO_R2.
 */
export function soilX1Relation(donors: readonly Pick<Gr4jDonor, 'params' | 'pawcMm'>[]): SoilX1Relation {
	const with_ = donors.filter((d) => d.pawcMm != null && d.pawcMm > 0 && d.params.x1 > 0);
	const n = with_.length;
	if (n < SOIL_PRIOR_MIN_DONORS) return { status: 'dropped', n, looR2: null, reason: `only ${n} donor(s) have a soil water capacity: the relation needs ${SOIL_PRIOR_MIN_DONORS}` };
	const x = with_.map((d) => Math.log(d.pawcMm!));
	const y = with_.map((d) => Math.log(d.params.x1));
	const all = ols(x, y);
	if (!all) return { status: 'dropped', n, looR2: null, reason: 'the donors’ soil water capacity doesn’t vary, so x1 can’t be related to it' };
	let press = 0;
	let tot = 0;
	for (let i = 0; i < n; i++) {
		const xs = x.filter((_, j) => j !== i);
		const ys = y.filter((_, j) => j !== i);
		const fit = ols(xs, ys);
		if (!fit) return { status: 'dropped', n, looR2: null, reason: 'leaving one donor out leaves no spread in soil water capacity' };
		press += (y[i]! - fit.intercept - fit.slope * x[i]!) ** 2;
		tot += (y[i]! - ys.reduce((a, b) => a + b, 0) / ys.length) ** 2;
	}
	const looR2 = tot > 0 ? 1 - press / tot : 0;
	if (!(looR2 >= SOIL_PRIOR_MIN_LOO_R2)) {
		return { status: 'dropped', n, looR2, reason: `no skill: the leave-one-out R² is ${looR2.toFixed(2)}, under ${SOIL_PRIOR_MIN_LOO_R2}` };
	}
	return { status: 'used', n, intercept: all.intercept, slope: all.slope, residualSd: Math.sqrt(all.sse / (n - 2)), looR2 };
}

/** The relation's x1 at `pawcMm`: p50 = e^(a + b ln PAWC), p10 and p90 ∓ Z90 residual sds (the coefficients' own uncertainty left out). */
export function soilX1At(rel: Extract<SoilX1Relation, { status: 'used' }>, pawcMm: number): ParamRange {
	const m = rel.intercept + rel.slope * Math.log(pawcMm);
	return { p10: Math.exp(m - Z90 * rel.residualSd), p50: Math.exp(m), p90: Math.exp(m + Z90 * rel.residualSd) };
}

// ---------------------------------------------------------------------------
// The prior
// ---------------------------------------------------------------------------

const validDonor = (d: Gr4jDonor) =>
	Number.isFinite(d.lon) && Number.isFinite(d.lat) && PRIOR_PARAMS.every((p) => Number.isFinite(d.params[p]) && (!LOG_PARAMS.has(p) || d.params[p] > 0));

/** The kept donors and their weights for `target`. */
function rank(target: PriorTarget, donors: readonly Gr4jDonor[], k: number, w: number): PriorDonorUse[] {
	const scales = attributeScales(donors);
	const rows = donors.map((d) => ({
		id: d.id,
		similarity: similarityDistance(target.attributes, d.attributes, scales),
		distanceKm: greatCircleKm(target.lon, target.lat, d.lon, d.lat)
	}));
	const sims = rows.map((r) => r.similarity).filter((s): s is number => s !== null);
	const medS = median(sims);
	const medG = median(rows.map((r) => r.distanceKm));
	const scaled = (v: number, m: number) => (m > 0 ? v / m : 0);
	// A donor with no similarity is ranked on distance alone (as if similarity weighed nothing for it).
	const scored = rows.map((r) => ({
		...r,
		dissimilarity: r.similarity === null ? scaled(r.distanceKm, medG) : w * scaled(r.similarity, medS) + (1 - w) * scaled(r.distanceKm, medG)
	}));
	scored.sort((a, b) => a.dissimilarity - b.dissimilarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const kept = scored.slice(0, k);
	const inv = kept.map((r) => 1 / Math.max(r.dissimilarity, 1e-9));
	const sum = inv.reduce((a, b) => a + b, 0);
	return kept.map((r, i) => ({ id: r.id, weight: inv[i]! / sum, dissimilarity: r.dissimilarity, similarity: r.similarity, distanceKm: r.distanceKm }));
}

function paramPriors(kept: readonly PriorDonorUse[], byId: ReadonlyMap<string, Gr4jDonor>): ParamPriors {
	const weights = kept.map((u) => u.weight);
	const out = {} as ParamPriors;
	for (const p of PRIOR_PARAMS) out[p] = rangeOf(kept.map((u) => byId.get(u.id)!.params[p]), weights, LOG_PARAMS.has(p));
	return out;
}

const paramError = (p: PriorParam, predicted: number, actual: number) => (LOG_PARAMS.has(p) ? Math.log(predicted / actual) : predicted - actual);

/** The method's leave-one-out score on `donors` (k and the weight as given). */
export function priorLeaveOneOut(donors: readonly Gr4jDonor[], k: number, similarityWeight: number): PriorLooScore | null {
	const ok = donors.filter(validDonor);
	if (ok.length < PRIOR_LOO_MIN_DONORS) return null;
	// Only parameters that vary among the donors say anything (x2, fixed at 0, doesn't).
	const scored = PRIOR_PARAMS.filter((p) => new Set(ok.map((d) => d.params[p])).size > 1);
	const acc = Object.fromEntries(scored.map((p) => [p, { se: 0, seNull: 0, inside: 0 }])) as Record<PriorParam, { se: number; seNull: number; inside: number }>;
	for (const held of ok) {
		const others = ok.filter((d) => d !== held);
		const byId = new Map(others.map((d) => [d.id, d]));
		const kept = rank(held, others, Math.min(k, others.length), similarityWeight);
		const pri = paramPriors(kept, byId);
		for (const p of scored) {
			const v = held.params[p];
			const r = pri[p];
			const nullP50 = LOG_PARAMS.has(p) ? Math.exp(median(others.map((d) => Math.log(d.params[p])))) : median(others.map((d) => d.params[p]));
			acc[p].se += paramError(p, r.p50, v) ** 2;
			acc[p].seNull += paramError(p, nullP50, v) ** 2;
			if (v >= r.p10 - 1e-12 && v <= r.p90 + 1e-12) acc[p].inside++;
		}
	}
	const n = ok.length;
	const params: Partial<Record<PriorParam, ParamLooScore>> = {};
	let se = 0;
	let seNull = 0;
	for (const p of scored) {
		const a = acc[p];
		params[p] = { rmse: Math.sqrt(a.se / n), coverage: a.inside / n, skill: a.seNull > 0 ? 1 - a.se / a.seNull : null };
		// x2 is in mm/day, the rest in log units: only the log parameters add into the overall skill.
		if (LOG_PARAMS.has(p)) {
			se += a.se;
			seNull += a.seNull;
		}
	}
	return { n, params, skill: seNull > 0 ? 1 - se / seNull : null };
}

/**
 * The regional prior for `target` from `donors` (see the header). An empty
 * donor set (or one with no usable donor) gives `ok: false` with the reason;
 * k past the donors keeps them all.
 */
export function regionalPrior(target: PriorTarget, donors: readonly Gr4jDonor[], opts: RegionalPriorOptions = {}): RegionalPrior {
	const ok = donors.filter(validDonor);
	// The donors it could use: an invalid one changes nothing the prior says.
	const hash = donorSetHash(ok);
	if (!ok.length) return { ok: false, reason: donors.length ? 'no donor has a full, valid parameter set' : 'no donor basins are loaded', donorCount: donors.length, donorSetHash: hash };
	if (!Number.isFinite(target.lon) || !Number.isFinite(target.lat)) return { ok: false, reason: 'the target has no position', donorCount: donors.length, donorSetHash: hash };
	const kWanted = opts.k ?? DEFAULT_PRIOR_K;
	if (!(Number.isInteger(kWanted) && kWanted >= 1)) throw new RangeError('k is a whole number of donors, at least 1');
	const w = opts.similarityWeight ?? DEFAULT_SIMILARITY_WEIGHT;
	if (!(w >= 0 && w <= 1)) throw new RangeError('similarityWeight is between 0 and 1');
	const k = Math.min(kWanted, ok.length);
	const kept = rank(target, ok, k, w);
	const params = paramPriors(kept, new Map(ok.map((d) => [d.id, d])));
	const soil = soilX1Relation(ok);
	const soilX1 = soil.status === 'used' && target.pawcMm != null && target.pawcMm > 0 ? soilX1At(soil, target.pawcMm) : null;
	return {
		ok: true,
		params,
		donors: kept,
		k,
		similarityWeight: w,
		donorCount: donors.length,
		donorSetHash: hash,
		leaveOneOut: opts.leaveOneOut === false ? null : priorLeaveOneOut(ok, kWanted, w),
		soil,
		soilX1
	};
}

// ---------------------------------------------------------------------------
// What calibration will read (not wired yet)
// ---------------------------------------------------------------------------

/**
 * The log-normal penalty of `params` under `priors`: ½ Σ z², with z = (ln x −
 * ln p50) / σ and σ = (ln p90 − ln p10) / (2 Z90) for x1, x3 and x4 (x2
 * linearly). A parameter with no spread (p10 = p90, e.g. x2 fixed at 0) or
 * missing from `params` adds nothing; a non-positive x1, x3 or x4 is
 * Infinity. 0 at the p50s; 0.5 × Z90² ≈ 0.82 per parameter at a p10 or p90.
 */
export function priorPenalty(priors: Partial<ParamPriors>, params: Partial<Gr4jParams>): number {
	let sum = 0;
	for (const p of PRIOR_PARAMS) {
		const r = priors[p];
		const x = params[p];
		if (!r || x === undefined) continue;
		const log = LOG_PARAMS.has(p);
		if (log && !(x > 0)) return Infinity;
		const lo = log ? Math.log(r.p10) : r.p10;
		const hi = log ? Math.log(r.p90) : r.p90;
		const sigma = (hi - lo) / (2 * Z90);
		if (!(sigma > 1e-12)) continue;
		const z = ((log ? Math.log(x) : x) - (log ? Math.log(r.p50) : r.p50)) / sigma;
		sum += z * z;
	}
	return sum / 2;
}

/** The p10–p90 box, per parameter, inside GR4J's hard bounds (a box with min = max holds that parameter fixed). */
export function priorBox(priors: ParamPriors): Record<PriorParam, { min: number; max: number }> {
	const out = {} as Record<PriorParam, { min: number; max: number }>;
	for (const spec of GR4J_PARAMS) {
		const r = priors[spec.key];
		const min = Math.min(Math.max(r.p10, spec.min), spec.max);
		const max = Math.max(Math.min(r.p90, spec.max), min);
		out[spec.key] = { min, max };
	}
	return out;
}
