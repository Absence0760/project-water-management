// The gap-filling rain product (engine ≥ 1.101.0, issue #604 R4-B, design
// D15/D16, docs/model.md §2.4b *Gap-filling product*, engine-audit.md B1c).
//
// settings.gapRain chooses which gridded product fills the catchment rain's
// blank days: CHIRPS (the default, and every run before 1.101.0), ERA5-Land
// instead, or CHIRPS with ERA5-Land only where CHIRPS has no value; and,
// opt-in, IMERG Late on the recent days past the last reading of those
// products. Each product, and each IMERG version, is bias-corrected against
// the catchment rain on its own fit, by the same rules as CHIRPS's (§2.4b:
// monthly linear scaling, 90 shared days and 50 mm a month, pooled
// fallback, clamp 0.25–4, the same suspect days left out), and ERA5-Land
// also gets the wet-day threshold and quantile map (§2.4b *Quantile map*:
// Schmidli et al. 2006's wet-day frequency step, then empirical quantile
// mapping of wet days, month totals kept), because a reanalysis drizzles.
//
// The products reach the run as input series the backend reads from the
// shared cell cache over the CHIRPS feed's own cells (runs/gapRainInput.ts):
// ERA5L_SERIES_KEY, and one IMERG_SERIES_PREFIX + version series per IMERG
// version, so a version's days are fitted only with its own. The module is
// pure: no I/O.
import { dayText, fromEpochDay, toEpochDay, waterYearLabel } from './calendar';
import { doubleMass as doubleMassOf, type DoubleMass } from './doublemass';
import {
	ERA5L_SERIES_KEY,
	IMERG_SERIES_PREFIX,
	imergVersionOf,
	type DailySeries,
	type DataQualitySettings,
	type GapRainProduct,
	type GapRainSettings,
	type ModelInput,
	type SeriesKind,
	type ZeroRainSettings
} from './project';
import { RAIN_SOURCE_CODE } from './rainSourcePeriods';
import { applyChirpsCorrection, chirpsBiasFactors, fitWindowText, type AccumulationSpans, type ChirpsCorrection, type ChirpsMonthFactor } from './rain';
import { clonePlain } from './warmstart/plain';

/**
 * ERA5-Land's wet-day threshold, mm: a day below it is dry before the
 * quantile map. 1 mm is the ETCCDI wet-day convention (R1mm; Zhang et al.
 * 2011, WIREs Clim. Change 2) and §2.4b's own default, and reanalysis drizzle
 * lies mostly below it (Zolina et al. 2004; Beck et al. 2019, HESS 23).
 * The frequency step raises ERA5-Land's own threshold above it until both
 * series are wet on the same share of days.
 */
export const GAP_ERA5L_WET_DAY_MM = 1;

/** A gap-filling product other than CHIRPS, as the summary names it. */
export type GapProduct = 'era5l' | 'imerg_late';

/** One product's (or IMERG version's) fit and what it filled. */
export interface GapProductInfo {
	/** The run input's key: ERA5L_SERIES_KEY, or IMERG_SERIES_PREFIX + version. */
	key: string;
	product: GapProduct;
	/** IMERG's version (V07, V08 …); null for ERA5-Land. */
	version: string | null;
	/** "ERA5-Land", "IMERG Late V07". */
	label: string;
	/** Whether the run's input has the series (false: the settings chose it, the copy had none for the cells). */
	present: boolean;
	/**
	 * Its bias correction against the catchment rain: §2.4b's fit with this
	 * product in CHIRPS' place, always monthly (`chirpsBiasCorrection: 'none'`
	 * is about a CHIRPS series already corrected, never these), over the whole
	 * record (CHIRPS' fit ranges are CHIRPS' eras), with ERA5-Land's quantile
	 * map. The run counts (fallbackDays …) are this product's filled days. The
	 * map's tables stay with the pinned fit, as CHIRPS's do. null without the
	 * series.
	 */
	correction: ChirpsCorrection | null;
	/** The double-mass check of catchment rain against this product (doublemass.ts, as against CHIRPS); null without both or too few years. */
	doubleMass: DoubleMass | null;
	/** Run days it filled, and its rain on them as read and after correction, mm. */
	days: number;
	rawMm: number;
	mm: number;
}

/** A run of consecutive run days one product (one IMERG version) filled. */
export interface GapRainSegment {
	from: string;
	to: string;
	product: GapProduct;
	version: string | null;
}

/** RunSummary.gapRain: the choice, each product's fit and checks, and which product filled each day. */
export interface GapRainInfo {
	product: GapRainProduct;
	imergLate: boolean;
	/** Gap days CHIRPS filled (corrected or raw by settings.chirpsBiasCorrection). */
	chirpsDays: number;
	/** The first day IMERG Late may fill: the day after the last reading of the chosen products; null without IMERG, or without any reading. */
	tailFrom: string | null;
	products: GapProductInfo[];
	/** The days ERA5-Land and IMERG Late filled, as runs of consecutive days (CHIRPS' days are rain_source 2). */
	segments: GapRainSegment[];
}

/** The fits a run makes, or a model-state snapshot pins (PreparedFits.gapRain), by input key. */
export type GapRainFits = { key: string; correction: ChirpsCorrection | null }[];

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;

/** The keys settings.gapRain reads from `series`: ERA5-Land's when chosen, and every IMERG version's present (newest first) with imergLate. */
export function gapRainKeys(gap: GapRainSettings, series: ModelInput['series']): { key: string; product: GapProduct; version: string | null }[] {
	const out: { key: string; product: GapProduct; version: string | null }[] = [];
	if (gap.product !== 'chirps') out.push({ key: ERA5L_SERIES_KEY, product: 'era5l', version: null });
	if (gap.imergLate) {
		const versions = Object.keys(series)
			.map((k) => imergVersionOf(k))
			.filter((v): v is string => v !== null)
			// Newest first: V08 before V07 (and V10 before V9, digits compared as numbers), so a day both hold reads the newer.
			.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
		for (const v of versions) out.push({ key: `${IMERG_SERIES_PREFIX}${v}`, product: 'imerg_late', version: v });
	}
	return out;
}

const seriesOf = (series: ModelInput['series'], key: string): DailySeries | undefined => (series as Record<string, DailySeries | undefined>)[key];

/**
 * Each product's fit over the whole stored record (as CHIRPS's, so the run
 * window never changes a factor). `pinned` (a resumed run's) stands in for a
 * key it holds.
 */
export function fitGapProducts(
	gap: GapRainSettings,
	series: ModelInput['series'],
	zeroRain: ZeroRainSettings,
	accumulations: AccumulationSpans,
	opts: { replaced?: AccumulationSpans; dq?: DataQualitySettings },
	pinned?: GapRainFits
): GapRainFits {
	return gapRainKeys(gap, series).map(({ key, product }) => {
		const s = seriesOf(series, key);
		const pin = pinned?.find((p) => p.key === key);
		if (pin && s) return { key, correction: pin.correction ? clonePlain(pin.correction) : null };
		if (!s) return { key, correction: null };
		const correction = chirpsBiasFactors(series as Partial<Record<SeriesKind, DailySeries>>, 'monthly', zeroRain, accumulations, {
			...(opts.replaced?.length ? { replaced: opts.replaced } : {}),
			...(opts.dq ? { dq: opts.dq } : {}),
			against: s,
			...(product === 'era5l' ? { quantileMap: { wetDayMm: GAP_ERA5L_WET_DAY_MM } } : {})
		});
		return { key, correction };
	});
}

/** The last epoch day a series holds a reading on; −Infinity without one. */
function lastReading(s: DailySeries | undefined): number {
	if (!s) return -Infinity;
	for (let i = s.values.length - 1; i >= 0; i--) if (isReading(s.values[i])) return toEpochDay(s.startDate) + i;
	return -Infinity;
}

/** A product's label: "ERA5-Land", "IMERG Late V07". */
const labelOf = (product: GapProduct, version: string | null) => (product === 'era5l' ? 'ERA5-Land' : `IMERG Late ${version}`);

export interface GapRainRun {
	/** The gap fill over the run: `base` with the chosen products written into the catchment rain's blank days. */
	values: (number | null)[];
	/** Per run day: RAIN_SOURCE_CODE.era5l / .imergLate where that product filled the gap, −1 elsewhere. */
	code: Int8Array;
	info: GapRainInfo;
	/** Per run day, the raw ERA5-Land and IMERG Late (newest version with a reading) as read, for the run's columns; null without the series. */
	rawEra5l: (number | null)[] | null;
	rawImerg: (number | null)[] | null;
}

/**
 * Fill the catchment rain's blank days by settings.gapRain.
 *
 * `base` is CHIRPS as the run uses it (corrected on the blank days; under
 * `era5l` the caller passes it with no gap day, so CHIRPS fills none),
 * `catchment` the final catchment rain (null on a blank day), `block` the
 * days nothing gridded may fill (a rain-source period whose gauge reports to
 * CHIRPS and whose named fallback has no value, §2.4e). On a blank day:
 *
 * - `chirps` / `chirpsThenEra5l`: CHIRPS where it has a value; with
 *   `chirpsThenEra5l`, ERA5-Land × its fit where CHIRPS has none;
 * - `era5l`: ERA5-Land × its fit;
 * - then, with imergLate, on a day after the last reading of the chosen
 *   products (CHIRPS, ERA5-Land or both, as stored), IMERG Late × its
 *   version's fit, the newest version that has the day.
 *
 * `fits` fill their run counts here. Pure.
 */
export function applyGapRain(a: {
	gap: GapRainSettings;
	fits: GapRainFits;
	series: ModelInput['series'];
	base: readonly (number | null)[];
	catchment: readonly (number | null)[];
	block: Uint8Array | null;
	month: Uint8Array;
	start: number;
	days: number;
	zeroRain: ZeroRainSettings;
	dq?: DataQualitySettings;
	align: (s: DailySeries | undefined, start: number, days: number) => (number | null)[];
	warnings: string[];
}): GapRainRun {
	const { gap, series, catchment, block, month, start, days } = a;
	const values = a.base.slice();
	const code = new Int8Array(days).fill(-1);
	let chirpsDays = 0;
	for (let t = 0; t < days; t++) if (catchment[t] == null && values[t] != null) chirpsDays++;
	const open = (t: number) => catchment[t] == null && values[t] == null && !block?.[t];
	const clean = (s: DailySeries | undefined) => a.align(s, start, days).map((v) => (isReading(v) ? v : null));
	const products: GapProductInfo[] = [];
	const fitOf = (key: string) => a.fits.find((f) => f.key === key)?.correction ?? null;
	const fill = (key: string, product: GapProduct, version: string | null, raw: (number | null)[], eligible: (t: number) => boolean): void => {
		const s = seriesOf(series, key);
		const correction = fitOf(key);
		const info: GapProductInfo = {
			key,
			product,
			version,
			label: labelOf(product, version),
			present: !!s,
			correction,
			doubleMass: s ? doubleMassOf({ ...(series as Partial<Record<SeriesKind, DailySeries>>), rain_chirps_mm: s }, a.zeroRain, a.dq) : null,
			days: 0,
			rawMm: 0,
			mm: 0
		};
		products.push(info);
		if (!s) return;
		const want = raw.map((v, t) => (v !== null && open(t) && eligible(t) ? v : null));
		const out = correction ? applyChirpsCorrection(correction, catchment, want, month, start, s) : want;
		const c = product === 'era5l' ? RAIN_SOURCE_CODE.era5l : RAIN_SOURCE_CODE.imergLate;
		for (let t = 0; t < days; t++) {
			if (want[t] === null) continue;
			values[t] = out[t]!;
			code[t] = c;
			info.days++;
			info.rawMm += want[t]!;
			info.mm += out[t]!;
		}
	};

	const keys = gapRainKeys(gap, series);
	let rawEra5l: (number | null)[] | null = null;
	if (gap.product !== 'chirps') {
		rawEra5l = seriesOf(series, ERA5L_SERIES_KEY) ? clean(seriesOf(series, ERA5L_SERIES_KEY)) : null;
		fill(ERA5L_SERIES_KEY, 'era5l', null, rawEra5l ?? new Array<number | null>(days).fill(null), () => true);
	}

	// IMERG Late: only past the last reading of the products chosen above, as stored (not only in the run).
	let tailFrom: number | null = null;
	let rawImerg: (number | null)[] | null = null;
	if (gap.imergLate) {
		const primary = [gap.product !== 'era5l' ? series.rain_chirps_mm : undefined, gap.product !== 'chirps' ? seriesOf(series, ERA5L_SERIES_KEY) : undefined];
		const last = Math.max(...primary.map(lastReading));
		tailFrom = Number.isFinite(last) ? last + 1 : null;
		const versions = keys.filter((k) => k.product === 'imerg_late');
		if (!versions.length) {
			products.push({ key: IMERG_SERIES_PREFIX, product: 'imerg_late', version: null, label: 'IMERG Late', present: false, correction: null, doubleMass: null, days: 0, rawMm: 0, mm: 0 });
		} else {
			rawImerg = new Array<number | null>(days).fill(null);
			for (const k of versions) {
				const raw = clean(seriesOf(series, k.key));
				for (let t = 0; t < days; t++) if (rawImerg[t] === null && raw[t] !== null) rawImerg[t] = raw[t]!;
				// Newest first: a day an earlier (newer) version filled is no longer open.
				fill(k.key, 'imerg_late', k.version, raw, (t) => tailFrom !== null && start + t >= tailFrom);
			}
		}
	}

	// Runs of consecutive days per product and version.
	const segments: GapRainSegment[] = [];
	const versionOn = (t: number): string | null => {
		if (code[t] !== RAIN_SOURCE_CODE.imergLate) return null;
		for (const p of products) if (p.product === 'imerg_late' && p.present && p.version) {
			const s = seriesOf(series, p.key)!;
			const i = start + t - toEpochDay(s.startDate);
			if (i >= 0 && i < s.values.length && isReading(s.values[i])) return p.version;
		}
		return null;
	};
	for (let t = 0; t < days; t++) {
		if (code[t]! < 0) continue;
		const product: GapProduct = code[t] === RAIN_SOURCE_CODE.era5l ? 'era5l' : 'imerg_late';
		const version = versionOn(t);
		const prev = segments.at(-1);
		const day = fromEpochDay(start + t);
		if (prev && prev.product === product && prev.version === version && code[t - 1] === code[t] && toEpochDay(prev.to) === start + t - 1) prev.to = day;
		else segments.push({ from: day, to: day, product, version });
	}

	const info: GapRainInfo = {
		product: gap.product,
		imergLate: gap.imergLate,
		chirpsDays,
		tailFrom: tailFrom !== null ? fromEpochDay(tailFrom) : null,
		products,
		segments
	};
	a.warnings.push(...gapRainWarnings(info));
	return { values, code, info, rawEra5l, rawImerg };
}

const WY_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const f2 = (x: number) => x.toFixed(2);

function factorText(months: readonly ChirpsMonthFactor[]): string {
	return WY_MONTHS.map((m) => months[m - 1]!)
		.filter((mf) => mf.factor !== null)
		.map((mf) => `${MONTH_ABBR[mf.month]} ${f2(mf.factor!)}${mf.source === 'pooled' ? ' (pooled)' : ''}${mf.clamped ? ' (clamped)' : ''}`)
		.join(', ');
}

/** The run's warnings for settings.gapRain: a chosen product the run has no rain for, what each product filled and how, and a double-mass break against it. */
export function gapRainWarnings(info: GapRainInfo): string[] {
	const out: string[] = [];
	for (const p of info.products) {
		if (!p.present) {
			out.push(
				p.product === 'era5l'
					? "the gap-filling product is ERA5-Land, but the run has no ERA5-Land rain (our copy holds none yet for the CHIRPS feed's cells, or no CHIRPS feed writes the CHIRPS series the run reads): catchment-rain gaps it would fill fall through to forecast rain, or run as 0 mm"
					: "IMERG Late fills the recent days, but the run has no IMERG Late rain (our copy holds none yet for the CHIRPS feed's cells, or no CHIRPS feed writes the CHIRPS series the run reads)"
			);
			continue;
		}
		if (p.days === 0) continue;
		const c = p.correction;
		const span = `${plural(p.days, 'catchment-rain gap day')} (${Math.round(p.rawMm)} mm as read → ${Math.round(p.mm)} mm)`;
		const where = p.product === 'imerg_late' && info.tailFrom ? ` from ${dayText(info.tailFrom)}, past the last reading of ${info.product === 'era5l' ? 'ERA5-Land' : info.product === 'chirps' ? 'CHIRPS' : 'CHIRPS and ERA5-Land'}` : '';
		if (!c || c.correctedDays === 0) {
			out.push(
				`${p.label} fills ${span}${where} uncorrected: fewer than ${c?.minDays ?? 90} days with ${c?.minMm ?? 50} mm of ${p.label} where it and the catchment rain both have a reading, so no factor could be fitted. Those days may run too wet or too dry.`
			);
		} else {
			const qm = c.quantileMap;
			const map = qm
				? ` Its wet days are quantile-mapped onto the catchment's (wet day ≥ ${qm.wetDayMm} mm, ${plural(qm.mappedDays, 'gap day')} changed${qm.unmappedDays ? `, ${plural(qm.unmappedDays, 'day')} in months too thin to map left to the factor` : ''}${qm.partialMonthDays ? `, ${plural(qm.partialMonthDays, 'day')} of a month not yet whole left to the factor` : ''}), keeping each month's corrected total.`
				: '';
			out.push(`${p.label} fills ${span}${where}, bias-corrected with its own factors fitted on ${fitWindowText(c.fitWindow)}: ${factorText(c.months)}.${map}`);
		}
		const dm = p.doubleMass;
		if (dm && dm.breaks.length) {
			const segs = dm.segments.map((s) => `${waterYearLabel(s.fromWaterYear)}–${waterYearLabel(s.toWaterYear)} ${f2(s.slope)}`).join(', ');
			out.push(
				`The double-mass check of catchment rain against ${p.label} finds ${plural(dm.breaks.length, 'break')} (catchment / ${p.label} by segment: ${segs}), and ${p.label} fills ${plural(p.days, 'day')} with factors fitted on the whole record: days in an era whose ratio differs may run too wet or too dry.`
			);
		}
	}
	return out;
}

/** The info as a run summary keeps it: each fit without the quantile map's tables and a snapshot's lead (they stay with the pinned fit). */
export function summaryGapRain(info: GapRainInfo | null): GapRainInfo | null {
	if (!info) return null;
	return {
		...info,
		products: info.products.map((p) => {
			const qm = p.correction?.quantileMap;
			if (!qm?.tables && !qm?.lead) return p;
			const { tables: _t, lead: _l, ...rest } = qm;
			return { ...p, correction: { ...p.correction!, quantileMap: rest } };
		})
	};
}
