// "Where the water went": a run's whole-period water balance
// (RunSummary.waterBalance.total, engine ≥ 0.11.0) told as yearly averages on
// the help illustration's eight stops, rain to outlet. Pure, so it is tested
// without a page.
import type { RunSummary, WaterBalanceRow } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';

export type StorySpot = 'rain' | 'evaporation' | 'runoff' | 'dam' | 'irrigation' | 'transfer' | 'river' | 'outlet';

export interface StoryItem {
	spot: StorySpot;
	title: string;
	/** The headline figure ("48.2 Mm³ a year"); null when the run can't say. */
	value: string | null;
	/** One sentence of context, or why there is no figure. */
	detail: string;
}

const DAYS_PER_YEAR = 365.25;
/** A volume over the run, as Mm³ per year. */
const perYear = (m3: number, days: number) => (m3 * DAYS_PER_YEAR) / days / 1e6;
const mm3a = (v: number) => `${fmtNum(v, v < 10 ? 2 : 1)} Mm³ a year`;
const mm3 = (v: number) => `${fmtNum(v, v < 10 ? 2 : 1)} Mm³`;

/** The eight stops for one run, or null for a run saved before the water balance existed. */
export function waterStory(summary: Pick<RunSummary, 'waterBalance' | 'catchment'>): StoryItem[] | null {
	const wb = summary.waterBalance;
	if (!wb || !(wb.total.days > 0)) return null;
	const t: WaterBalanceRow = wb.total;
	const days = t.days;
	const years = days / DAYS_PER_YEAR;
	const area = wb.areaKm2;
	const rainM3 = t.rainMm != null && area ? t.rainMm * area * 1000 : null;
	const natural = perYear(t.naturalFlowM3, days);
	const outflow = perYear(t.outflowM3, days);

	const rain: StoryItem =
		rainM3 != null
			? {
					spot: 'rain',
					title: 'Rain on the catchment',
					value: mm3a(perYear(rainM3, days)),
					detail: `${fmtNum(t.rainMm! / years)} mm a year over ${fmtNum(area, 1)} km², after gaps were filled.`
				}
			: { spot: 'rain', title: 'Rain on the catchment', value: null, detail: 'The run has no rain series or no catchment area.' };

	const evaporation: StoryItem =
		t.runoff && area
			? {
					spot: 'evaporation',
					title: 'Evaporated',
					value: mm3a(perYear(t.runoff.aetMm * area * 1000, days)),
					detail: `${t.rainMm ? fmtPct(t.runoff.aetMm / t.rainMm, 0) : '–'} of the rain went back to the air from soil and plants.`
				}
			: {
					spot: 'evaporation',
					title: 'Evaporated',
					value: null,
					detail: 'The legacy runoff model doesn’t track evaporation; GR4J runs do.'
				};

	const coef = t.runoffCoefficient ?? summary.catchment.runoffCoefficient ?? null;
	const runoff: StoryItem = {
		spot: 'runoff',
		title: 'Natural flow',
		value: mm3a(natural),
		detail:
			coef != null
				? `${fmtPct(coef, 0)} of the rain became flow: the river as it would be with no farms.`
				: 'The river as it would be with no farms.'
	};

	const dam: StoryItem = {
		spot: 'dam',
		title: 'Farm dams',
		value: `${mm3a(perYear(t.spillM3, days))} spilled`,
		detail: `Storage went from ${mm3(t.openingStorageM3 / 1e6)} at the start to ${mm3(t.closingStorageM3 / 1e6)} at the end.`
	};

	const irrigation: StoryItem = {
		spot: 'irrigation',
		title: 'Irrigation supplied',
		value: mm3a(perYear(t.suppliedM3, days)),
		detail:
			t.demandM3 > 0
				? `${fmtPct(t.suppliedM3 / t.demandM3, 0)} of the demand of ${mm3a(perYear(t.demandM3, days))}; ${mm3a(perYear(t.returnFlowM3, days))} ran back to the river.`
				: 'No irrigation demand in this run.'
	};

	const transfer: StoryItem = {
		spot: 'transfer',
		title: 'Transfers',
		value: null,
		detail: 'Transfers only move water between dams, so across the catchment they add up to nothing.'
	};

	const river: StoryItem = {
		spot: 'river',
		title: 'EWR in the river',
		value: `not met on ${fmtPct(summary.catchment.ewrFractionDaysNotMet, 0)} of days`,
		detail: `${fmtNum(summary.catchment.ewrDaysNotMet)} of ${fmtNum(days)} days at the outlet fell below the EWR.`
	};

	const outlet: StoryItem = {
		spot: 'outlet',
		title: 'Outflow at the outlet',
		value: mm3a(outflow),
		detail: natural > 0 ? `${fmtPct(outflow / natural, 0)} of the natural flow reached the outlet.` : 'No natural flow in this run.'
	};

	return [rain, evaporation, runoff, dam, irrigation, transfer, river, outlet];
}
