// "Next 14 days" on the farm page (design §3 Q1, E2; WP-2.12): the lowest dam
// level expected, around which day, and the days the farm may be short, from
// the published forecast run. Worded as what the model expects on forecast
// rain, never as what will happen, and with the day the forecast was made so
// an old one reads as old. Words from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmProjection } from '@water-management/engine';
import { t } from '$lib/i18n/locale.svelte';
import { count, daysBetween, fmtDayMonth, fmtPct } from './format';

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

export const forecastFine = () => t('farm.forecast.fine');

/** The card's view model, or null when the published run has no forecast (the card is left out). */
export function forecastCard(farm: FarmProjection, today: string): ForecastVm | null {
	const f = farm.forecast;
	if (!f) return null;
	const age = daysBetween(f.madeOn, today);
	return {
		title: t('farm.forecast.title', { days: count('farm.n.day', f.days) }),
		dam:
			f.minDamPct === null
				? null
				: f.minDamDate
					? t('farm.forecast.damAround', { pct: fmtPct(f.minDamPct), date: fmtDayMonth(f.minDamDate) })
					: t('farm.forecast.dam', { pct: fmtPct(f.minDamPct) }),
		short: f.deficitDays === 0 ? t('farm.forecast.noShort', { days: f.days }) : t('farm.forecast.short', { n: f.deficitDays, days: f.days }),
		fine: `${t('farm.forecast.from', { made: fmtDayMonth(f.madeOn), from: fmtDayMonth(f.from), to: fmtDayMonth(f.to) })} ${forecastFine()}`,
		old: age > FORECAST_OLD_DAYS ? t('farm.forecast.old', { age: count('farm.n.day', age) }) : null
	};
}
