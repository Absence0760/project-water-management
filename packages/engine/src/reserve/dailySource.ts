// Where the daily EWR at the outlet comes from (engine ≥ 1.77.0, issue
// #455, docs/model.md §2.9f): the pragmatic EWR (the default, every earlier
// run), the Desktop Reserve Model's TAB output (a monthly total flow), or
// its RUL output's two percentile tables, read day by day at the day's
// natural flow. Whichever it is, the series is the run's `ewr`, fragmented to
// the units and judged exactly as the pragmatic EWR always was. Types,
// validation (shared by the backend's zod schema, the Settings form and the
// engine) and the arithmetic. Pure: no I/O.
//
// The tables are for the catchment the Reserve was determined for, usually
// larger than the modelled area, so every table value is multiplied by a
// scale factor s: the model's natural MAR ÷ the table's MAR, or the modelled
// area ÷ the table's catchment area.
import { regroup } from '../format';
import { waterYearIndex } from '../calendar';

/** The daily outlet EWR's source: the pragmatic EWR, the DRM TAB file, or the DRM percentile tables. */
export const EWR_DAILY_METHODS = ['pragmatic', 'tab', 'percentile'] as const;
export type EwrDailyMethod = (typeof EWR_DAILY_METHODS)[number];

/** How the table is scaled to the modelled catchment: by natural MAR or by area. */
export const EWR_DAILY_SCALINGS = ['mar', 'area'] as const;
export type EwrDailyScaling = (typeof EWR_DAILY_SCALINGS)[number];

/** The percentile points of the DRM RUL output's tables, as fractions (10 % … 99 %). */
export const EWR_PERCENTILE_POINTS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99];

/** Largest flow accepted in a table, m³/s. */
export const EWR_DAILY_VALUE_MAX = 1e6;
/** Largest table MAR, Mm³ a year. */
export const EWR_DAILY_MAR_MAX = 1e6;
/** Largest table catchment area, km². */
export const EWR_DAILY_AREA_MAX = 1e7;

/** Seconds in a day. */
const DAY_S = 86_400;
/** Days in the mean year the MAR is counted over. */
const YEAR_DAYS = 365.25;

/**
 * settings.ewrDailySource: the daily outlet EWR's source and its tables. The
 * tables a method doesn't use are kept as entered, so switching back loses
 * nothing. Absent or null = the pragmatic EWR, as every run before 1.77.0.
 */
export interface EwrDailySource {
	method: EwrDailyMethod;
	scaling: EwrDailyScaling;
	/** The natural MAR the tables were determined for (the TAB header's "MAR ="), Mm³ a year; needed by the 'mar' scaling. */
	tableMarMm3: number | null;
	/** The catchment area the tables were determined for, km²; needed by the 'area' scaling. */
	tableAreaKm2: number | null;
	/** The TAB output's "Total Flows, Maint.": 12 monthly flows, m³/s, water-year months Oct … Sep. */
	tabM3s: number[] | null;
	/** The RUL output's "Natural Flow Percentile Table", m³/s: 12 rows (Oct … Sep) × the 10 points, falling with the point. */
	naturalPctM3s: number[][] | null;
	/** The RUL output's "Total Reserve Flow Percentile Table", m³/s: same shape. */
	reservePctM3s: number[][] | null;
}

export interface EwrDailySourceIssue {
	/** Field the problem is on (a key of EwrDailySource, or '' for the whole). */
	field: string;
	message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const WY_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const MAX_TEXT = regroup(EWR_DAILY_VALUE_MAX.toLocaleString('en-US'));

/** What each method is called in a warning, the run summary and the series label. */
export const EWR_DAILY_METHOD_LABELS: Record<EwrDailyMethod, string> = {
	pragmatic: 'the pragmatic EWR',
	tab: 'the DRM TAB file (total flows, maintenance)',
	percentile: 'the DRM percentile tables (natural and total Reserve flow)'
};

/**
 * A new source: the pragmatic EWR, scaled by area, with empty tables (the
 * Settings form's starting point, and the importers' fallback). The area
 * ratio is the default since 2026-10-10 (the client's hydrologist, issue #90
 * B2; the MAR ratio before). Only a new source takes it: a stored source
 * keeps its own scaling, and the run never reads this, so no run moves.
 */
export function blankEwrDailySource(): EwrDailySource {
	return { method: 'pragmatic', scaling: 'area', tableMarMm3: null, tableAreaKm2: null, tabM3s: null, naturalPctM3s: null, reservePctM3s: null };
}

function monthsIssue(v: unknown): string | null {
	if (!Array.isArray(v) || v.length !== 12) return 'Enter 12 monthly flows (Oct … Sep), m³/s.';
	const bad = v.findIndex((x) => !(isNum(x) && x >= 0 && x <= EWR_DAILY_VALUE_MAX));
	return bad < 0 ? null : `The TAB flows must be numbers from 0 to ${MAX_TEXT} m³/s (${WY_MONTHS[bad]} isn't).`;
}

function gridIssue(v: unknown, label: string): string | null {
	const points = EWR_PERCENTILE_POINTS.length;
	if (!Array.isArray(v) || v.length !== 12) return `Enter 12 rows of the ${label} (Oct … Sep).`;
	for (let m = 0; m < 12; m++) {
		const row = v[m];
		if (!Array.isArray(row) || row.length !== points) return `Each row of the ${label} needs ${points} values, one per percentile point (${WY_MONTHS[m]} has ${Array.isArray(row) ? row.length : 0}).`;
		if (!row.every((x) => isNum(x) && x >= 0 && x <= EWR_DAILY_VALUE_MAX)) return `The ${label} values must be numbers from 0 to ${MAX_TEXT} m³/s (${WY_MONTHS[m]} has one that isn't).`;
	}
	return null;
}

/**
 * Problems that make a source unusable (they block Save, and the engine runs
 * the pragmatic EWR with a warning): an unknown method or scaling, a value
 * out of range, and what the chosen method needs and lacks: the TAB flows,
 * or both percentile tables, and the table MAR ('mar') or the table area
 * ('area'). The pragmatic method needs nothing, so tables half entered can
 * be saved under it.
 */
export function ewrDailySourceIssues(v: unknown): EwrDailySourceIssue[] {
	if (!isObj(v)) return [{ field: '', message: 'The daily EWR source must be an object.' }];
	const out: EwrDailySourceIssue[] = [];
	const method = v.method;
	if (!(EWR_DAILY_METHODS as readonly unknown[]).includes(method)) out.push({ field: 'method', message: 'Pick the daily EWR source: pragmatic, TAB file or percentile tables.' });
	if (!(EWR_DAILY_SCALINGS as readonly unknown[]).includes(v.scaling)) out.push({ field: 'scaling', message: 'Pick how the tables are scaled: by MAR or by area.' });
	// A missing field is reported once, below.
	const positive = (x: unknown, max: number) => x === null || x === undefined || (isNum(x) && x > 0 && x <= max);
	if (!positive(v.tableMarMm3, EWR_DAILY_MAR_MAX)) out.push({ field: 'tableMarMm3', message: `The table MAR must be above 0 and at most ${regroup(EWR_DAILY_MAR_MAX.toLocaleString('en-US'))} Mm³ a year, or left blank.` });
	if (!positive(v.tableAreaKm2, EWR_DAILY_AREA_MAX)) out.push({ field: 'tableAreaKm2', message: `The table catchment area must be above 0 and at most ${regroup(EWR_DAILY_AREA_MAX.toLocaleString('en-US'))} km², or left blank.` });
	const tab = v.tabM3s == null ? null : monthsIssue(v.tabM3s);
	if (tab) out.push({ field: 'tabM3s', message: tab });
	const nat = v.naturalPctM3s == null ? null : gridIssue(v.naturalPctM3s, 'natural flow percentile table');
	if (nat) out.push({ field: 'naturalPctM3s', message: nat });
	const res = v.reservePctM3s == null ? null : gridIssue(v.reservePctM3s, 'total Reserve flow percentile table');
	if (res) out.push({ field: 'reservePctM3s', message: res });
	for (const k of ['tableMarMm3', 'tableAreaKm2', 'tabM3s', 'naturalPctM3s', 'reservePctM3s'] as const) {
		if (!(k in v)) out.push({ field: k, message: `${k} is missing (null when not entered).` });
	}
	if (method === 'tab' || method === 'percentile') {
		if (method === 'tab' && v.tabM3s === null) out.push({ field: 'tabM3s', message: 'Enter the TAB file’s 12 monthly total flows, or pick another source.' });
		if (method === 'percentile') {
			if (v.naturalPctM3s === null) out.push({ field: 'naturalPctM3s', message: 'Enter the natural flow percentile table, or pick another source.' });
			if (v.reservePctM3s === null) out.push({ field: 'reservePctM3s', message: 'Enter the total Reserve flow percentile table, or pick another source.' });
		}
		if (v.scaling === 'mar' && v.tableMarMm3 === null) out.push({ field: 'tableMarMm3', message: 'Scaling by MAR needs the table’s MAR (Mm³ a year, the TAB header’s “MAR =”).' });
		if (v.scaling === 'area' && v.tableAreaKm2 === null) out.push({ field: 'tableAreaKm2', message: 'Scaling by area needs the table’s catchment area (km²).' });
	}
	const known = new Set(['method', 'scaling', 'tableMarMm3', 'tableAreaKm2', 'tabM3s', 'naturalPctM3s', 'reservePctM3s']);
	const extra = Object.keys(v).filter((k) => !known.has(k));
	if (extra.length) out.push({ field: '', message: `Unknown field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}.` });
	return out;
}

/**
 * Plausibility notes on a usable percentile source; they don't block Save,
 * and the run repeats them as warnings. A natural row that rises with the
 * point: the run uses its running minimum, since a duration curve can't
 * rise.
 */
export function ewrDailySourceNotes(s: EwrDailySource): string[] {
	if (s.method !== 'percentile' || !s.naturalPctM3s || !s.reservePctM3s) return [];
	const out: string[] = [];
	const rising = s.naturalPctM3s.flatMap((row, m) => (row.some((v, i) => i > 0 && v > row[i - 1]! * (1 + 1e-9)) ? [WY_MONTHS[m]!] : []));
	if (rising.length) out.push(`the natural flow percentile table rises with the point in ${rising.join(', ')}; the run uses each row's running minimum`);
	// Against the curve the run uses: each natural row's running minimum (as reserve/rules.ts ewrRuleTableNotes).
	const above: string[] = [];
	s.reservePctM3s.forEach((row, m) => {
		let min = Infinity;
		row.forEach((v, i) => {
			min = Math.min(min, s.naturalPctM3s![m]![i]!);
			if (v > min * (1 + 1e-9)) above.push(`${WY_MONTHS[m]} ${Math.round(EWR_PERCENTILE_POINTS[i]! * 100)} %`);
		});
	});
	if (above.length) {
		out.push(`the total Reserve flow is above the natural flow at ${above.length} point${above.length === 1 ? '' : 's'} (${above.slice(0, 4).join(', ')}${above.length > 4 ? ', …' : ''}), so even natural flow fails there`);
	}
	return out;
}

/**
 * The source as the run uses it: null for the pragmatic EWR (absent, null,
 * or method 'pragmatic'); an unusable one is dropped with a warning, so the
 * run says it fell back to the pragmatic EWR. Copies, so the run never
 * mutates the settings.
 */
export function resolveEwrDailySource(raw: unknown, warnings: string[]): EwrDailySource | null {
	if (raw === undefined || raw === null) return null;
	const issues = ewrDailySourceIssues(raw);
	if (issues.length) {
		warnings.push(`daily EWR source ignored, so the outlet's daily EWR is the pragmatic EWR: ${issues.map((i) => i.message).join(' ')}`);
		return null;
	}
	const r = raw as unknown as EwrDailySource;
	if (r.method === 'pragmatic') return null;
	return {
		method: r.method,
		scaling: r.scaling,
		tableMarMm3: r.tableMarMm3,
		tableAreaKm2: r.tableAreaKm2,
		tabM3s: r.tabM3s ? [...r.tabM3s] : null,
		naturalPctM3s: r.naturalPctM3s ? r.naturalPctM3s.map((row) => [...row]) : null,
		reservePctM3s: r.reservePctM3s ? r.reservePctM3s.map((row) => [...row]) : null
	};
}

/**
 * What a run reports about its daily outlet EWR (RunSummary.catchment.outletEwr):
 * the method, the scaling and its inputs, and the scale factor s.
 */
export interface OutletEwrInfo {
	method: Exclude<EwrDailyMethod, 'pragmatic'>;
	scaling: EwrDailyScaling;
	/** s: every table value is multiplied by it. */
	scale: number;
	/** 'mar': the model's natural MAR at the outlet over the run's historical days, Mm³ a year. */
	modelMarMm3?: number;
	/** 'mar': the table's MAR, Mm³ a year. */
	tableMarMm3?: number;
	/** 'area': the modelled area, km²: the area the natural flow is made on (calibration.catchmentAreaKm2, else the units' areas summed). */
	modelAreaKm2?: number;
	/** 'area': the table's catchment area, km². */
	tableAreaKm2?: number;
	/** The scale factor came from the snapshot a resumed run started from (the capture run's), not this run's days. */
	pinned?: true;
}

/**
 * The model's natural MAR at the outlet, Mm³ a year: the mean daily natural
 * flow (m³/day) over the first `days` days × 365.25 ÷ 10⁶. 0 with no days.
 */
export function naturalMarMm3(naturalAtOutlet: ArrayLike<number>, days: number): number {
	let sum = 0;
	for (let t = 0; t < days; t++) sum += naturalAtOutlet[t]!;
	return days > 0 ? ((sum / days) * YEAR_DAYS) / 1e6 : 0;
}

/**
 * The scale factor s and what it was worked from: 'mar' = the model's natural
 * MAR at the outlet (over `historyDays`, so a forecast tail never moves it)
 * ÷ the table MAR; 'area' = the modelled area ÷ the table area. The source
 * must be usable (resolveEwrDailySource), so its divisor is above 0.
 */
export function ewrDailyScale(src: EwrDailySource, naturalAtOutlet: ArrayLike<number>, historyDays: number, modelAreaKm2: number): OutletEwrInfo {
	const method = src.method as OutletEwrInfo['method'];
	if (src.scaling === 'mar') {
		const modelMarMm3 = naturalMarMm3(naturalAtOutlet, historyDays);
		return { method, scaling: 'mar', scale: modelMarMm3 / src.tableMarMm3!, modelMarMm3, tableMarMm3: src.tableMarMm3! };
	}
	return { method, scaling: 'area', scale: modelAreaKm2 / src.tableAreaKm2!, modelAreaKm2, tableAreaKm2: src.tableAreaKm2! };
}

/**
 * The Reserve flow (m³/s) the percentile tables ask for at natural flow `q`
 * (m³/s), on rows already scaled by s (`natural` falling, `reserve` the same
 * length):
 *   q ≥ N₁:           R₁                                      (at or above the wettest point)
 *   q ≤ N_last:       N_last > 0 ? R_last × q ÷ N_last : R_last (below the driest point the requirement scales with the flow)
 *   else:             k = the last point with N_k ≥ q; w = (N_k − q) ÷ (N_k − N_k+1) (0 on a flat step);
 *                     R_k + w × (R_k+1 − R_k)
 * A negative q reads as 0.
 */
export function percentileReserveM3s(q: number, natural: ArrayLike<number>, reserve: ArrayLike<number>): number {
	const n = natural.length;
	const x = q > 0 ? q : 0;
	if (x >= natural[0]!) return reserve[0]!;
	const last = natural[n - 1]!;
	if (x <= last) return last > 0 ? (reserve[n - 1]! * x) / last : reserve[n - 1]!;
	let k = 0;
	while (k + 1 < n && natural[k + 1]! >= x) k++;
	const a = natural[k]!;
	const b = natural[k + 1]!;
	const w = a === b ? 0 : (a - x) / (a - b);
	return reserve[k]! + w * (reserve[k + 1]! - reserve[k]!);
}

/**
 * Fill out[from … to − 1] with the daily outlet EWR (m³/day) from `src` at
 * scale `s`: 'tab' = the month's TAB flow × s × 86 400; 'percentile' = the
 * Reserve flow at the day's natural flow at the outlet (m³/day ÷ 86 400) on
 * the day's month's rows × s (the natural row's running minimum), × 86 400.
 * `month` holds each day's calendar month (1–12).
 */
export function fillOutletEwr(src: EwrDailySource, s: number, month: ArrayLike<number>, naturalAtOutlet: ArrayLike<number>, out: Float64Array, from: number, to: number): void {
	if (src.method === 'tab') {
		const perDay = src.tabM3s!.map((v) => v * s * DAY_S);
		for (let t = from; t < to; t++) out[t] = perDay[waterYearIndex(month[t]!)]!;
		return;
	}
	const nat = src.naturalPctM3s!.map((row) => {
		let min = Infinity;
		return Float64Array.from(row, (v) => (min = Math.min(min, v)) * s);
	});
	const res = src.reservePctM3s!.map((row) => Float64Array.from(row, (v) => v * s));
	for (let t = from; t < to; t++) {
		const m = waterYearIndex(month[t]!);
		out[t] = percentileReserveM3s(naturalAtOutlet[t]! / DAY_S, nat[m]!, res[m]!) * DAY_S;
	}
}

/** The warning every run with a daily source other than the pragmatic EWR carries: what its EWR was judged by. */
export function outletEwrNote(info: OutletEwrInfo): string {
	const s = fmt(info.scale, 4);
	const how =
		info.scaling === 'mar'
			? `the model's natural MAR at the outlet, ${fmt(info.modelMarMm3!, 3)} Mm³/a, ÷ the table's ${fmt(info.tableMarMm3!, 3)} Mm³/a`
			: `the modelled area, ${fmt(info.modelAreaKm2!, 3)} km², ÷ the table's ${fmt(info.tableAreaKm2!, 3)} km²`;
	return `the daily EWR at the outlet comes from ${EWR_DAILY_METHOD_LABELS[info.method]}, scaled by s = ${s} (${info.pinned ? 'pinned from the snapshot this run resumed from: ' : ''}${how})`;
}

function fmt(v: number, sig: number): string {
	return Number.isFinite(v) ? String(Number(v.toPrecision(sig))) : String(v);
}

/** The run-comparison label of the daily outlet EWR's source (../compare.ts). */
export const EWR_DAILY_SOURCE_LABEL = 'Daily EWR at the outlet';

const METHOD_SHORT: Record<EwrDailyMethod, string> = { pragmatic: 'the pragmatic EWR', tab: 'the DRM TAB file', percentile: 'the DRM percentile tables' };

/**
 * What changed between two stored sources, one sentence each, for run
 * comparison: the method, and for a method that reads them the scaling, the
 * table MAR or area it divides by, and the tables it reads. Absent, null,
 * unusable and 'pragmatic' are all the pragmatic EWR, so tables kept under
 * the pragmatic EWR change nothing a run computes and aren't listed.
 */
export function ewrDailySourceChanges(a: unknown, b: unknown): string[] {
	const ra = resolveEwrDailySource(a, []);
	const rb = resolveEwrDailySource(b, []);
	const ma: EwrDailyMethod = ra?.method ?? 'pragmatic';
	const mb: EwrDailyMethod = rb?.method ?? 'pragmatic';
	if (!ra || !rb || ma !== mb) return ma === mb ? [] : [`${METHOD_SHORT[ma]} → ${METHOD_SHORT[mb]}`];
	const out: string[] = [];
	const num = (v: number | null, unit: string) => (v === null ? 'not entered' : `${String(v)} ${unit}`);
	if (ra.scaling !== rb.scaling) out.push(`scaled by ${ra.scaling === 'mar' ? 'MAR' : 'area'} → by ${rb.scaling === 'mar' ? 'MAR' : 'area'}`);
	if (rb.scaling === 'mar' && ra.tableMarMm3 !== rb.tableMarMm3) out.push(`table MAR ${num(ra.tableMarMm3, 'Mm³/a')} → ${num(rb.tableMarMm3, 'Mm³/a')}`);
	if (rb.scaling === 'area' && ra.tableAreaKm2 !== rb.tableAreaKm2) out.push(`table area ${num(ra.tableAreaKm2, 'km²')} → ${num(rb.tableAreaKm2, 'km²')}`);
	const cells = (x: number[][] | null, y: number[][] | null) => {
		let n = 0;
		for (let m = 0; m < 12; m++) for (let i = 0; i < EWR_PERCENTILE_POINTS.length; i++) if (x?.[m]?.[i] !== y?.[m]?.[i]) n++;
		return n;
	};
	if (mb === 'tab') {
		const months = WY_MONTHS.filter((_, m) => ra.tabM3s![m] !== rb.tabM3s![m]);
		if (months.length) out.push(`TAB flows changed in ${months.join(', ')}`);
	} else {
		const n = cells(ra.naturalPctM3s, rb.naturalPctM3s);
		const r = cells(ra.reservePctM3s, rb.reservePctM3s);
		if (n) out.push(`natural flow percentile table: ${n} value${n === 1 ? '' : 's'} changed`);
		if (r) out.push(`total Reserve flow percentile table: ${r} value${r === 1 ? '' : 's'} changed`);
	}
	return out;
}

/**
 * A stored source in a few words, for a scenario's change list (issue #460):
 * "the pragmatic EWR" (absent, null or method 'pragmatic', whatever tables it
 * keeps), else the method and its scaling with the table MAR or area it
 * divides by. One the run couldn't use says so.
 */
export function describeEwrDailySource(raw: unknown): string {
	if (raw === undefined || raw === null) return METHOD_SHORT.pragmatic;
	if (ewrDailySourceIssues(raw).length) return 'an unusable source (the run uses the pragmatic EWR)';
	const s = raw as EwrDailySource;
	if (s.method === 'pragmatic') return METHOD_SHORT.pragmatic;
	const by = s.scaling === 'mar' ? `scaled by MAR (table ${fmt(s.tableMarMm3!, 6)} Mm³/a)` : `scaled by area (table ${fmt(s.tableAreaKm2!, 6)} km²)`;
	return `${METHOD_SHORT[s.method]}, ${by}`;
}
