// The run's flow-duration percentile table for the summary CSV (and so the
// .xlsx workbook, which spreads that CSV over its sheets): the catchment's
// natural flow, simulated outflow and observed flow, in m³/s, through the
// engine's fdcPercentileTable, the function the Runs tab's FDC table reads.
// A forecast run's forecast days are cut off first (issue #51): the table is
// the history's, equal to an ordinary run's.
import { fdcPercentileTable, m3DayToM3sSeries, type FdcPercentileTable, type FdcRecord, type FdcRunDays } from '@water-management/engine';
import type { Db } from '../db/tx.js';

/** run_series key → the FDC record it is (frontend runs/flowSeries.ts CATCHMENT_FLOW_KEYS). */
export const FDC_SERIES_KEYS: Record<string, FdcRecord> = { natural_flow: 'natural', simulated_outflow: 'simulated', observed_flow: 'observed' };

/**
 * The table from the catchment series (m³/day, as run_series stores them),
 * keyed by run_series key. `run`: the run's start day and, on a forecast
 * run, its first forecast day (summary.forecast.from), so the forecast days
 * are left out.
 */
export function flowDurationTable(series: readonly { key: string; values: readonly (number | null)[] }[], run?: FdcRunDays): FdcPercentileTable {
	const flows: Partial<Record<FdcRecord, (number | null)[]>> = {};
	for (const s of series) {
		const record = FDC_SERIES_KEYS[s.key];
		if (record) flows[record] = m3DayToM3sSeries(s.values);
	}
	return fdcPercentileTable(flows, run);
}

/** The run's table, read under the caller's RLS context (`run` as flowDurationTable's). */
export async function loadFlowDuration(db: Db, runId: string, run: FdcRunDays): Promise<FdcPercentileTable> {
	const { rows } = await db.query<{ key: string; values: (number | null)[] }>(
		`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = ANY($2::text[])`,
		[runId, Object.keys(FDC_SERIES_KEYS)]
	);
	return flowDurationTable(rows, run);
}
