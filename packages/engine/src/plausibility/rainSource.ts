// EWR results split by where each water year's rain came from (engine ≥
// 0.25.0, docs/model.md §2.10d, issue #4 phase 6 plausibility check 2).
//
// A run's rain on a day is a **station** reading when the catchment rain
// series has a value that the run used as recorded: not blank, not set aside
// as a suspect zero run or a listed missing period (CR-20, model.md §2.4c),
// and not a day a multi-day accumulation was spread over (audit B4, §2.4d).
// Every other day is **fallback**: bias-corrected CHIRPS or forecast rain
// filled it, its rain was spread onto it, or nothing did and it ran dry.
//
// A water year is a **fallback year** when more than half its rain (the
// run's final rain, mm) fell on fallback days, or more than half its days
// were fallback days. The day rule catches a year of blanks that ran dry,
// which has almost no fallback rain but no station record either. Every other
// year is a **good-rain year**.
//
// Days the outlet EWR was not met (the pragmatic EWR, the run's headline
// count) are totalled per group, and so are the months met at each Reserve
// rule-table site. Fallback rain is a weaker driver than a station (CHIRPS
// misses small storms and places large ones badly, even after bias
// correction), so a big difference between the groups says how far the EWR
// result leans on the fallback years. It warns when the share of days not met
// differs by RAIN_SOURCE_WARN_DIFF or more. That difference can also be real
// climate (a station out of action through a drought), which is why it only
// warns.
import type { EwrAssuranceSite } from '../reserve/assurance';
import { waterYearLabel, waterYearOf } from '../calendar';

/** A water year is a fallback year when more than this share of its rain, or of its days, is fallback. */
export const FALLBACK_YEAR_SHARE = 0.5;
/** Warn when the share of days (or Reserve months) not met differs between the groups by this much or more. */
export const RAIN_SOURCE_WARN_DIFF = 0.1;

export interface RainSourceYear {
	waterYear: number;
	/** Run days in the water year (fewer at the ends of the run). */
	days: number;
	/** Days with a station reading. */
	stationDays: number;
	/** The run's final rain over the year, mm. */
	rainMm: number;
	/** … of which on fallback days. */
	fallbackRainMm: number;
	/** fallbackRainMm ÷ rainMm; null with no rain. */
	fallbackRainShare: number | null;
	/** (days − stationDays) ÷ days. */
	fallbackDayShare: number;
	fallback: boolean;
	/** Days the outlet EWR was not met. */
	ewrDaysNotMet: number;
}

export interface RainSourceGroup {
	years: number;
	days: number;
	ewrDaysNotMet: number;
	/** ewrDaysNotMet ÷ days; null with no days. */
	fractionNotMet: number | null;
}

export interface RainSourceReserveGroup {
	months: number;
	met: number;
	/** met ÷ months; null with no complete month. */
	rate: number | null;
}

export interface RainSourceReserveSite {
	nodeId: string | null;
	name: string;
	isOutlet: boolean;
	good: RainSourceReserveGroup;
	fallback: RainSourceReserveGroup;
}

export interface RainSourceEwr {
	/** The project has a catchment rain series (without one every year is a fallback year). */
	hasStation: boolean;
	years: RainSourceYear[];
	good: RainSourceGroup;
	fallback: RainSourceGroup;
	/** Per Reserve rule-table site (summary.ewrAssurance order); empty without one. */
	reserve: RainSourceReserveSite[];
}

export interface RainSourceInput {
	start: number;
	/** The run's final rain per day (null = none), mm. */
	rainMm: readonly (number | null)[];
	/** 1 on station days. */
	station: Uint8Array;
	hasStation: boolean;
	/** The outlet's daily EWR shortfall (< 0 = not met). */
	ewrShortfall: ArrayLike<number>;
	reserve: readonly EwrAssuranceSite[];
}

const group = (ys: RainSourceYear[]): RainSourceGroup => {
	const days = ys.reduce((a, y) => a + y.days, 0);
	const notMet = ys.reduce((a, y) => a + y.ewrDaysNotMet, 0);
	return { years: ys.length, days, ewrDaysNotMet: notMet, fractionNotMet: days ? notMet / days : null };
};

/** The split; null for a run without any rain series. */
export function rainSourceEwr(x: RainSourceInput): RainSourceEwr | null {
	const days = x.rainMm.length;
	if (!days) return null;
	const byYear = new Map<number, { days: number; station: number; rain: number; fallbackRain: number; notMet: number }>();
	for (let t = 0; t < days; t++) {
		const wy = waterYearOf(x.start + t);
		let y = byYear.get(wy);
		if (!y) byYear.set(wy, (y = { days: 0, station: 0, rain: 0, fallbackRain: 0, notMet: 0 }));
		y.days++;
		const r = x.rainMm[t];
		const mm = r != null && r > 0 ? r : 0;
		y.rain += mm;
		if (x.station[t]) y.station++;
		else y.fallbackRain += mm;
		if (x.ewrShortfall[t]! < 0) y.notMet++;
	}
	const years: RainSourceYear[] = [...byYear.entries()]
		.sort(([a], [b]) => a - b)
		.map(([waterYear, y]) => {
			const rainShare = y.rain > 0 ? y.fallbackRain / y.rain : null;
			const dayShare = (y.days - y.station) / y.days;
			return {
				waterYear,
				days: y.days,
				stationDays: y.station,
				rainMm: y.rain,
				fallbackRainMm: y.fallbackRain,
				fallbackRainShare: rainShare,
				fallbackDayShare: dayShare,
				fallback: (rainShare !== null && rainShare > FALLBACK_YEAR_SHARE) || dayShare > FALLBACK_YEAR_SHARE,
				ewrDaysNotMet: y.notMet
			};
		});
	const fallbackYears = new Set(years.filter((y) => y.fallback).map((y) => y.waterYear));
	const reserve: RainSourceReserveSite[] = x.reserve.map((site) => {
		const g = { months: 0, met: 0 };
		const f = { months: 0, met: 0 };
		for (const m of site.months) {
			const c = fallbackYears.has(m.waterYear) ? f : g;
			c.months++;
			if (m.met) c.met++;
		}
		const done = (c: { months: number; met: number }): RainSourceReserveGroup => ({ ...c, rate: c.months ? c.met / c.months : null });
		return { nodeId: site.nodeId, name: site.name, isOutlet: site.isOutlet, good: done(g), fallback: done(f) };
	});
	return {
		hasStation: x.hasStation,
		years,
		good: group(years.filter((y) => !y.fallback)),
		fallback: group(years.filter((y) => y.fallback)),
		reserve
	};
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Run warnings: the share of days not met (or Reserve months met) differs by
 * RAIN_SOURCE_WARN_DIFF or more between good-rain and fallback years; or,
 * with a catchment rain series, every year is a fallback year.
 */
export function rainSourceWarnings(r: RainSourceEwr | null): string[] {
	if (!r || !r.fallback.years) return [];
	const list = r.years.filter((y) => y.fallback).map((y) => waterYearLabel(y.waterYear));
	const shown = list.length > 6 ? `${list.slice(0, 6).join(', ')} and ${list.length - 6} more` : list.join(', ');
	if (!r.good.years) {
		return r.hasStation
			? [
					`Every water year of the run is a fallback-rain year (${shown}): most of its rain came from CHIRPS, forecast, spread or blank days, not the catchment station, so the EWR results rest on fallback rain. The Plausibility checks panel lists each year's rain source.`
				]
			: [];
	}
	const out: string[] = [];
	const g = r.good.fractionNotMet;
	const f = r.fallback.fractionNotMet;
	if (g !== null && f !== null && Math.abs(f - g) >= RAIN_SOURCE_WARN_DIFF) {
		out.push(
			`EWR days not met differ by rain source: ${pct(f)} of days in the ${r.fallback.years} fallback-rain water year${r.fallback.years === 1 ? '' : 's'} (${shown}) against ${pct(g)} in the ${r.good.years} good-rain year${r.good.years === 1 ? '' : 's'}. ` +
				'Fallback years ran mostly on CHIRPS, forecast, spread or blank days rather than the catchment station, so part of the EWR result may come from the rain source, not the river. The Plausibility checks panel has the split.'
		);
	}
	for (const s of r.reserve) {
		const a = s.good.rate;
		const b = s.fallback.rate;
		if (a === null || b === null || Math.abs(a - b) < RAIN_SOURCE_WARN_DIFF) continue;
		out.push(
			`Reserve compliance at ${s.isOutlet ? `the outlet (${s.name})` : s.name} differs by rain source: ${pct(b)} of months met in fallback-rain years against ${pct(a)} in good-rain years.`
		);
	}
	return out;
}
