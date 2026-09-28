// The report's flow-duration percentile table (issue #45): the Runs tab's FDC
// Q10–Q95 table, from the same engine function (views/fdc.ts) the chart and
// the exports read, in m³/s, on the days the chart shows by default.
import type { FdcPercentileRow, FdcPercentileTable, FdcRecord } from '@water-management/engine';
import { fmtNum, fmtQty } from '$lib/format/number';

const LABEL: Record<FdcRecord, string> = { natural: 'Natural', simulated: 'Simulated outflow', observed: 'Observed' };

/** The table's rows as text: the chart's default days (the observed record's, when it misses some of the run). */
export function fdcReportRows(t: FdcPercentileTable): string[][] {
	const rows: FdcPercentileRow[] = t.onObservedDays ?? t.wholeRun;
	return rows.map((r) => [LABEL[r.record], ...[r.q10, r.q50, r.q90, r.q95].map((v) => fmtQty(v, 3)), fmtNum(r.n)]);
}

/** Which days the table ranks, for its title. */
export function fdcReportDays(t: FdcPercentileTable): string {
	const days = t.onObservedDays
		? `every record on the ${fmtNum(t.observedDays)} days with an observed reading`
		: `all ${fmtNum(t.runDays)} days of the run`;
	// A forecast run's table ranks its history only (issue #51).
	return t.forecastDays > 0 ? `${days} before the forecast (its ${fmtNum(t.forecastDays)} forecast days left out)` : days;
}
