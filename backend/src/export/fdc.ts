// The run's flow-duration percentile table for the summary CSV (and so the
// .xlsx workbook, which spreads that CSV over its sheets): the catchment's
// natural flow, simulated outflow and observed flow, in m³/s, through the
// engine's fdcPercentileTable, the function the Runs tab's FDC table reads.
import { fdcPercentileTable, m3DayToM3sSeries, type FdcPercentileTable, type FdcRecord } from '@water-management/engine';
import type { Db } from '../db/tx.js';

/** run_series key → the FDC record it is (frontend runs/flowSeries.ts CATCHMENT_FLOW_KEYS). */
export const FDC_SERIES_KEYS: Record<string, FdcRecord> = { natural_flow: 'natural', simulated_outflow: 'simulated', observed_flow: 'observed' };

/** The table from the catchment series (m³/day, as run_series stores them), keyed by run_series key. */
export function flowDurationTable(series: readonly { key: string; values: readonly (number | null)[] }[]): FdcPercentileTable {
	const flows: Partial<Record<FdcRecord, (number | null)[]>> = {};
	for (const s of series) {
		const record = FDC_SERIES_KEYS[s.key];
		if (record) flows[record] = m3DayToM3sSeries(s.values);
	}
	return fdcPercentileTable(flows);
}

/** The run's table, read under the caller's RLS context. */
export async function loadFlowDuration(db: Db, runId: string): Promise<FdcPercentileTable> {
	const { rows } = await db.query<{ key: string; values: (number | null)[] }>(
		`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = ANY($2::text[])`,
		[runId, Object.keys(FDC_SERIES_KEYS)]
	);
	return flowDurationTable(rows);
}
