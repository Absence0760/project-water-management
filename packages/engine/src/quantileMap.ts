// Empirical quantile mapping of wet-day rain (engine ≥ 1.21.0, issue #66,
// docs/model.md §2.4e *Daily intensity*, calibration-research.md §4 and
// CR-23).
//
// Pure and self-contained, so the same mapper serves a rain-source period's
// replacement gauge (rainSourcePeriods.ts, engine ≥ 1.21.0) and CHIRPS where
// it fills gaps in the catchment rain (rain.ts, engine ≥ 1.47.0, CR-23,
// docs/model.md §2.4b *Quantile map*). Both fit per calendar month with the
// same month-else-season-else-nothing rule (fitMonthlyTables) and keep each
// block's total. CHIRPS also has its wet-day frequency matched (a 0.05° cell
// is wet on more days than a gauge): its drizzle days go dry and their rain
// moves onto its wet days (mapBlockDryBelow); a replacement gauge's dry days
// keep their values (mapBlockToTotal).
//
// A sample is summarised as a quantile table: QUANTILE_POINTS values at
// non-exceedance probabilities 0, 1/(N−1), …, 1, read from the sorted sample
// by linear interpolation between order statistics. A value is mapped by
// finding its probability in the source table (the middle of a flat run for a
// tie, clamped to 0 or 1 outside the table) and reading the target table at
// that probability. Tables of a fixed size keep a pinned fit (a warm-start
// snapshot, ./warmstart) small whatever the sample size.

/** Points in a quantile table: every percentile, min and max included. */
export const QUANTILE_POINTS = 101;

/** The wet-day threshold a new quantile map starts with, and its allowed range, mm. */
export const QM_WET_DAY_MM_DEFAULT = 1;
export const QM_WET_DAY_MM_MIN = 0.1;
export const QM_WET_DAY_MM_MAX = 10;
/** Wet days a month (else its season) needs on each side, target and source, before it is mapped. */
export const QM_MIN_WET_DAYS = 30;

/** The calendar months of a month's 3-month season (DJF, MAM, JJA, SON). */
export const seasonOf = (m: number): number[] => {
	if (m === 12 || m <= 2) return [12, 1, 2];
	const first = m - (m % 3);
	return [first, first + 1, first + 2];
};

/** What a calendar month is mapped with: its own wet days, its 3-month season's, or nothing (the monthly factor alone). */
export type QuantileMapBasis = 'month' | 'season' | null;

/** One calendar month's fit (fitMonthlyTables). */
export interface MonthlyFit {
	month: number;
	basis: QuantileMapBasis;
	/** Wet days behind the basis (the month's own when it isn't mapped), target and source. */
	targetN: number;
	sourceN: number;
	/** With `matchFrequency`: the source's wet-day threshold, mm (≥ the wet-day threshold; above it where the source is wet more often). */
	sourceWetMm?: number;
}

/**
 * One quantile table pair per calendar month (Jan … Dec) from samples
 * indexed by calendar month (1–12; index 0 unused). The rule every caller
 * shares: a month with at least `minWetDays` wet days on each side is mapped
 * on its own; else on its 3-month season's pooled wet days when those reach
 * `minWetDays` on each side; else not at all (null: the monthly factor
 * alone).
 *
 * Without options the samples are the wet days themselves. With
 * `{ wetDayMm, matchFrequency: true }` (the CHIRPS gap map, engine ≥
 * 1.47.0) they are every day's value, and where the source is wet (≥
 * wetDayMm) more often than the target, its wet days are only its
 * wettest days at the target's wet-day rate: the source threshold
 * `sourceWetMm` rises until the rates agree (Schmidli et al. 2006's local
 * intensity scaling). A source drier than the target keeps wetDayMm: a map
 * can't make wet days out of dry ones.
 */
export function fitMonthlyTables(
	target: readonly (readonly number[])[],
	source: readonly (readonly number[])[],
	minWetDays = QM_MIN_WET_DAYS,
	opts: { wetDayMm?: number; matchFrequency?: boolean } = {}
): { months: MonthlyFit[]; tables: ({ source: number[]; target: number[] } | null)[] } {
	const pool = (ms: number[], src: readonly (readonly number[])[]) => ms.flatMap((k) => src[k] ?? []);
	const w = opts.wetDayMm;
	const wetOf = (t: readonly number[], s: readonly number[]): { t: readonly number[]; s: readonly number[]; thr?: number } => {
		if (w === undefined) return { t, s };
		const tw = t.filter((x) => x >= w);
		let sw = s.filter((x) => x >= w);
		let thr = w;
		if (opts.matchFrequency && t.length && s.length) {
			const k = Math.round((tw.length / t.length) * s.length);
			if (k > 0 && sw.length > k) {
				thr = [...sw].sort((a, b) => b - a)[k - 1]!;
				sw = sw.filter((x) => x >= thr);
			}
		}
		return { t: tw, s: sw, ...(opts.matchFrequency ? { thr } : {}) };
	};
	const months: MonthlyFit[] = [];
	const tables: ({ source: number[]; target: number[] } | null)[] = [];
	for (let m = 1; m <= 12; m++) {
		let basis: QuantileMapBasis = null;
		let x = wetOf(target[m] ?? [], source[m] ?? []);
		if (!(x.t.length >= minWetDays && x.s.length >= minWetDays)) {
			const y = wetOf(pool(seasonOf(m), target), pool(seasonOf(m), source));
			if (y.t.length >= minWetDays && y.s.length >= minWetDays) {
				basis = 'season';
				x = y;
			}
		} else basis = 'month';
		months.push({ month: m, basis, targetN: x.t.length, sourceN: x.s.length, ...(x.thr !== undefined ? { sourceWetMm: x.thr } : {}) });
		tables.push(basis ? { source: quantileTable(x.s as number[])!, target: quantileTable(x.t as number[])! } : null);
	}
	return { months, tables };
}

/** The sample's quantile table (ascending), or null for an empty sample. Non-finite values are left out. */
export function quantileTable(sample: readonly number[], points = QUANTILE_POINTS): number[] | null {
	const xs = sample.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (!xs.length || points < 2) return null;
	const n = xs.length;
	return Array.from({ length: points }, (_, k) => {
		const r = (k / (points - 1)) * (n - 1);
		const i = Math.floor(r);
		const f = r - i;
		return i + 1 < n ? xs[i]! + f * (xs[i + 1]! - xs[i]!) : xs[i]!;
	});
}

/** Where `x` sits in an ascending table, as a fractional index 0 … length − 1. */
function position(table: readonly number[], x: number): number {
	const last = table.length - 1;
	if (x <= table[0]!) {
		// A tie with the bottom of the table: the middle of its flat run.
		let hi = 0;
		while (hi < last && table[hi + 1]! <= x) hi++;
		return x < table[0]! ? 0 : hi / 2;
	}
	if (x >= table[last]!) {
		let lo = last;
		while (lo > 0 && table[lo - 1]! >= x) lo--;
		return x > table[last]! ? last : (lo + last) / 2;
	}
	let lo = 0;
	while (table[lo]! < x) lo++;
	// table[lo] ≥ x > table[lo − 1]
	if (table[lo] === x) {
		let hi = lo;
		while (hi < last && table[hi + 1] === x) hi++;
		return (lo + hi) / 2;
	}
	const a = table[lo - 1]!;
	const b = table[lo]!;
	return lo - 1 + (x - a) / (b - a);
}

/** The value of an ascending table at a fractional index. */
function at(table: readonly number[], pos: number): number {
	const i = Math.floor(pos);
	const f = pos - i;
	return i + 1 < table.length ? table[i]! + f * (table[i + 1]! - table[i]!) : table[table.length - 1]!;
}

/**
 * Map `x` from the `source` distribution onto the `target` one (both quantile
 * tables of the same length): target quantile at x's non-exceedance
 * probability in the source. Monotone non-decreasing in x.
 */
export function quantileMapValue(source: readonly number[], target: readonly number[], x: number): number {
	if (source.length !== target.length || source.length < 2) throw new RangeError('quantile tables must have the same length (≥ 2)');
	return at(target, position(source, x));
}

/**
 * Wet-day quantile mapping of one group of days (a month, or pooled months)
 * with totals kept: each wet value (≥ `wetDayMm`) is mapped from `source` to
 * `target`; a dry value is left as it is. The caller then rescales each
 * block whose total must hold (rescaleToTotal).
 */
export const mapWetDay = (source: readonly number[], target: readonly number[], x: number, wetDayMm: number): number =>
	x >= wetDayMm ? quantileMapValue(source, target, x) : x;

/**
 * Scale `mapped` so it sums to `total` (the block's total before mapping):
 * the mapping moves rain between days, never adds or removes it. A block
 * whose mapped total is 0 while `total` isn't can't be scaled and keeps
 * `fallback` (the unmapped values). Returns new arrays; the inputs stay.
 */
export function rescaleToTotal(mapped: readonly number[], fallback: readonly number[], total: number): { values: number[]; kept: boolean } {
	const sum = mapped.reduce((s, x) => s + x, 0);
	if (total === 0) return { values: mapped.map(() => 0), kept: false };
	if (!(sum > 0)) return { values: [...fallback], kept: true };
	const k = total / sum;
	return { values: mapped.map((x) => x * k), kept: false };
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Water-year order, as the app's monthly settings. */
const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** The months (water-year order) grouped by the quantile map's basis: "by month: Oct, Nov; by season: Apr, May; not mapped …: Jun". `months` is Jan … Dec. */
export function quantileMapBasisText(months: readonly { basis: QuantileMapBasis }[], minWetDays = QM_MIN_WET_DAYS): string {
	const groups: [string, QuantileMapBasis][] = [
		['by month', 'month'],
		['by season', 'season'],
		[`not mapped (fewer than ${minWetDays} wet days even over the season)`, null]
	];
	return groups
		.map(([label, basis]) => {
			const ms = WY_MONTHS.filter((m) => (months[m - 1]?.basis ?? null) === basis).map((m) => MONTH_ABBR[m - 1]);
			return ms.length ? `${label}: ${ms.join(', ')}` : '';
		})
		.filter(Boolean)
		.join('; ');
}

/**
 * One block's wet values (each ≥ `wetDayMm`), mapped through `table` and
 * rescaled to the block's total before mapping (rescaleToTotal): the map
 * moves rain between the block's days, never in or out of the block.
 * `kept` = the block couldn't be scaled and keeps its unmapped values.
 */
export function mapBlockToTotal(wet: readonly number[], table: { source: readonly number[]; target: readonly number[] }, wetDayMm: number): { values: number[]; kept: boolean } {
	const total = wet.reduce((s, x) => s + x, 0);
	return rescaleToTotal(
		wet.map((x) => mapWetDay(table.source, table.target, x, wetDayMm)),
		wet,
		total
	);
}

/**
 * One block's values (every day with a reading, the CHIRPS gap map's month):
 * a value at or above `sourceWetMm` is mapped through `table`, any other is
 * dry (0 mm), and the mapped values are rescaled to the block's total before
 * mapping. So rain moves between the block's days, dry days included, never
 * in or out of the block. A block with rain but no day at or above
 * `sourceWetMm` can't be scaled and keeps its values (`kept`).
 */
export function mapBlockDryBelow(values: readonly number[], table: { source: readonly number[]; target: readonly number[] }, sourceWetMm: number): { values: number[]; kept: boolean } {
	const total = values.reduce((s, x) => s + x, 0);
	return rescaleToTotal(
		values.map((x) => (x >= sourceWetMm ? quantileMapValue(table.source, table.target, x) : 0)),
		values,
		total
	);
}

/** Share of `values`' total that fell on days of at least `heavyMm` (0 … 1), or null with no rain. */
export function heavyDayShare(values: Iterable<number>, heavyMm: number): { share: number | null; totalMm: number; heavyTotalMm: number; heavyDays: number } {
	let total = 0;
	let heavy = 0;
	let heavyDays = 0;
	for (const v of values) {
		if (!(v > 0)) continue;
		total += v;
		if (v >= heavyMm) {
			heavy += v;
			heavyDays++;
		}
	}
	return { share: total > 0 ? heavy / total : null, totalMm: total, heavyTotalMm: heavy, heavyDays };
}
