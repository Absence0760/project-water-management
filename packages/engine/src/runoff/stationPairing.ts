// A rainfall station's pairing with the CHIRPS at it (issue #553,
// docs/model.md §2.4i): 12 monthly factors that bring CHIRPS to the
// station's level, fitted as §2.4b's and the reference gauge's (§2.4h,
// ./unitRain.ts referenceFit) are.
//
// For each calendar month m: factor(m) = Σ station ÷ Σ CHIRPS over the days
// of month m on which both the station's checked record (./stationRecord.ts,
// with accumulation windows left out as §2.4b's fit leaves them out) and the
// CHIRPS at the station have a reading (finite, not negative), over their
// whole records. A month needs CHIRPS_FACTOR_MIN_DAYS shared days and
// CHIRPS_FACTOR_MIN_MM of CHIRPS on them, else its factor is 1 (with a
// warning); a fitted factor is clamped to 0.25–4 (warning), and one outside
// the soft band 0.5–2 warns unchanged.
//
// The CHIRPS at the station is its own cell (stationChirpsSeriesKey) when
// the input has it, else the CHIRPS of the unit it stands in
// (settings.rainStations.sites[id], `rain_chirps_mm@<unit>`); with neither,
// the pairing is refused.
//
// A complete year in common: a calendar year (1 January … 31 December, 365
// or 366 days) on every day of which both the checked station record **as
// the forcing reads it** and the CHIRPS at it have a reading. A multi-day
// accumulation's days count as read: its total is the station's, spread over
// them by §2.4d (provisional, engine 1.96.0, model.md §2.4i: WMO-TD/No. 341
// and Lynch 2004 count a reliable accumulated total as a usable month). A
// day the checks or an unreliable period set aside breaks its year: a
// reading after a blank outage set aside, a blank day an accumulation run
// as recorded leaves blank. With fewer than STATION_PAIRING_MIN_YEARS of
// them (not necessarily consecutive) the pairing is refused. The factors are
// still fitted on every shared day of the fit's record (accumulation windows
// left out), inside complete years or not.
//
// The station's record is checked as the forcing checks it: the catchment
// gauge's full checks when stations[id].isCatchmentGauge, else a station's.
//
// Pinned factors (settings.rainStations.pinnedFactors[id], 12 positive
// finite numbers) replace the fit, and a pinned pairing is never refused.
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_FACTOR_WARN_MAX,
	AREAL_RAIN_FACTOR_WARN_MIN,
	outsideArealRainBand,
	STATION_PAIRING_MIN_YEARS,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type RainStationInputs,
	type StationPairingFit,
	type UnitRainReferenceMonth
} from '../project';
import { CHIRPS_FACTOR_MIN_DAYS, CHIRPS_FACTOR_MIN_MM } from '../rain';
import { checkedStationRecord, stationChirpsSource } from './stationRecord';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const clampFactor = (k: number) => Math.min(AREAL_RAIN_FACTOR_MAX, Math.max(AREAL_RAIN_FACTOR_MIN, k));
const fmt = (k: number) => (Math.round(k * 1000) / 1000).toString();
const BAND = `${AREAL_RAIN_FACTOR_WARN_MIN}–${AREAL_RAIN_FACTOR_WARN_MAX}`;
const CLAMP = `${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX}`;
/** As ./unitRain.ts factorWarning: past the clamp (clamped), or inside it past the soft band (unchanged); null within the band. */
const factorWarning = (what: string, own: number, used: number, how: string): string | null =>
	used !== own
		? `${what} is ${fmt(own)} (${how}), outside ${CLAMP}; using ${fmt(used)} (clamped)`
		: outsideArealRainBand(own)
			? `${what} is ${fmt(own)} (${how}), outside ${BAND}: used as it is, but check the records it comes from`
			: null;
const daysInYear = (y: number) => toEpochDay(`${y + 1}-01-01`) - toEpochDay(`${y}-01-01`);
const validPinned = (p: unknown): p is number[] => Array.isArray(p) && p.length === 12 && p.every((k) => typeof k === 'number' && Number.isFinite(k) && k > 0);

/** The calendar years on every day of which both `a` and `b` have a reading. */
function completeYears(a: DailySeries, b: DailySeries): number {
	const perYear = new Map<number, number>();
	const a0 = toEpochDay(a.startDate);
	const b0 = toEpochDay(b.startDate);
	for (let i = 0; i < b.values.length; i++) {
		if (!reading(b.values[i])) continue;
		const j = b0 + i - a0;
		if (j < 0 || j >= a.values.length || !reading(a.values[j])) continue;
		const y = Number(fromEpochDay(b0 + i).slice(0, 4));
		perYear.set(y, (perYear.get(y) ?? 0) + 1);
	}
	let years = 0;
	for (const [y, d] of perYear) if (d === daysInYear(y)) years++;
	return years;
}

/** The shared days of `a` and `b` by calendar month (count, Σa, Σb) and their first and last. */
function common(a: DailySeries, b: DailySeries) {
	const n = new Array<number>(12).fill(0);
	const sa = new Array<number>(12).fill(0);
	const sb = new Array<number>(12).fill(0);
	const a0 = toEpochDay(a.startDate);
	const b0 = toEpochDay(b.startDate);
	let first: number | null = null;
	let last: number | null = null;
	// Day by day over b's record, in date order.
	for (let i = 0; i < b.values.length; i++) {
		const bv = b.values[i];
		if (!reading(bv)) continue;
		const day = b0 + i;
		const j = day - a0;
		if (j < 0 || j >= a.values.length) continue;
		const av = a.values[j];
		if (!reading(av)) continue;
		const m = monthOfEpochDay(day) - 1;
		n[m]!++;
		sa[m]! += av;
		sb[m]! += bv;
		first ??= day;
		last = day;
	}
	return { n, sa, sb, first, last };
}

/**
 * Fit one station's pairing (see the header). Refused (a plain reason in
 * `refused`, months []) without a record for the station, without CHIRPS at
 * it, or with fewer than STATION_PAIRING_MIN_YEARS complete years in common.
 * A refusal and each month's warning go to `warnings` ("station pairing: …").
 * The record checks' own warnings are left to the forcing, which reads the
 * same record.
 */
export function fitStationPairing(
	args: { settings: ProjectSettings; series: ModelInput['series']; stations: RainStationInputs; nodes: readonly NetworkNode[]; stationId: string },
	warnings: string[]
): StationPairingFit {
	const { settings, series, stations, nodes, stationId } = args;
	const stationName = stations[stationId]?.name ?? stationId;
	const who = `station pairing: "${stationName}"`;
	const src = stationChirpsSource(settings, series, stationId);
	const chirpsAt: StationPairingFit['chirpsAt'] = src.at === 'unit' ? { unitId: src.unitId, unitName: nodes.find((x) => x.id === src.unitId)?.name ?? src.unitId } : { cell: true };
	const chirps = src.at === 'none' ? null : src.series;
	const checked = checkedStationRecord(settings, series, stationId, { fitExcludeAccumulations: true, name: stationName, isCatchmentGauge: stations[stationId]?.isCatchmentGauge === true });
	const rec = checked?.record ?? null;
	// The factors read the fit's record (accumulation windows left out); the complete years, the forcing's.
	const c = rec && chirps ? { ...common(rec, chirps), years: completeYears(checked!.forcing ?? rec, chirps) } : null;

	const pinnedRaw = settings.rainStations?.pinnedFactors?.[stationId];
	const pinned = validPinned(pinnedRaw) ? pinnedRaw : null;
	if (pinnedRaw != null && !pinned) warnings.push(`${who}: its pinned factors aren’t 12 positive numbers, so they are fitted instead`);

	const base = {
		stationId,
		stationName,
		chirpsAt,
		fitFrom: c?.first != null ? fromEpochDay(c.first) : null,
		fitTo: c?.last != null ? fromEpochDay(c.last) : null,
		commonYears: c?.years ?? 0,
		days: c ? c.n.reduce((s, x) => s + x, 0) : 0
	};

	if (!pinned) {
		const refused = !rec
			? 'the station has no record'
			: src.at === 'none'
				? 'there is no CHIRPS at the station: it has no CHIRPS cell series and no unit it stands in'
				: !chirps
					? `there is no CHIRPS for the unit it stands in ("${(chirpsAt as { unitName: string }).unitName}")`
					: c!.years < STATION_PAIRING_MIN_YEARS
						? `the station and the CHIRPS at it have ${c!.years} complete calendar ${c!.years === 1 ? 'year' : 'years'} in common (every day a reading in both), fewer than ${STATION_PAIRING_MIN_YEARS}`
						: null;
		if (refused) {
			warnings.push(`${who} is refused: ${refused}. Its areas’ CHIRPS isn’t corrected against it`);
			return { ...base, refused, pinned: false, months: [] };
		}
	}

	const n = c?.n ?? new Array<number>(12).fill(0);
	const g = c?.sa ?? new Array<number>(12).fill(0);
	const s = c?.sb ?? new Array<number>(12).fill(0);
	const months: UnitRainReferenceMonth[] = n.map((days, m) => {
		const fitted = days >= CHIRPS_FACTOR_MIN_DAYS && s[m]! >= CHIRPS_FACTOR_MIN_MM;
		const own = fitted ? g[m]! / s[m]! : null;
		const factor = pinned ? pinned[m]! : own === null ? 1 : clampFactor(own);
		return {
			month: m + 1,
			sharedDays: days,
			gaugeMm: g[m]!,
			chirpsMm: s[m]!,
			ownFactor: own,
			factor,
			clamped: !pinned && own !== null && factor !== own,
			fitted,
			outsideBand: !pinned && own !== null && outsideArealRainBand(own)
		};
	});
	if (!pinned) {
		const short = months.filter((x) => !x.fitted);
		if (short.length)
			warnings.push(
				`${who}: the station and the CHIRPS at it have too little in common in ${short.length === 12 ? 'every month' : short.map((x) => MONTH_NAMES[x.month - 1]).join(', ')} (fewer than ${CHIRPS_FACTOR_MIN_DAYS} shared days, or under ${CHIRPS_FACTOR_MIN_MM} mm of CHIRPS on them), so ${short.length === 1 ? 'that month’s factor is' : 'those months’ factors are'} 1`
			);
		for (const x of months) {
			const w = x.ownFactor === null ? null : factorWarning(`${who}: the factor for ${MONTH_NAMES[x.month - 1]}`, x.ownFactor, x.factor, `${Math.round(x.gaugeMm)} ÷ ${Math.round(x.chirpsMm)} mm`);
			if (w) warnings.push(w);
		}
	}
	return { ...base, refused: null, pinned: !!pinned, months };
}

/** The factor of `epochDay`'s calendar month; null when the pairing is refused. */
export function pairingFactorOn(fit: StationPairingFit, epochDay: number): number | null {
	if (fit.refused !== null || fit.months.length !== 12) return null;
	return fit.months[monthOfEpochDay(epochDay) - 1]!.factor;
}
