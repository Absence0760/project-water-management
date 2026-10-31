// The checks-only gauges' flows (issue #554): every gauge inside the network
// with a flow record of its own that the run doesn't score (not the
// calibration site) gets a hydrograph and a flow-duration curve under the
// outlet's, from the run's `observed_flow_check` at the gauge (engine ≥
// 1.90.0) against its `outflow`, with the record's NSE, KGE and PBIAS as an
// out-of-sample check, read from the run summary (plausibility.gauges[].fit,
// computed once by the engine). Pure; ModelQuality's GaugeCheckFlows draws it.
import {
	beforeForecast,
	CHECK_GAUGE_FLOW_KEY,
	flowDurationCurves,
	onDaysOf,
	type CalibrationFlowKind,
	type DailySeries,
	type GaugeFitCheck,
	type GaugePlausibility
} from '@water-management/engine';
import type { ChartSeries } from '#lib/components/charts/series.js';
import { fmtNum } from '#lib/format/number.js';

type RefLike = { key: string; nodeId: string | null };
type Convert = (d: DailySeries) => (number | null)[];

/** A checks-only gauge on the page: drawn when the run stored its record, else a "re-run" line. */
export interface CheckGauge {
	nodeId: string;
	name: string;
	/** The record the run checks there (the plausibility checks' own). */
	flowKind: CalibrationFlowKind;
	/** The run stored `observed_flow_check` at the gauge: false on a run made before engine 1.90.0. */
	stored: boolean;
	/** The record's fit there, from the run summary (GaugePlausibility.fit): null when no day is read, undefined on a run made before 1.90.0. */
	fit?: GaugeFitCheck | null;
}

/**
 * The run's checks-only gauges, in the network's order (`order`, the page's
 * node order; the plausibility checks' node-id order is meaningless to a
 * reader): each gauge they checked (a gauge inside the network with its own
 * record), less the ones the run scores (`scored`, scoredGaugeIds: the
 * headline location's and every other ticked location's), whose records are
 * calibration scores, not checks.
 */
export function checksOnlyGauges(
	gauges: readonly Pick<GaugePlausibility, 'nodeId' | 'name' | 'flowKind' | 'fit'>[] | undefined,
	refs: readonly RefLike[],
	scored: ReadonlySet<string>,
	order: ReadonlyMap<string, number> = new Map()
): CheckGauge[] {
	const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
	return (gauges ?? [])
		.filter((g) => !scored.has(g.nodeId))
		.map((g) => ({
			nodeId: g.nodeId,
			name: g.name,
			flowKind: g.flowKind,
			stored: refs.some((r) => r.key === CHECK_GAUGE_FLOW_KEY && r.nodeId === g.nodeId),
			...(g.fit !== undefined ? { fit: g.fit } : {})
		}))
		.sort((a, b) => rank(a.nodeId) - rank(b.nodeId));
}

/** The statistics in a line: "NSE 0.62 · KGE 0.71 · PBIAS −4.2 % over 1 204 days". */
export function gaugeStatsText(s: GaugeFitCheck): string {
	const n = (v: number | null, d: number) => (v === null ? '–' : fmtNum(v, d));
	return `NSE ${n(s.nse, 2)} · KGE ${n(s.kge, 2)} · PBIAS ${s.pbias === null ? '–' : `${fmtNum(s.pbias, 1)} %`} over ${fmtNum(s.days)} day${s.days === 1 ? '' : 's'}`;
}

/** The words after "Check, out of sample:": the summary's fit, why there is none, or that the run predates it. */
export function gaugeStatsLine(fit: GaugeFitCheck | null | undefined): string {
	if (fit) return `${gaugeStatsText(fit)}.`;
	return fit === null ? 'no day of the record falls in the run outside its excluded periods.' : 'not in this run’s summary: run the model again.';
}

/** The record's legend label by instrument: "Observed gauge", "Observed logger" (the chart's title says it is checks only). */
export const checkRecordLabel = (kind: CalibrationFlowKind) => (kind === 'flow_logger_m3s' ? 'Observed logger' : 'Observed gauge');

/** The hydrograph: the gauge's record under the simulated flow there, as the calibration site's chart draws them. */
export function checkHydrograph(observed: DailySeries, simulated: DailySeries, kind: CalibrationFlowKind, conv: Convert): ChartSeries[] {
	return [
		{ label: checkRecordLabel(kind), startDate: observed.startDate, values: conv(observed), color: '--chart-obs', width: 1.5 },
		{ label: 'Simulated flow', startDate: simulated.startDate, values: conv(simulated), color: '--series-2', width: 1.25 }
	];
}

/**
 * The flow-duration curves: the record and the simulated flow, both on the
 * record's days (like with like) before any forecast.
 */
export function checkFdc(observed: DailySeries, simulated: DailySeries, kind: CalibrationFlowKind, conv: Convert, forecastFrom: string | null = null): { series: ChartSeries[]; xy: ReturnType<typeof flowDurationCurves> } {
	const obs = Array.from(beforeForecast(conv(observed), observed.startDate, forecastFrom));
	const sim = onDaysOf(Array.from(beforeForecast(conv(simulated), simulated.startDate, forecastFrom)), obs);
	return {
		xy: flowDurationCurves([sim, obs]),
		series: [
			{ label: 'Simulated flow', startDate: simulated.startDate, values: [], color: '--series-2', width: 1.5 },
			{ label: checkRecordLabel(kind), startDate: observed.startDate, values: [], color: '--chart-obs', width: 1.5, style: 'dashed' }
		]
	};
}

/** The Data tab's Series details of the record the gauge's chart reads, where its Upload unit is; null when the project no longer has it. */
export function recordHref(series: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null | undefined, nodeId: string, kind: CalibrationFlowKind): string | null {
	const s = series?.find((x) => x.kind === kind && x.siteNodeId === nodeId);
	return s ? `?tab=series&series=${encodeURIComponent(s.id)}#data-chart` : null;
}
