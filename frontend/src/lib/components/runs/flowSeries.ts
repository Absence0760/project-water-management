// The catchment flow charts' series, shared by the Runs tab (RunCharts) and
// the printable report: which lines, in which colour, width and style.
import type { DailySeries } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';

/** The run's catchment series the flow charts draw (each absent when the run has none). */
export interface CatchmentFlows {
	natural?: DailySeries;
	simulated?: DailySeries;
	observed?: DailySeries;
	ewr?: DailySeries;
}

/** The run series key behind each slot. */
export const CATCHMENT_FLOW_KEYS: [keyof CatchmentFlows, string][] = [
	['natural', 'natural_flow'],
	['simulated', 'simulated_outflow'],
	['observed', 'observed_flow'],
	['ewr', 'ewr']
];

/** Converts a series' m³/day values to the chart's unit. */
type Convert = (d: DailySeries) => (number | null)[];

/** The hydrograph: observed under simulated outflow, and natural flow (hidden at first on screen, since it dwarfs the rest). */
export function hydrographSeries(c: CatchmentFlows, conv: Convert, hideNatural = true): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (c.observed) out.push({ label: 'Observed', startDate: c.observed.startDate, values: conv(c.observed), color: '--chart-obs', width: 1.5 });
	if (c.natural) out.push({ label: 'Natural', startDate: c.natural.startDate, values: conv(c.natural), color: '--series-1', width: 2.25, hidden: hideNatural });
	if (c.simulated) out.push({ label: 'Simulated outflow', startDate: c.simulated.startDate, values: conv(c.simulated), color: '--series-2', width: 1.25 });
	return out;
}

/** Simulated outflow against the pragmatic EWR (a dashed step line). */
export function ewrChartSeries(c: CatchmentFlows, conv: Convert): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (c.simulated) out.push({ label: 'Simulated outflow', startDate: c.simulated.startDate, values: conv(c.simulated), color: '--series-2', width: 1.25 });
	if (c.ewr) out.push({ label: 'Pragmatic EWR', startDate: c.ewr.startDate, values: conv(c.ewr), style: 'step', color: '--chart-ref', width: 1.75 });
	return out;
}
