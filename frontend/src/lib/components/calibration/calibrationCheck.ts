// The calibration check (issue #444): at each gauge the run has an observed
// record for (the outlet; the calibration site inside the network, engine ≥
// 1.41.0), observed against simulated flow beside the natural flow above that
// gauge and the abstraction demand upstream of it, on one axis, with the bed
// losses in the reaches above it when the run has any (engine ≥ 1.75.0,
// docs/model.md §2.6b). Simulated should track observed; natural sits above
// simulated by roughly the water used upstream plus what those reaches lose;
// and where the demand line rises, abstraction is what pulls simulated below
// natural. A forecast run's chart stops where its forecast starts: there is
// no observed flow to check against after it. Built from series every run
// already stores, summed here (no engine change): pure, unit-tested in
// calibrationCheck.test.ts.
import { beforeForecast, toEpochDay, type DailySeries } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';
import { upstreamOf } from '$lib/components/network/reorder';

type RefLike = { key: string; nodeId: string | null };
/** A node of the run's own network, as much as the check reads. */
export type CheckNode = { id: string; kind: string; downstreamNodeId: string | null };
type NodeLike = CheckNode;

export interface SeriesKey {
	key: string;
	nodeId: string | null;
}

/**
 * The gauges with an observed record in the run, in page order: the outlet
 * (node null) when the run stored its `observed_flow`, then the calibration
 * site, whose record the run stores as that node's `observed_flow`.
 */
export function checkGauges(refs: readonly RefLike[]): (string | null)[] {
	const out: (string | null)[] = [];
	if (refs.some((r) => r.key === 'observed_flow' && r.nodeId === null)) out.push(null);
	for (const r of refs) if (r.key === 'observed_flow' && r.nodeId !== null && !out.includes(r.nodeId)) out.push(r.nodeId);
	return out;
}

/**
 * The nodes whose water reaches the gauge: every node for the outlet; for a
 * node inside the network, itself (a calibration site can be a unit, whose
 * outflow carries its own runoff and abstraction) and everything upstream.
 */
export function contributors(nodes: readonly NodeLike[], gauge: string | null): Set<string> {
	if (gauge === null) return new Set(nodes.map((n) => n.id));
	return new Set([gauge, ...upstreamOf(nodes, gauge)]);
}

/** The run series one gauge's chart is built from. */
export interface CheckKeys {
	observed: SeriesKey;
	simulated: SeriesKey | null;
	/**
	 * Summed to the natural flow above the gauge: the outlet's `natural_flow`
	 * (the catchment's, including any flow share no unit received); inside the
	 * network each contributing unit's `runoff` plus its `landcover_reduction`
	 * (the unit's natural runoff before land cover took its part, natural ×
	 * share, docs/model.md).
	 */
	natural: SeriesKey[];
	/** Summed to the demand upstream: each contributing unit's and other water user's abstraction `demand`. */
	demand: SeriesKey[];
	/**
	 * Summed to the bed losses upstream: the `reach_loss` of every contributing
	 * node but the gauge itself. A node's loss is in the reach below it (the
	 * node below receives its outflow less the loss), so each upstream node's
	 * reach lies on the way to the gauge, and the gauge's own lies below it.
	 * Empty on a run without bed losses (no node stores the series).
	 */
	bedLoss: SeriesKey[];
}

export function checkKeys(refs: readonly RefLike[], nodes: readonly NodeLike[], gauge: string | null): CheckKeys {
	const has = (key: string, nodeId: string | null) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const up = contributors(nodes, gauge);
	const inside = nodes.filter((n) => up.has(n.id));
	const sim = gauge === null ? 'simulated_outflow' : 'outflow';
	const keys = (key: string, list: readonly NodeLike[]) => list.filter((n) => has(key, n.id)).map((n) => ({ key, nodeId: n.id }));
	const farms = inside.filter((n) => n.kind === 'farm');
	return {
		observed: { key: 'observed_flow', nodeId: gauge },
		simulated: has(sim, gauge) ? { key: sim, nodeId: gauge } : null,
		natural: gauge === null ? (has('natural_flow', null) ? [{ key: 'natural_flow', nodeId: null }] : []) : [...keys('runoff', farms), ...keys('landcover_reduction', farms)],
		demand: keys('demand', inside.filter((n) => n.kind === 'farm' || n.kind === 'user')),
		bedLoss: keys('reach_loss', inside.filter((n) => n.id !== gauge))
	};
}

/** Every key of these gauges' charts, each once. */
export function allKeys(list: readonly CheckKeys[]): SeriesKey[] {
	const seen = new Map<string, SeriesKey>();
	for (const k of list) for (const s of [k.observed, k.simulated, ...k.natural, ...k.demand, ...k.bedLoss]) if (s) seen.set(`${s.key}|${s.nodeId}`, s);
	return [...seen.values()];
}

/**
 * Σ of daily series day by day, each placed by its own start date. A day no
 * series has a finite value on is null (a gap, not zero). null for an empty
 * list.
 */
export function sumDaily(list: readonly DailySeries[]): DailySeries | null {
	if (!list.length) return null;
	const starts = list.map((s) => toEpochDay(s.startDate));
	const start = Math.min(...starts);
	const end = Math.max(...list.map((s, i) => starts[i]! + s.values.length));
	const out: (number | null)[] = new Array(Math.max(0, end - start)).fill(null);
	list.forEach((s, i) => {
		const off = starts[i]! - start;
		s.values.forEach((v, j) => {
			if (v == null || !Number.isFinite(v)) return;
			out[off + j] = (out[off + j] ?? 0) + v;
		});
	});
	return { startDate: list[starts.indexOf(start)]!.startDate, values: out as number[] };
}

/** One gauge's lines, each already summed (m³/day). */
export interface CheckFlows {
	observed?: DailySeries;
	simulated?: DailySeries;
	natural?: DailySeries | null;
	demand?: DailySeries | null;
	bedLoss?: DailySeries | null;
}

/**
 * The lines cut before a forecast run's forecast (engine beforeForecast, as
 * RunCharts cuts its flow duration curves): the check reads simulated against
 * observed, and the forecast days have no observed flow, so they're left off
 * rather than drawn in a band. Unchanged for an ordinary run (null).
 */
export function beforeForecastFlows(f: CheckFlows, forecastFrom: string | null | undefined): CheckFlows {
	if (!forecastFrom) return f;
	const cut = <T extends DailySeries | null | undefined>(d: T): T => (d ? ({ startDate: d.startDate, values: Array.from(beforeForecast(d.values, d.startDate, forecastFrom)) } as T) : d);
	return { observed: cut(f.observed), simulated: cut(f.simulated), natural: cut(f.natural), demand: cut(f.demand), bedLoss: cut(f.bedLoss) };
}

/**
 * The chart's lines in the hydrograph's colours (observed, simulated,
 * natural) plus the demand upstream and the bed losses upstream, both dashed
 * so they read apart from the flows without colour too. `conv` turns m³/day
 * into the chart's unit, the same for every line, so the demand and the
 * losses are on the flows' axis.
 */
export function checkSeries(f: CheckFlows, conv: (d: DailySeries) => (number | null)[], observedLabel = 'Observed'): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (f.observed) out.push({ label: observedLabel, startDate: f.observed.startDate, values: conv(f.observed), color: '--chart-obs', width: 1.5 });
	if (f.simulated) out.push({ label: 'Simulated', startDate: f.simulated.startDate, values: conv(f.simulated), color: '--series-2', width: 1.25 });
	if (f.natural) out.push({ label: 'Natural', startDate: f.natural.startDate, values: conv(f.natural), color: '--series-1', width: 1.5 });
	if (f.demand) out.push({ label: 'Upstream demand', startDate: f.demand.startDate, values: conv(f.demand), color: '--series-3', width: 1.25, style: 'dashed' });
	if (f.bedLoss) out.push({ label: 'Bed losses upstream', startDate: f.bedLoss.startDate, values: conv(f.bedLoss), color: '--series-4', width: 1.25, style: 'dashed' });
	return out;
}
