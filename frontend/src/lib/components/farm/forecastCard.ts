// "Next 14 days" on the farm page (design §3 Q1, E2; WP-2.12): the lowest dam
// level expected, around which day, and the days the farm may be short, from
// the published forecast run. Worded as what the model expects on forecast
// rain, never as what will happen, and with the day the forecast was made so
// an old one reads as old.
import type { FarmProjection } from '@water-management/engine';
import { daysBetween, fmtDayMonth, fmtPct, plural } from './format';

export interface ForecastVm {
	/** "Next 14 days". */
	title: string;
	/** "Lowest dam level expected: about 38 % around 3 Oct", or null without a dam. */
	dam: string | null;
	/** "You may be short on 3 of the 14 days", or the none line. */
	short: string;
	/** "From the rain forecast of 26 Sep. Forecasts change: …". */
	fine: string;
	/** The forecast was made more than FORECAST_OLD_DAYS before today: say so first. */
	old: string | null;
}

/** A forecast older than this many days is flagged on the card. */
export const FORECAST_OLD_DAYS = 3;

export const FORECAST_FINE = 'Forecasts change, and this is worked out by the model, not a promise. Only a notice from your WUA is a restriction.';

/** The card's view model, or null when the published run has no forecast (the card is left out). */
export function forecastCard(farm: FarmProjection, today: string): ForecastVm | null {
	const f = farm.forecast;
	if (!f) return null;
	const age = daysBetween(f.madeOn, today);
	return {
		title: `Next ${plural(f.days, 'day')}`,
		dam: f.minDamPct === null ? null : `Lowest dam level expected: about ${fmtPct(f.minDamPct)}${f.minDamDate ? ` around ${fmtDayMonth(f.minDamDate)}` : ''}`,
		short: f.deficitDays === 0 ? `The model doesn’t expect you to be short on any of these ${f.days} days.` : `You may be short on ${f.deficitDays} of the ${f.days} days.`,
		fine: `From the rain forecast of ${fmtDayMonth(f.madeOn)}, for ${fmtDayMonth(f.from)} to ${fmtDayMonth(f.to)}. ${FORECAST_FINE}`,
		old: age > FORECAST_OLD_DAYS ? `This forecast is ${plural(age, 'day')} old. Your WUA may publish a newer one.` : null
	};
}
