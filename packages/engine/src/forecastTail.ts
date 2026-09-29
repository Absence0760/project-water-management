// Where a run's forecast tail starts (WP-2.12, model.md § Forecast mode):
// the first day whose rain came from the forecast series after the last day
// of rain from any other source. Two readers: ./forecast.ts splits forecast
// mode's run there, and ./run.ts reads its record-wide statistics over the
// days before it (engine ≥ 1.27.0, engine-audit.md K1), so a forecast tail
// never moves a historical value.
import type { PreparedRun } from './prepare';
import { RAIN_SOURCE_CODE } from './rainSourcePeriods';

/** A prepared run's forecast tail, as day indices into the run. */
export interface ForecastTail {
	/**
	 * The source of each run day's rain, RAIN_SOURCE_CODE (0 catchment,
	 * 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast), NaN for none.
	 */
	source: Float64Array;
	/** The last day with rain from a source other than the forecast; −1 when none did. */
	lastObserved: number;
	/**
	 * The first forecast-rain day after lastObserved; −1 when there is none,
	 * or when no day has rain from another source (nothing observed to split
	 * from).
	 */
	from: number;
	/**
	 * The run's historical days: `from` when there is a tail, else every day.
	 * The record-wide statistics read days 0 … historyDays − 1 only.
	 */
	historyDays: number;
}

/**
 * The forecast tail of a prepared run. Reads the rain exactly as the run
 * does (zero runs set aside, accumulations spread, rain-source periods,
 * CHIRPS blocked where it may not fill), so a day counts as forecast only
 * when the forecast is the rain the model used on it.
 */
export function forecastTail(prep: Pick<PreparedRun, 'days' | 'aligned' | 'rainSource'>): ForecastTail {
	const { days } = prep;
	let source: Float64Array;
	if (prep.rainSource) source = prep.rainSource.column;
	else {
		const catchment = prep.aligned('rain_catchment_mm');
		const chirps = prep.aligned('rain_chirps_mm');
		const forecast = prep.aligned('rain_forecast_mm');
		source = new Float64Array(days);
		for (let t = 0; t < days; t++) {
			source[t] =
				catchment[t] != null
					? RAIN_SOURCE_CODE.catchment
					: chirps[t] != null
						? RAIN_SOURCE_CODE.chirps
						: forecast[t] != null
							? RAIN_SOURCE_CODE.forecast
							: NaN;
		}
	}
	let last = -1;
	for (let t = 0; t < days; t++) if (!Number.isNaN(source[t]!) && source[t] !== RAIN_SOURCE_CODE.forecast) last = t;
	let from = -1;
	if (last >= 0) {
		for (let t = last + 1; t < days; t++) {
			if (source[t] === RAIN_SOURCE_CODE.forecast) {
				from = t;
				break;
			}
		}
	}
	return { source, lastObserved: last, from, historyDays: from >= 0 ? from : days };
}
