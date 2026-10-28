// A rainfall station's pairing with an area's CHIRPS (issue #553; per area
// since engine 1.105.0, issue #612, docs/model.md §2.4i): 12 monthly factors
// that bring the area's CHIRPS to the station's rain at the area's level,
// fitted as §2.4b's and the reference gauge's (§2.4h, ./unitRain.ts
// referenceFit) are.
//
// For area a corrected against station s, for each calendar month m:
//   f_a(m) = Σ (station × r) ÷ Σ CHIRPS_a
// over the days of month m on which both the station's checked record
// (./stationRecord.ts, with accumulation windows left out as §2.4b's fit
// leaves them out) and the area's own CHIRPS (`rain_chirps_mm@<unit>`, or
// `rain_chirps_mm` for the catchment) have a reading (finite, not
// negative), over their whole records. r is the ratio the area reads the
// station at (area MAP ÷ station MAP, clamped 0.25–4; 1 with scaling off or
// a MAP missing), so the corrected CHIRPS has the monthly totals of the
// station's adjusted rain on the shared days and a gap day sits at the
// area's MAP as a station day does. The area's CHIRPS is the denominator,
// not the CHIRPS at the station's cell: the cell's would carry the
// station-to-area gradient twice (once in r, once in CHIRPS_a ÷
// CHIRPS_station). A month needs CHIRPS_FACTOR_MIN_DAYS shared days and
// CHIRPS_FACTOR_MIN_MM of CHIRPS on them, else its factor is 1 (with a
// warning); a fitted factor is clamped to 0.25–4 (warning), and one outside
// the soft band 0.5–2 warns unchanged.
//
// A complete year in common: a calendar year (1 January … 31 December, 365
// or 366 days) on every day of which both the checked station record **as
// the forcing reads it** and the area's CHIRPS have a reading. A multi-day
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
// Those checks still compare it with the CHIRPS at the station
// (./stationRecord.ts); the pairing doesn't read that CHIRPS.
//
// Pinned factors (settings.rainStations.pinnedFactors[stationPairingKey(id,
// area)], 12 positive finite numbers) replace the fit, and a pinned pairing
// is never refused.
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	AREAL_RAIN_FACTOR_WARN_MAX,
	AREAL_RAIN_FACTOR_WARN_MIN,
	outsideArealRainBand,
	STATION_PAIRING_MIN_YEARS,
	stationPairingKey,
	type DailySeries,
	type ModelInput,
	type ProjectSettings,
	type RainStationInputs,
	type StationPairingFit,
	type UnitRainReferenceMonth
} from '../project';
import { CHIRPS_FACTOR_MIN_DAYS, CHIRPS_FACTOR_MIN_MM } from '../rain';
import { checkedStationRecord } from './stationRecord';

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

/** The area a pairing corrects the CHIRPS of: a land unit (its node id) or the catchment (null), its own CHIRPS, and the ratio it reads the station at. */
export interface PairingArea {
	id: string | null;
	name: string;
	chirps: DailySeries | null | undefined;
	ratio: number;
}

/**
 * Fit one station's pairing with one area (see the header). Refused (a plain
 * reason in `refused`, months []) without a record for the station, without
 * CHIRPS for the area, or with fewer than STATION_PAIRING_MIN_YEARS complete
 * years in common. A refusal and each month's warning go to `warnings`
 * ("station pairing: …"). The record checks' own warnings are left to the
 * forcing, which reads the same record.
 */
export function fitStationPairing(
	args: { settings: ProjectSettings; series: ModelInput['series']; stations: RainStationInputs; stationId: string; area: PairingArea },
	warnings: string[]
): StationPairingFit {
	const { settings, series, stations, stationId, area } = args;
	const stationName = stations[stationId]?.name ?? stationId;
	const who = `station pairing: "${stationName}" for ${area.id === null ? 'the catchment' : `"${area.name}"`}`;
	const chirpsAt: StationPairingFit['chirpsAt'] = area.id === null ? { catchment: true } : { unitId: area.id, unitName: area.name };
	const chirps = area.chirps && area.chirps.values.length ? area.chirps : null;
	const r = Number.isFinite(area.ratio) && area.ratio > 0 ? area.ratio : 1;
	const checked = checkedStationRecord(settings, series, stationId, { fitExcludeAccumulations: true, name: stationName, isCatchmentGauge: stations[stationId]?.isCatchmentGauge === true });
	// The station's rain at the area's level: × r (a constant, so the complete years are the record's own).
	const rec = checked ? (r === 1 ? checked.record : { startDate: checked.record.startDate, values: checked.record.values.map((v) => (reading(v) ? v * r : v)) }) : null;
	// The factors read the fit's record (accumulation windows left out); the complete years, the forcing's.
	const c = rec && chirps ? { ...common(rec, chirps), years: completeYears(checked!.forcing ?? checked!.record, chirps) } : null;

	const key = stationPairingKey(stationId, area.id);
	const pinnedRaw = settings.rainStations?.pinnedFactors?.[key];
	const pinned = validPinned(pinnedRaw) ? pinnedRaw : null;
	if (pinnedRaw != null && !pinned) warnings.push(`${who}: its pinned factors aren’t 12 positive numbers, so they are fitted instead`);

	const base = {
		stationId,
		stationName,
		areaId: area.id,
		areaName: area.name,
		ratio: r,
		chirpsAt,
		fitFrom: c?.first != null ? fromEpochDay(c.first) : null,
		fitTo: c?.last != null ? fromEpochDay(c.last) : null,
		commonYears: c?.years ?? 0,
		days: c ? c.n.reduce((s, x) => s + x, 0) : 0
	};

	if (!pinned) {
		const refused = !rec
			? 'the station has no record'
			: !chirps
				? `${area.id === null ? 'the catchment has' : `"${area.name}" has`} no CHIRPS of its own`
				: c!.years < STATION_PAIRING_MIN_YEARS
					? `the station and ${area.id === null ? 'the catchment’s' : `"${area.name}"’s`} CHIRPS have ${c!.years} complete calendar ${c!.years === 1 ? 'year' : 'years'} in common (every day a reading in both), fewer than ${STATION_PAIRING_MIN_YEARS}`
					: null;
		if (refused) {
			warnings.push(`${who} is refused: ${refused}. Its CHIRPS isn’t corrected against it`);
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
				`${who}: the station and the CHIRPS have too little in common in ${short.length === 12 ? 'every month' : short.map((x) => MONTH_NAMES[x.month - 1]).join(', ')} (fewer than ${CHIRPS_FACTOR_MIN_DAYS} shared days, or under ${CHIRPS_FACTOR_MIN_MM} mm of CHIRPS on them), so ${short.length === 1 ? 'that month’s factor is' : 'those months’ factors are'} 1`
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
