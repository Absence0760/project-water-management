// Future climate as a scenario (issue #621, docs/model.md §2.17,
// docs/scenarios.md § climate.delta): monthly change factors from downscaled
// climate projections (NEX-GDDP-CMIP6, docs/data-sources.md), and the
// `climate.delta` op that multiplies a run's rain and evaporation inputs by
// them. Pure: no I/O. The factors are worked out once (climateDeltaFactors)
// and frozen in the op, so a scenario or an evidence pack re-runs from the
// op alone.
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { MAP_MM_MAX, type DailySeries, type ModelInput, type PeInput } from '../project';

/** The smallest and largest change factor (rain or evaporation) the op takes; a computed factor outside is clamped to it, with a warning. */
export const CLIMATE_FACTOR_MIN = 0.5;
export const CLIMATE_FACTOR_MAX = 1.5;
/** The longest label and source text a climate.delta op carries. */
export const CLIMATE_LABEL_MAX = 200;
export const CLIMATE_SOURCE_MAX = 600;

/** The method's version, frozen with the factors wherever they are stored (an evidence pack's manifest). */
export const CLIMATE_DELTA_METHOD = 'delta-1';
/** The baseline window (CMIP6 historical) and the two future windows, inclusive calendar years. */
export const CLIMATE_BASELINE_WINDOW = { from: 1985, to: 2014 } as const;
export const CLIMATE_HORIZONS = { mid: { from: 2036, to: 2065 }, late: { from: 2066, to: 2095 } } as const;
export type ClimateHorizon = keyof typeof CLIMATE_HORIZONS;
/** The SSPs the factors are worked out for. */
export const CLIMATE_SSPS = ['ssp245', 'ssp585'] as const;
export type ClimateSsp = (typeof CLIMATE_SSPS)[number];

/**
 * Multiply every rain series of the run by `rainFactorByMonth` and every
 * evaporation input by `evapFactorByMonth`, by the calendar month of each day
 * (index 0 = January … 11 = December: the projections' months, not the
 * water-year order of the model's monthly rows). `label` names the case
 * ("ACCESS-CM2 SSP2-4.5 2036–2065"); `source` says where the factors came
 * from. Always a baseline assumption (classifyOp): the climate is never the
 * applicant's to propose. docs/scenarios.md § climate.delta has what it scales.
 */
export interface ClimateDeltaOp {
	op: 'climate.delta';
	rainFactorByMonth: number[];
	evapFactorByMonth: number[];
	label: string;
	source: string;
}

/** Why a factor row can't be used, or null: 12 finite numbers, each CLIMATE_FACTOR_MIN–CLIMATE_FACTOR_MAX. */
export function climateFactorRowError(v: unknown): string | null {
	if (!Array.isArray(v) || v.length !== 12) return 'must be 12 monthly factors (January–December)';
	for (let i = 0; i < 12; i++) {
		const x = v[i];
		if (!(typeof x === 'number' && Number.isFinite(x))) return `month ${i + 1}: must be a finite number`;
		if (x < CLIMATE_FACTOR_MIN || x > CLIMATE_FACTOR_MAX) return `month ${i + 1}: must be from ${CLIMATE_FACTOR_MIN} to ${CLIMATE_FACTOR_MAX}`;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Applying the op
// ---------------------------------------------------------------------------

/** A series key the op scales by the rain factors: every rain record, whatever its site or product (`rain_…`). */
export const isClimateRainKey = (key: string): boolean => key.startsWith('rain_');
/** The daily evaporation records it scales by the evaporation factors: the daily A-pan and the daily reference ET. */
export const CLIMATE_EVAP_KINDS = ['evap_apan_mm', 'evap_et0_mm'] as const;

/** The calendar-month index (0 = Jan) of a water-year month index (0 = Oct). */
const calOfWy = (wy: number) => (wy + 9) % 12;

/** `s` with each reading (finite, ≥ 0) × the factor of its day's calendar month; a blank or a no-data code (negative) is left as it is. */
function scaleDaily(s: DailySeries, f: readonly number[]): { series: DailySeries; days: number } {
	const start = toEpochDay(s.startDate);
	const values = s.values.slice();
	let days = 0;
	for (let t = 0; t < values.length; t++) {
		const v = values[t];
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
		values[t] = v * f[monthOfEpochDay(start + t) - 1]!;
		days++;
	}
	return { series: { startDate: s.startDate, values }, days };
}

/**
 * The annual-rain factor the MAPs move by: the rain factors weighted by each
 * calendar month's share of the year's rain in the catchment rain record
 * (`rain_catchment_mm`, else the catchment CHIRPS `rain_chirps_mm`; the
 * month's mean daily reading × its days), else by the months' days alone.
 * Exactly 1 when every rain factor is 1.
 */
export function annualRainFactor(series: ModelInput['series'], f: readonly number[]): number {
	if (f.every((x) => x === 1)) return 1;
	const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	const record = [series.rain_catchment_mm, series.rain_chirps_mm].find((s) => s?.values.some((v) => typeof v === 'number' && Number.isFinite(v) && v > 0));
	const w = DAYS.slice();
	if (record) {
		const sum = new Array<number>(12).fill(0);
		const n = new Array<number>(12).fill(0);
		const start = toEpochDay(record.startDate);
		record.values.forEach((v, t) => {
			if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return;
			const m = monthOfEpochDay(start + t) - 1;
			sum[m]! += v;
			n[m]!++;
		});
		for (let m = 0; m < 12; m++) w[m] = n[m]! > 0 ? (sum[m]! / n[m]!) * DAYS[m]! : 0;
		if (!w.some((x) => x > 0)) w.splice(0, 12, ...DAYS);
	}
	let num = 0;
	let den = 0;
	for (let m = 0; m < 12; m++) {
		num += w[m]! * f[m]!;
		den += w[m]!;
	}
	return num / den;
}

const scaleMap = (v: unknown, k: number): unknown => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(MAP_MM_MAX, v * k) : v);

/**
 * Every MAP of `d` × `k`, in place (its settings, model nodes and stations
 * must be the caller's own copies; the setting objects and stations are
 * replaced, a node's mapMm is written): each land unit's, the gauge MAP of
 * per-unit rain, the catchment MAP of the rainfall stations and each
 * station's, each capped at MAP_MM_MAX. climate.delta (by its annual rain
 * factor) and the sensitivity runs' rain factor (engine 1.108.0, §2.10g)
 * both scale them so, with every rain series, so every MAP ratio (a unit's
 * levelling to the gauge, a station's to its area, §2.4h, §2.4i) stays as it
 * was and the rain moves by the factor once. Returns how many it scaled.
 */
export function scaleRainMaps(d: ModelInput, k: number): number {
	let maps = 0;
	for (const n of d.model.nodes) {
		if (typeof n.mapMm === 'number' && n.mapMm > 0) {
			n.mapMm = scaleMap(n.mapMm, k) as number;
			maps++;
		}
	}
	const st = d.settings as Record<string, unknown>;
	const ur = st.unitRain as Record<string, unknown> | null | undefined;
	if (ur && typeof ur === 'object' && typeof ur.gaugeMapMm === 'number') {
		st.unitRain = { ...ur, gaugeMapMm: scaleMap(ur.gaugeMapMm, k) };
		maps++;
	}
	const rs = st.rainStations as Record<string, unknown> | null | undefined;
	if (rs && typeof rs === 'object' && typeof rs.catchmentMapMm === 'number') {
		st.rainStations = { ...rs, catchmentMapMm: scaleMap(rs.catchmentMapMm, k) };
		maps++;
	}
	if (d.stations) {
		d.stations = Object.fromEntries(
			Object.entries(d.stations).map(([id, s]) => {
				if (s && typeof s.mapMm === 'number') maps++;
				return [id, s && typeof s.mapMm === 'number' ? { ...s, mapMm: scaleMap(s.mapMm, k) as number } : s];
			})
		);
	}
	return maps;
}

/**
 * Apply a climate.delta op to `d` in place (its settings, model and stations
 * are the caller's own copies; its series map is replaced, never a series
 * mutated). Every rain series and the daily A-pan and reference ET are
 * scaled day by day; the monthly A-pan row and a monthly PE row month by
 * month; every MAP (each land unit's, the gauge MAP of per-unit rain, the
 * catchment MAP of the rainfall stations and each station's) by the annual
 * factor (annualRainFactor), so a unit's CHIRPS levelled to its MAP (§2.4h
 * rule 3) moves with the climate while every MAP ratio stays as it was.
 * Returns the notes the scenario reports.
 */
export function applyClimateDelta(d: ModelInput, op: Pick<ClimateDeltaOp, 'rainFactorByMonth' | 'evapFactorByMonth'>): string[] {
	const rf = op.rainFactorByMonth;
	const ef = op.evapFactorByMonth;
	const k = annualRainFactor(d.series, rf);
	const series: Record<string, DailySeries> = { ...(d.series as Record<string, DailySeries>) };
	let rainSeries = 0;
	let evapSeries = 0;
	for (const [key, s] of Object.entries(series)) {
		// A key JSON.parse keeps but a plain object answers from its prototype is never written (as overrides.ts).
		if (!s || !Array.isArray(s.values) || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
		const f = isClimateRainKey(key) ? rf : (CLIMATE_EVAP_KINDS as readonly string[]).includes(key) ? ef : null;
		if (!f) continue;
		series[key] = scaleDaily(s, f).series;
		if (f === rf) rainSeries++;
		else evapSeries++;
	}
	d.series = series as ModelInput['series'];
	const st = d.settings as Record<string, unknown>;
	const rows: string[] = [];
	if (Array.isArray(st.apanMm) && st.apanMm.length === 12) {
		st.apanMm = (st.apanMm as number[]).map((v, wy) => (typeof v === 'number' ? v * ef[calOfWy(wy)]! : v));
		rows.push('the A-pan row');
	}
	const pe = st.pe as PeInput | undefined;
	if (pe && pe.kind === 'monthly' && Array.isArray(pe.mm)) {
		st.pe = { ...pe, mm: pe.mm.map((v, wy) => (typeof v === 'number' ? v * ef[calOfWy(wy)]! : v)) };
		rows.push('the monthly PE row');
	}
	// The MAPs, by one factor so every ratio of two of them is unchanged.
	const maps = k !== 1 ? scaleRainMaps(d, k) : 0;
	const notes = [`${rainSeries} rain series scaled`];
	if (evapSeries || rows.length) notes.push(`${[...(evapSeries ? [`${evapSeries} daily evaporation series`] : []), ...rows].join(', ')} scaled`);
	if (maps) notes.push(`${maps} MAP${maps === 1 ? '' : 's'} × ${Number(k.toPrecision(4))} (the annual rain factor)`);
	return notes;
}

// ---------------------------------------------------------------------------
// Working out the factors
// ---------------------------------------------------------------------------

/**
 * One window's monthly climate at a grid cell (calendar months, index 0 =
 * January): the mean monthly rain total (mm) and the mean daily maximum and
 * minimum temperature (°C). The ingest stores CMIP6's kelvin; the caller
 * converts.
 */
export interface MonthlyClimate {
	prMm: readonly number[];
	tasmaxC: readonly number[];
	tasminC: readonly number[];
}

/** One year of a cell's monthly aggregates, as the copy stores them (issue #621 slice 2). */
export interface ClimateYear extends MonthlyClimate {
	year: number;
}

/**
 * One 0.25° cell over the catchment: its centre latitude, its weight (the
 * catchment's area inside it, any unit; only ratios matter), and its
 * baseline and future window climates.
 */
export interface ClimateCell {
	lat: number;
	weight: number;
	baseline: MonthlyClimate;
	future: MonthlyClimate;
}

export interface ClimateFactors {
	/** The factors the op takes, clamped to CLIMATE_FACTOR_MIN–CLIMATE_FACTOR_MAX (calendar months, 0 = January). */
	rainFactorByMonth: number[];
	evapFactorByMonth: number[];
	/** Before the clamp. */
	rawRainFactorByMonth: number[];
	rawEvapFactorByMonth: number[];
	warnings: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Mid-month day of the year, the day FAO-56's extraterrestrial radiation is read at for a month. */
const MID_MONTH_DOY = [15, 46, 74, 105, 135, 162, 198, 228, 258, 288, 318, 344];
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Extraterrestrial radiation on day `doy` at latitude `latDeg`, as the
 * evaporation it could drive (mm/day): FAO-56 (Allen et al. 1998) eq. 21 and
 * its conversion × 0.408. The polar day and night are clamped (ωs in 0–π).
 */
export function extraterrestrialRadiationMm(latDeg: number, doy: number): number {
	const phi = (latDeg * Math.PI) / 180;
	const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
	const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
	const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta))));
	const raMj = ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
	return 0.408 * Math.max(0, raMj);
}

/**
 * Hargreaves–Samani (1985) reference evaporation, mm/day: 0.0023 × Ra ×
 * (Tmean + 17.8) × √(Tmax − Tmin), Tmean the mean of the two; 0 when the
 * range or Tmean + 17.8 isn't positive. Used only as a ratio (future ÷
 * baseline), never as an evaporation itself.
 */
export function hargreavesSamaniMm(tmaxC: number, tminC: number, raMm: number): number {
	const range = tmaxC - tminC;
	const t = (tmaxC + tminC) / 2 + 17.8;
	if (!(range > 0) || !(t > 0) || !(raMm > 0)) return 0;
	return 0.0023 * raMm * t * Math.sqrt(range);
}

/** A cell's Hargreaves PET for each calendar month of a window's climate, mm per month. */
function monthlyPet(lat: number, c: MonthlyClimate): number[] {
	return MONTHS.map((_, m) => hargreavesSamaniMm(c.tasmaxC[m]!, c.tasminC[m]!, extraterrestrialRadiationMm(lat, MID_MONTH_DOY[m]!)) * DAYS_IN_MONTH[m]!);
}

/**
 * A window's mean monthly climate from a cell's yearly aggregates: the mean
 * over the years `from`–`to` (inclusive) of each month's rain total and
 * temperatures. Refused (throws) when a year of the window is missing or a
 * value isn't finite: a factor from part of a window isn't the method's.
 */
export function windowClimate(years: readonly ClimateYear[], from: number, to: number): MonthlyClimate {
	const by = new Map(years.map((y) => [y.year, y]));
	const pr = new Array<number>(12).fill(0);
	const tx = new Array<number>(12).fill(0);
	const tn = new Array<number>(12).fill(0);
	for (let y = from; y <= to; y++) {
		const r = by.get(y);
		if (!r) throw new Error(`the climate record has no year ${y} of the window ${from}–${to}`);
		for (let m = 0; m < 12; m++) {
			const a = r.prMm[m];
			const b = r.tasmaxC[m];
			const c = r.tasminC[m];
			if (![a, b, c].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`the climate record's ${MONTHS[m]} ${y} is not a number`);
			pr[m]! += a!;
			tx[m]! += b!;
			tn[m]! += c!;
		}
	}
	const n = to - from + 1;
	return { prMm: pr.map((v) => v / n), tasmaxC: tx.map((v) => v / n), tasminC: tn.map((v) => v / n) };
}

/**
 * windowClimate over the years of `from`–`to` that `years` holds, with how
 * many it held (issue #621 slice 4): the copy's synthetic fixture holds one
 * or two years of each window, and an evidence pack's § 8 says how many each
 * factor rests on rather than refusing them. A factor from part of a window
 * isn't the method's, so § 8 can't be issued on one (evidence/future.ts
 * futureFactorsComplete). Refused (throws) when it holds none, or a held
 * year has a value that isn't a number.
 */
export function heldWindowClimate(years: readonly ClimateYear[], from: number, to: number): { climate: MonthlyClimate; years: number } {
	const held = years.filter((y) => y.year >= from && y.year <= to);
	if (new Set(held.map((y) => y.year)).size !== held.length) throw new Error(`the climate record holds a year of the window ${from}–${to} twice`);
	if (!held.length) throw new Error(`the climate record holds no year of the window ${from}–${to}`);
	const lo = Math.min(...held.map((y) => y.year));
	const hi = Math.max(...held.map((y) => y.year));
	if (hi - lo + 1 === held.length) return { climate: windowClimate(held, lo, hi), years: held.length };
	// Not contiguous: the mean of the held years, through windowClimate one year at a time.
	const each = held.map((y) => windowClimate([y], y.year, y.year));
	const mean = (k: keyof MonthlyClimate) => MONTHS.map((_, m) => each.reduce((s, c) => s + c[k][m]!, 0) / each.length);
	return { climate: { prMm: mean('prMm'), tasmaxC: mean('tasmaxC'), tasminC: mean('tasminC') }, years: held.length };
}

/**
 * The 24 change factors of one model × SSP × horizon for a catchment (issue
 * #621, docs/model.md §2.17): per calendar month, rain = the cells'
 * area-weighted mean rain in the future window ÷ the same in the baseline
 * window (a ratio of means, not a mean of ratios); evaporation = the same
 * ratio of their Hargreaves–Samani PET. A month with no baseline rain or PET
 * takes 1 (a dry month stays dry under any factor), with a warning; a factor
 * outside CLIMATE_FACTOR_MIN–CLIMATE_FACTOR_MAX is clamped to it, with a
 * warning.
 */
export function climateDeltaFactors(cells: readonly ClimateCell[]): ClimateFactors {
	const used = cells.filter((c) => Number.isFinite(c.weight) && c.weight > 0 && Number.isFinite(c.lat));
	if (!used.length) throw new Error('no grid cell with a positive weight: the catchment lies outside the climate grid');
	const warnings: string[] = [];
	const ratio = (what: string, base: number[], fut: number[]) =>
		base.map((b, m) => {
			if (!(b > 0)) {
				warnings.push(`${MONTHS[m]}: no ${what} in the baseline window, so its ${what} factor is 1`);
				return 1;
			}
			return fut[m]! / b;
		});
	const sum = (f: (c: ClimateCell) => number[]) => {
		const out = new Array<number>(12).fill(0);
		for (const c of used) {
			const v = f(c);
			for (let m = 0; m < 12; m++) out[m]! += c.weight * v[m]!;
		}
		return out;
	};
	const rawRain = ratio('rain', sum((c) => [...c.baseline.prMm]), sum((c) => [...c.future.prMm]));
	const rawEvap = ratio('evaporation', sum((c) => monthlyPet(c.lat, c.baseline)), sum((c) => monthlyPet(c.lat, c.future)));
	const clamp = (what: string, raw: number[]) =>
		raw.map((v, m) => {
			const c = Math.min(CLIMATE_FACTOR_MAX, Math.max(CLIMATE_FACTOR_MIN, v));
			if (c !== v) warnings.push(`${MONTHS[m]}: the ${what} factor ${Number(v.toPrecision(4))} is outside ${CLIMATE_FACTOR_MIN}–${CLIMATE_FACTOR_MAX}, so it is held at ${c}`);
			return c;
		});
	return { rainFactorByMonth: clamp('rain', rawRain), evapFactorByMonth: clamp('evaporation', rawEvap), rawRainFactorByMonth: rawRain, rawEvapFactorByMonth: rawEvap, warnings };
}
