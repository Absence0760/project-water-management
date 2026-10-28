// Invented seasonal forecasts and hindcasts for the forecast-conditioned
// outlook's tests (synthetic: no real forecast, farm or value). Each system's
// members are built from the base run's own monthly rain for the year they
// stand for:
//   skilful      the year's own totals × a wet bias × a small spread, so a
//                quantile map has a bias to take out and the members know the
//                season;
//   climatology  another year's totals × the spread, chosen at random: no
//                knowledge of the season;
//   mirror       the year's rank mirrored across the hindcast years (the
//                driest stands for the wettest): confidently wrong.
import { fromEpochDay, toEpochDay } from '../calendar';
import { Rng } from '../random';
import type { OutlookBaseRun } from './outlook';
import type { SeasonalForecastSystem, SeasonalHindcastSystem } from './forecast';

export type SyntheticKind = 'skilful' | 'climatology' | 'mirror';

const monthFirst = (y: number, m0: number) => toEpochDay(`${String(y + Math.floor(m0 / 12)).padStart(4, '0')}-${String((m0 % 12) + 1).padStart(2, '0')}-01`);

/** The base run's rain_final over the calendar month `m0` (0-based, may pass 11) of year `y`. */
export function monthRain(baseRun: OutlookBaseRun, y: number, m0: number): number {
	const rain = baseRun.series.find((x) => x.nodeId === null && x.key === 'rain_final')!.values;
	const r0 = toEpochDay(baseRun.startDate);
	let sum = 0;
	for (let d = monthFirst(y, m0); d < monthFirst(y, m0 + 1); d++) sum += rain[d - r0]!;
	return sum;
}

export interface SyntheticOptions {
	id: string;
	kind: SyntheticKind;
	members: number;
	/** Init calendar month, 1 … 12. */
	initMonth: number;
	/** Months each member gives. */
	leads: number;
	hindcastYears: readonly number[];
	/** The forecast's init year (its months are the record's, as a test catchment's season is inside it). */
	forecastYear: number;
	seed?: number;
}

export function syntheticSystem(baseRun: OutlookBaseRun, o: SyntheticOptions): { forecast: SeasonalForecastSystem; hindcast: SeasonalHindcastSystem } {
	const rng = new Rng(o.seed ?? 11);
	const m0 = o.initMonth - 1;
	const truth = (y: number) => Array.from({ length: o.leads }, (_, l) => monthRain(baseRun, y, m0 + l));
	const years = [...o.hindcastYears];
	const mirrorOf = (y: number) => {
		// Per lead: the year whose total ranks opposite this one's.
		return Array.from({ length: o.leads }, (_, l) => {
			const sorted = years.map((x) => monthRain(baseRun, x, m0 + l)).sort((a, b) => a - b);
			const v = monthRain(baseRun, y, m0 + l);
			const r = sorted.findIndex((x) => x >= v);
			return sorted[sorted.length - 1 - Math.max(0, r)]!;
		});
	};
	const membersFor = (y: number) =>
		Array.from({ length: o.members }, () => {
			const base = o.kind === 'skilful' ? truth(y) : o.kind === 'mirror' ? mirrorOf(y) : truth(years[rng.int(0, years.length - 1)]!);
			const bias = o.kind === 'skilful' ? 1.6 : 1;
			return { monthlyMm: base.map((v) => Math.round(v * bias * rng.float(0.92, 1.08) * 100) / 100) };
		});
	return {
		forecast: { system: o.id, init: `${o.forecastYear}-${String(o.initMonth).padStart(2, '0')}`, members: membersFor(o.forecastYear) },
		hindcast: { system: o.id, initMonth: o.initMonth, years: years.map((year) => ({ year, members: membersFor(year) })) }
	};
}

export const isoOf = fromEpochDay;
