// Display helpers for the Plausibility checks panel (RunSummary.plausibility,
// engine ≥ 0.25.0; docs/model.md §2.10d, docs/ui.md). Pure, unit-tested.
import type { FlowBreakHint, LowFlowCurve, LowFlowCurves, PlausibilityChecks } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { describeMonths } from '$lib/format/months';

const RECORD: Record<string, string> = {
	flow_observed_m3s: 'Gauge',
	flow_logger_m3s: 'Logger',
	simulated_outflow: 'Simulated outflow',
	natural_flow: 'Natural flow'
};

export const MODEL_LABEL: Record<string, string> = { gr4j: 'GR4J', legacy: 'Legacy (workbook)' };
const modelLabel = (m: string | undefined) => MODEL_LABEL[m ?? 'legacy'] ?? m ?? 'legacy';

/** "Gauge", "Simulated outflow on the gauge's days", … */
export function curveLabel(c: Pick<LowFlowCurve, 'source' | 'pairedWith'>): string {
	const base = RECORD[c.source] ?? c.source;
	return c.pairedWith ? `${base} on the ${RECORD[c.pairedWith]!.toLowerCase()}'s days` : base;
}

/** "Nov–Apr (lowest mean flow in the gauge record)". */
export function seasonText(s: PlausibilityChecks['drySeason']): string {
	if (!s) return 'No dry season: no flow record covers every calendar month.';
	const from = s.source === 'natural_flow' ? 'the simulated natural flow' : `the ${RECORD[s.source]!.toLowerCase()} record`;
	return `${describeMonths(s.months)}, the six months with the lowest mean flow in ${from}`;
}

export const HINT_TEXT: Record<FlowBreakHint, string> = {
	rain: 'The model shows the same change with the same rain: the rain did it.',
	newUse: 'The dry season lost more than the wet season: points to new use upstream (abstraction, dams filling).',
	gauge: 'Points to the gauge (a rating change, or floods bypassing or drowning the weir), not new use.',
	unclear: 'The seasons don’t say whether new use or the gauge did it.'
};

/** The hint for a break, with a rise named as such (new use can't raise flow). */
export function breakHint(b: { hint: FlowBreakHint; unexplained: number | null }): string {
	if (b.hint === 'gauge' && b.unexplained !== null && b.unexplained > 0) return 'A rise, which new use can’t cause: look at the gauge’s rating, or use that stopped.';
	return HINT_TEXT[b.hint];
}

/**
 * The latest run of each other runoff model (runs are listed newest first),
 * for overlaying its simulated low-flow curve. The shown run is never included.
 */
export function otherModelRuns(runs: readonly RunMeta[], shown: Pick<RunMeta, 'id' | 'runoffModel'>): RunMeta[] {
	const own = shown.runoffModel ?? 'legacy';
	const seen = new Set<string>([own]);
	const out: RunMeta[] = [];
	for (const r of runs) {
		const m = r.runoffModel ?? 'legacy';
		if (r.id === shown.id || seen.has(m)) continue;
		seen.add(m);
		out.push(r);
	}
	return out;
}

export interface OtherCurves {
	runId: string;
	label: string;
	lowFlow: LowFlowCurves | null | undefined;
}

const sameMonths = (a: number[], b: number[]) => a.length === b.length && a.every((m, i) => m === b[i]);

/**
 * The chart data: every curve of the shown run, then each other run's
 * whole-run simulated outflow, when it used the same dry season and points
 * (a run made on other months can't be overlaid; `skipped` says which).
 * `paired` picks the simulated curve: whole run (null) or on a record's days.
 */
export function lowFlowChart(
	lf: LowFlowCurves,
	others: readonly OtherCurves[],
	paired: LowFlowCurve['pairedWith'] = null
): { x: number[]; ys: number[][]; labels: string[]; styles: ('solid' | 'dashed')[]; skipped: string[] } {
	const shown = lf.curves.filter((c) => c.source !== 'simulated_outflow' || c.pairedWith === paired);
	const labels = shown.map((c) => (c.source === 'simulated_outflow' ? `${curveLabel(c)} (${modelLabel(lf.runoffModel)}, this run)` : curveLabel(c)));
	const ys = shown.map((c) => c.flowsM3s);
	const styles: ('solid' | 'dashed')[] = shown.map((c) => (c.source === 'flow_observed_m3s' || c.source === 'flow_logger_m3s' ? 'dashed' : 'solid'));
	const skipped: string[] = [];
	for (const o of others) {
		const c = o.lowFlow?.curves.find((k) => k.source === 'simulated_outflow' && k.pairedWith === null);
		if (!o.lowFlow || !c) continue;
		if (!sameMonths(o.lowFlow.season.months, lf.season.months) || !sameMonths(o.lowFlow.points, lf.points)) {
			skipped.push(o.label);
			continue;
		}
		labels.push(`Simulated outflow (${modelLabel(o.lowFlow.runoffModel)}, ${o.label})`);
		ys.push(c.flowsM3s);
		styles.push('solid');
	}
	return { x: [...lf.points], ys, labels, styles, skipped };
}

/** Signed percentage: +12 %, −30 %; '–' for null. */
export function signedPct(v: number | null | undefined, digits = 0): string {
	if (v == null || !Number.isFinite(v)) return '–';
	const r = Number((Math.abs(v) * 100).toFixed(digits));
	return `${v < 0 && r !== 0 ? '−' : '+'}${r.toFixed(digits)} %`;
}

/** How many checks found something: the panel's headline. */
export function findings(p: PlausibilityChecks): { label: string; ok: boolean | null }[] {
	const n = p.naturalised;
	const r = p.rainSource;
	const dm = p.flowDoubleMass;
	const lf = p.lowFlow?.comparison ?? null;
	const rainDiff =
		r && r.good.fractionNotMet !== null && r.fallback.fractionNotMet !== null ? Math.abs(r.fallback.fractionNotMet - r.good.fractionNotMet) : null;
	return [
		{ label: 'Natural ≥ observed + abstraction', ok: n && n.judgedYears ? n.failedYears.length === 0 : null },
		{ label: 'EWR by rain source', ok: r ? (r.fallback.years === 0 ? true : rainDiff === null ? null : rainDiff < 0.1) : null },
		{ label: 'Observed flow vs rain', ok: dm ? dm.breaks.every((b) => b.hint === 'rain') : null },
		{ label: 'Dry-season low flows', ok: lf ? lf.withinFactor : null },
		// Engine ≥ 1.18.0: the recession diagnostics (absent on older runs, so their list is unchanged).
		...(p.recession !== undefined ? [{ label: 'Recessions', ok: p.recession?.agrees ?? null }] : []),
		// Engine ≥ 1.4.0: checks 1 and 4 at each gauge with a record of its own; only when there is one.
		...(p.gauges?.length ? [{ label: 'At gauges in the network', ok: gaugesOk(p.gauges) }] : [])
	];
}

/** Every gauge's checks: false when one fails, null when none could be checked, else true. */
function gaugesOk(gauges: NonNullable<PlausibilityChecks['gauges']>): boolean | null {
	const oks = gauges.flatMap((g) => gaugeRow(g).ok);
	return oks.includes(false) ? false : oks.some((o) => o === true) ? true : null;
}

export interface GaugeRow {
	nodeId: string;
	name: string;
	record: string;
	/** Share of the catchment's natural flow above the gauge, 0–1. */
	naturalShare: number;
	judgedYears: number | null;
	failedYears: number[];
	/** Simulated ÷ observed dry-season Q90; null without a comparison. */
	q90Ratio: number | null;
	withinFactor: boolean | null;
	/** Check 1, then check 4: pass (true), fail (false), not checked (null). */
	ok: [boolean | null, boolean | null];
}

/** One gauge's row in the panel's table (RunSummary.plausibility.gauges, engine ≥ 1.4.0). */
export function gaugeRow(g: NonNullable<PlausibilityChecks['gauges']>[number]): GaugeRow {
	const n = g.naturalised;
	const c = g.lowFlow?.comparison ?? null;
	return {
		nodeId: g.nodeId,
		name: g.name,
		record: RECORD[g.flowKind] ?? g.flowKind,
		naturalShare: g.naturalShare,
		judgedYears: n ? n.judgedYears : null,
		failedYears: n ? [...n.failedYears] : [],
		q90Ratio: c ? c.ratio : null,
		withinFactor: c ? c.withinFactor : null,
		ok: [n && n.judgedYears ? n.failedYears.length === 0 : null, c ? c.withinFactor : null]
	};
}
