// The catchment flow charts' series, shared by the Runs tab (RunCharts) and
// the printable report: which lines, in which colour, width and style.
import { OBSERVED_SERIES_LABEL, type DailySeries } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';
import { fmtNum } from '$lib/format/number';

/** The run's catchment series the flow charts draw (each absent when the run has none). */
export interface CatchmentFlows {
	natural?: DailySeries;
	simulated?: DailySeries;
	/** The run's calibration record: the gauge or the logger. */
	observed?: DailySeries;
	/** The other record, when the project has both (engine ≥ 0.39.0): shown, never scored. */
	observedOther?: DailySeries;
	ewr?: DailySeries;
}

/** The run series key behind each slot. */
export const CATCHMENT_FLOW_KEYS: [keyof CatchmentFlows, string][] = [
	['natural', 'natural_flow'],
	['simulated', 'simulated_outflow'],
	['observed', 'observed_flow'],
	['observedOther', 'observed_flow_other'],
	['ewr', 'ewr']
];

/** Converts a series' m³/day values to the chart's unit. */
type Convert = (d: DailySeries) => (number | null)[];

/** A flow record by instrument. */
export type FlowRecord = 'gauge' | 'logger';

/** Which record each observed slot holds; absent = unknown (then the label says only "Observed"). */
export interface ObservedSources {
	observed?: FlowRecord;
	observedOther?: FlowRecord;
}

const recordOf = (label: string): FlowRecord => (label === OBSERVED_SERIES_LABEL.flow_logger_m3s ? 'logger' : 'gauge');

/**
 * The records behind a run's observed series, read from their stored labels
 * (the engine's OBSERVED_SERIES_LABEL: "Observed flow" is the gauge,
 * "Observed flow (logger)" the logger), so runs made before the other record
 * was written are labelled right too.
 */
export function observedSources(refs: readonly { key: string; nodeId: string | null; label: string }[]): ObservedSources {
	const at = (key: string) => refs.find((r) => r.key === key && r.nodeId === null);
	const obs = at('observed_flow');
	const other = at('observed_flow_other');
	return { ...(obs ? { observed: recordOf(obs.label) } : {}), ...(other ? { observedOther: recordOf(other.label) } : {}) };
}

/**
 * The legend labels of the observed series: by instrument, and with both
 * shown, which one the run is scored against ("calibration record").
 */
export function observedLabels(src: ObservedSources): { observed: string; observedOther: string } {
	const name = (r: FlowRecord | undefined) => (r ? `Observed ${r}` : 'Observed');
	return src.observedOther
		? { observed: `${name(src.observed)} (calibration record)`, observedOther: name(src.observedOther) }
		: { observed: name(src.observed), observedOther: name(src.observedOther) };
}

/** The hydrograph caption's sentence on observed flow: how it is drawn, and which record is scored when both are shown. */
export function observedCaption(c: CatchmentFlows, src: ObservedSources): string {
	if (!(c.observed && c.observedOther)) return 'Observed flow is a line broken wherever the record has no reading (a lone reading is a dot).';
	const l = observedLabels(src);
	return `${l.observed} is the solid line and ${l.observedOther} the dashed one, shown but not scored; each breaks wherever its record has no reading (a lone reading is a dot).`;
}

/**
 * The hydrograph: observed (the calibration record, then the other record
 * when both exist) under simulated outflow, and natural flow (hidden at
 * first on screen, since it dwarfs the rest). The other record is dashed
 * and in its own colour, so the two read apart without colour too.
 */
export function hydrographSeries(c: CatchmentFlows, conv: Convert, hideNatural = true, src: ObservedSources = {}): ChartSeries[] {
	const out: ChartSeries[] = [];
	const l = observedLabels(src);
	if (c.observed) out.push({ label: l.observed, startDate: c.observed.startDate, values: conv(c.observed), color: '--chart-obs', width: 1.5 });
	if (c.observedOther) out.push({ label: l.observedOther, startDate: c.observedOther.startDate, values: conv(c.observedOther), color: '--series-4', width: 1.5, style: 'dashed' });
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

/**
 * The flow-duration chart's caption: which days its curves rank. On a
 * forecast run it says the forecast days are left out (issue #51), since
 * the curves rank the history only. Undefined when there is nothing to say.
 */
export function fdcCaption(f: { onObserved: boolean; partial: boolean; obsDays: number; runDays: number; forecastDays: number }): string | undefined {
	const days = f.onObserved
		? `Every curve ranks the ${fmtNum(f.obsDays)} days with an observed reading, so they compare like with like.`
		: f.partial
			? `Natural and simulated flow rank all ${fmtNum(f.runDays)} days of the run${f.forecastDays ? ' before the forecast' : ''}; observed flow only its ${fmtNum(f.obsDays)} days with a reading.`
			: '';
	const forecast = f.forecastDays ? `The ${fmtNum(f.forecastDays)} forecast days are left out: the curves rank the history only.` : '';
	return [days, forecast].filter(Boolean).join(' ') || undefined;
}
