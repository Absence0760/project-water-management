// "Data up to": the last day a series has a value, never the last day it
// stores. A merge keeps blank days as null (a gap, or a logger reporting "no
// reading" for today), so start_date + cardinality("values") − 1 would count
// a dead sensor's blanks as fresh data. Every freshness figure (the project
// list's and the portfolio's `dataUntil`, the series list's `lastValueDate`,
// the forecast run's staleness) counts to the last value instead. SQL
// fragments, so each query keeps its one round-trip.

/** Recorded rain: what a run is driven by, so what freshness measures (a forecast runs ahead, observed flow only scores a run). */
export const RECORDED_RAIN_KINDS = ['rain_catchment_mm', 'rain_chirps_mm'] as const;

/** SQL (a date, or NULL when every value is blank): the last day with a value of the time_series row `alias`. */
export const lastValueDaySql = (alias: string) =>
	`(SELECT ${alias}.start_date + max(lv.o)::int - 1 FROM unnest(${alias}."values") WITH ORDINALITY lv(v, o) WHERE lv.v IS NOT NULL)`;

/** SQL (a date, or NULL): the project's recorded rain end, the last day with a catchment or CHIRPS rain value. */
export const recordedRainUntilSql = (projectExpr: string) =>
	`(SELECT max(${lastValueDaySql('rts')}) FROM time_series rts
		WHERE rts.project_id = ${projectExpr} AND rts.kind IN (${RECORDED_RAIN_KINDS.map((k) => `'${k}'`).join(', ')}))`;
