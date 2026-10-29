// Modelled vs observed dam area (issue #604 R5-B; docs/model.md § Modelled vs
// observed dam area, docs/api.md § Dams seen from space).
//
// Pure: the route (./routes.ts) reads the rows and hands them here. The
// modelled side is the run's `dam_area` column for the unit the dam polygons
// stand for (m², start of day: the survey curve, `damCurve`, or the power law
// from `damAreaFullM2`, as the engine worked it out), the observed side the
// `dam_observation` rows (261, R5-A: Digital Earth Africa Waterbodies and WOfS;
// 278, issue #624: Sentinel-2 and Sentinel-1 radar inside the dam's outline).
// Nothing here changes the engine or reads anything but its output.
//
// A unit's dam is its composite dam (all its farm dams, geo/damRoutes.ts), so
// when several dam polygons are linked to one unit the observed area of a day
// is their sum, and a day counts only when every one of them was seen clearly
// by the same source that day.
import { estimatedDamAreaForEngine, resolveDamCurve, toEpochDay, type DamCurvePoint } from '@water-management/engine';

/**
 * Where an observation comes from (dam_observation.source): DE Africa Waterbodies (a polygon's area series), WOfS
 * (Landsat, 30 m), Sentinel-2 ('s2', 10 m) and Sentinel-1 radar ('s1'), the last three counted inside the dam's own
 * outline (278, issue #624).
 */
export type ObservedSource = 'waterbodies' | 'wofs' | 's2' | 's1';

/**
 * Which source wins a day several saw clearly, best first (issue #624): the sharpest optical view of the dam's own
 * outline (Sentinel-2, then WOfS), then a Waterbodies polygon's series (optical too), and radar last (through cloud,
 * but wind and wet sand fool it). The issue ranked radar above Waterbodies; radar sets no flag, so a radar win over a
 * clear Waterbodies view would drop that day's spill or empty flag, and radar only takes a day no optical source saw.
 */
export const SOURCE_PRECEDENCE: readonly ObservedSource[] = ['s2', 'wofs', 'waterbodies', 's1'];
const RANK = new Map(SOURCE_PRECEDENCE.map((s, i) => [s, i]));

/** Radar: compared and shown, but never alone the reason a dam is called full or empty, nor a disagreement. */
export const isRadar = (source: ObservedSource) => source === 's1';

/** The ground area of a cell `deg` degrees square at latitude `latDeg` (m², spherical Earth, R = 6 371 008.8 m). */
export function geographicPixelM2(deg: number, latDeg: number): number {
	const side = (deg * Math.PI * 6_371_008.8) / 180;
	return side * side * Math.cos((latDeg * Math.PI) / 180);
}

/** How a dam polygon matched a Waterbodies polygon (R5-A's match table); null when it was never matched. */
export type MatchStatus = 'matched' | 'merged' | 'none';

/** One dam_observation row. */
export interface ObservationIn {
	featureId: string;
	source: ObservedSource;
	/** YYYY-MM-DD. */
	date: string;
	wetAreaM2: number;
	/** The share of the outline seen clearly that date, 0–100. */
	pctObserved: number;
}

/**
 * The thresholds, provisional (docs/model.md § Modelled vs observed dam area
 * says why each): change them there and here together.
 */
export const OBSERVED = {
	/** An observation is compared only when at least this share of the dam was seen clearly (%). DE Africa's own guidance filters partial views the same way. */
	minPctObserved: 90,
	/** Full: at or above this share of the full area (the survey curve's top, the entered area, or the estimate). */
	fullShare: 0.95,
	/** Empty: at or below this share of the full area. */
	emptyShare: 0.05,
	/**
	 * One pixel's ground area per source (m²): the observed side is never "empty" above one pixel's worth of water,
	 * less than which can't be told from none. Sentinel-2 one 20 m cell (400 m²): its water test, MNDWI, reads B11 at
	 * 20 m, and its cloud mask (SCL) is 20 m too, so a 10 m pixel is finer than it can tell; WOfS and Waterbodies
	 * (WOfS's own) a 30 m Landsat pixel;
	 * Sentinel-1 RTC's 0.0002° cell at 30° S, about 430 m² (about 410 to 460 m² over South Africa). S1's never sets a
	 * flag (isRadar), so it is shown, not used.
	 */
	pixelM2: { s2: 400, wofs: 900, waterbodies: 900, s1: Math.round(geographicPixelM2(0.0002, -30)) } satisfies Record<ObservedSource, number>,
	/** A mismatch needs the other side clearly not in that state: not full means under this share, not empty means over it. */
	clearlyNotFull: 0.8,
	clearlyWet: 0.2,
	/** A pair agrees when the two areas are within this share of the full area. */
	withinShare: 0.1
} as const;

/** Why an observation wasn't compared. */
export type SkipReason =
	/** Under OBSERVED.minPctObserved of the dam seen clearly (cloud, shadow, a scan gap). */
	| 'partly-seen'
	/** A Waterbodies polygon that isn't this dam alone (merged with a neighbour, or no match): its area isn't the dam's. */
	| 'not-this-dam'
	/** Another of the unit's dams wasn't seen clearly by this source that day, so the sum isn't the unit's. */
	| 'partial-unit'
	/** A source ahead of this one (SOURCE_PRECEDENCE) saw the whole unit clearly the same day, and that view is compared instead. */
	| 'other-source'
	/** Outside the run, or on its forecast days. */
	| 'outside-run'
	/** No run, or the unit isn't in it. */
	| 'no-run';

/** The four mismatches: which side says full or empty, and the other clearly doesn't. */
export type Mismatch = 'model-full' | 'model-empty' | 'seen-full' | 'seen-empty';

export interface ComparedPoint {
	date: string;
	source: ObservedSource;
	/** Summed over the unit's dam polygons seen that day. */
	wetAreaM2: number;
	/** The least of the polygons' shares seen clearly. */
	pctObserved: number;
	/** The run's dam_area that day, or null outside the run. */
	modelledAreaM2: number | null;
	/** Whether it entered the comparison and the summary. */
	compared: boolean;
	skip: SkipReason | null;
	/** Satellite: at or above the full area (likely spilling), or near zero. Only on compared points, and never on radar's (isRadar). */
	seenFull: boolean;
	seenEmpty: boolean;
	modelFull: boolean;
	modelEmpty: boolean;
	mismatch: Mismatch | null;
}

export interface CompareSummary {
	/** Points compared. */
	compared: number;
	/** Points seen but not compared. */
	skipped: number;
	/** Mean (modelled − observed) over the compared points, as % of the full area: + means the model holds more water. null with none. */
	biasPctOfFull: number | null;
	/** Share of compared points within OBSERVED.withinShare of the full area, 0–1; null with none. */
	withinShare: number | null;
	seenFull: number;
	seenEmpty: number;
	mismatches: number;
	/** Of the compared points, how many are radar (Sentinel-1): in the bias and the share within, never in a flag. */
	radar: number;
	/**
	 * The same figures over the optical points alone (every compared point but radar's): radar reads open water dry
	 * in wind, so its views pull the average difference down. Shown beside the figures above when radar is among
	 * them, so the reader sees how far radar moved them. Equal to them without radar; null figures with no optical point.
	 */
	optical: { compared: number; biasPctOfFull: number | null; withinShare: number | null };
	/** The newest clear observation (compared or not for want of a run), for the farmer's "seen from space". */
	latestClear: { date: string; source: ObservedSource; wetAreaM2: number; pctObserved: number } | null;
}

export interface FullArea {
	areaM2: number;
	/** survey: the curve's top row; entered: damAreaFullM2; estimated: from the capacity (the engine's estimate). */
	from: 'survey' | 'entered' | 'estimated';
}

/** The run's model node fields that set the full-supply area. */
export interface DamNodeIn {
	damCapacityM3?: unknown;
	damAreaFullM2?: unknown;
	damCurve?: unknown;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The area the dam covers when full, as the run worked it out: the survey
 * curve's top area when the curve is usable (resolveDamCurve), else the
 * entered full-supply area, else the engine's estimate from the capacity for
 * that run's engine version. null for a unit with no dam.
 */
export function fullAreaOf(node: DamNodeIn | null | undefined, engineVersion?: string): FullArea | null {
	if (!node) return null;
	const cap = finite(node.damCapacityM3) ? node.damCapacityM3 : 0;
	if (!(cap > 0)) return null;
	const curve = Array.isArray(node.damCurve) ? resolveDamCurve({ damCurve: node.damCurve as DamCurvePoint[] }) : null;
	if (curve) return { areaM2: Math.max(...curve.area), from: 'survey' };
	if (finite(node.damAreaFullM2) && node.damAreaFullM2 > 0) return { areaM2: node.damAreaFullM2, from: 'entered' };
	return { areaM2: estimatedDamAreaForEngine(cap, engineVersion), from: 'estimated' };
}

export interface CompareInput {
	/** The unit's dam polygons and how each matched Waterbodies (null: never matched). */
	features: readonly { id: string; match: MatchStatus | null }[];
	observations: readonly ObservationIn[];
	/** The run's dam_area for the unit, or null with no run (or the unit not in it). */
	modelled: { startDate: string; values: readonly (number | null)[] } | null;
	/** The run's first forecast day, when it is a forecast run: observations from it on aren't compared. */
	forecastFrom?: string | null;
	/** fullAreaOf the run's node; null with no run. */
	full: FullArea | null;
}

export interface CompareResult {
	points: ComparedPoint[];
	summary: CompareSummary;
}

/** Whether a Waterbodies polygon stands for this dam alone. */
const waterbodiesIsDam = (m: MatchStatus | null) => m === 'matched';

/**
 * Pair a unit's observations with its modelled area by date and flag them.
 * Points come back oldest first, one per (source, date) the unit's polygons
 * were seen, each saying whether it was compared and why not.
 */
export function compareDam(input: CompareInput): CompareResult {
	const ids = new Set(input.features.map((f) => f.id));
	const matchOf = new Map(input.features.map((f) => [f.id, f.match]));
	const want = ids.size;
	// (source, date) → the rows for the unit's polygons that day.
	const groups = new Map<string, ObservationIn[]>();
	for (const o of input.observations) {
		if (!ids.has(o.featureId)) continue;
		const k = `${o.date}|${o.source}`;
		const g = groups.get(k);
		if (g) g.push(o);
		else groups.set(k, [o]);
	}
	const keys = [...groups.keys()].sort();
	const F = input.full?.areaM2 ?? null;
	const m = input.modelled;
	const start = m ? toEpochDay(m.startDate) : 0;
	const modelledOn = (date: string): number | null => {
		if (!m) return null;
		const i = toEpochDay(date) - start;
		const v = i >= 0 && i < m.values.length ? m.values[i] : null;
		return finite(v) ? v : null;
	};
	// Why a (source, date) view can't stand for the unit, before any other source is considered.
	const ownSkip = (source: ObservedSource, g: readonly ObservationIn[]): SkipReason | null => {
		if (Math.min(...g.map((o) => o.pctObserved)) < OBSERVED.minPctObserved) return 'partly-seen';
		if (source === 'waterbodies' && g.some((o) => !waterbodiesIsDam(matchOf.get(o.featureId) ?? null))) return 'not-this-dam';
		if (new Set(g.map((o) => o.featureId)).size !== want) return 'partial-unit';
		return null;
	};
	// Each day's best clear view of the whole unit (SOURCE_PRECEDENCE): the others that day are 'other-source'.
	const best = new Map<string, ObservedSource>();
	for (const k of keys) {
		const [date, source] = k.split('|') as [string, ObservedSource];
		if (ownSkip(source, groups.get(k)!) !== null) continue;
		const b = best.get(date);
		if (b === undefined || RANK.get(source)! < RANK.get(b)!) best.set(date, source);
	}

	const points: ComparedPoint[] = [];
	for (const k of keys) {
		const [date, source] = k.split('|') as [string, ObservedSource];
		const g = groups.get(k)!;
		const wet = g.reduce((s, o) => s + o.wetAreaM2, 0);
		const pct = Math.min(...g.map((o) => o.pctObserved));
		const modelled = modelledOn(date);
		let skip: SkipReason | null = ownSkip(source, g);
		if (skip === null && best.get(date) !== source) skip = 'other-source';
		else if (skip === null && (!m || F === null)) skip = 'no-run';
		else if (skip === null && (modelled === null || (input.forecastFrom && date >= input.forecastFrom))) skip = 'outside-run';
		const compared = skip === null;
		const p: ComparedPoint = { date, source, wetAreaM2: wet, pctObserved: pct, modelledAreaM2: modelled, compared, skip, seenFull: false, seenEmpty: false, modelFull: false, modelEmpty: false, mismatch: null };
		if (compared && F !== null && modelled !== null) Object.assign(p, flags(wet, modelled, F, source));
		points.push(p);
	}
	return { points, summary: summarise(points, F) };
}

/**
 * The spill, empty and mismatch flags of one compared pair (OBSERVED), for the source that saw it (its pixel).
 * Radar (isRadar) sets no observed flag and no mismatch: every one of them reads the satellite's side, which wind
 * (open water looking dry) and wet sand (dry ground looking wet) move. The model's own full and empty stand.
 */
export function flags(
	observed: number,
	modelled: number,
	full: number,
	source: ObservedSource = 'wofs'
): Pick<ComparedPoint, 'seenFull' | 'seenEmpty' | 'modelFull' | 'modelEmpty' | 'mismatch'> {
	const modelFull = modelled >= OBSERVED.fullShare * full;
	const modelEmpty = modelled <= OBSERVED.emptyShare * full;
	if (isRadar(source)) return { seenFull: false, seenEmpty: false, modelFull, modelEmpty, mismatch: null };
	const seenFull = observed >= OBSERVED.fullShare * full;
	const seenEmpty = observed <= Math.max(OBSERVED.emptyShare * full, OBSERVED.pixelM2[source]);
	const notFull = (a: number) => a < OBSERVED.clearlyNotFull * full;
	const wet = (a: number) => a > OBSERVED.clearlyWet * full;
	const mismatch: Mismatch | null =
		modelFull && notFull(observed) ? 'model-full' : modelEmpty && wet(observed) ? 'model-empty' : seenFull && notFull(modelled) ? 'seen-full' : seenEmpty && wet(modelled) ? 'seen-empty' : null;
	return { seenFull, seenEmpty, modelFull, modelEmpty, mismatch };
}

/** The mean difference (% of full) and the share within OBSERVED.withinShare of the full area, over compared points. */
function agreement(c: readonly ComparedPoint[], full: number | null): { compared: number; biasPctOfFull: number | null; withinShare: number | null } {
	const n = c.length;
	const diff = c.map((p) => p.modelledAreaM2! - p.wetAreaM2);
	return {
		compared: n,
		biasPctOfFull: n && full ? (diff.reduce((s, d) => s + d, 0) / n / full) * 100 : null,
		withinShare: n && full ? diff.filter((d) => Math.abs(d) <= OBSERVED.withinShare * full).length / n : null
	};
}

function summarise(points: readonly ComparedPoint[], full: number | null): CompareSummary {
	const c = points.filter((p) => p.compared);
	const n = c.length;
	const all = agreement(c, full);
	const clear = points.filter((p) => p.pctObserved >= OBSERVED.minPctObserved && (p.compared || p.skip === 'no-run' || p.skip === 'outside-run'));
	const last = clear.at(-1) ?? null;
	return {
		compared: n,
		skipped: points.length - n,
		biasPctOfFull: all.biasPctOfFull,
		withinShare: all.withinShare,
		seenFull: c.filter((p) => p.seenFull).length,
		seenEmpty: c.filter((p) => p.seenEmpty).length,
		mismatches: c.filter((p) => p.mismatch).length,
		radar: c.filter((p) => isRadar(p.source)).length,
		optical: agreement(c.filter((p) => !isRadar(p.source)), full),
		latestClear: last ? { date: last.date, source: last.source, wetAreaM2: last.wetAreaM2, pctObserved: last.pctObserved } : null
	};
}
