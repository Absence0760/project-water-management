// How the sensitivity runs are shown (CR-21, docs/model.md §2.10g, docs/ui.md
// § Sensitivity runs): the tornado's rows, sorted by swing, its scale, and the
// verdicts re-judged at the threshold on screen. Pure, so it is unit-tested;
// the panel and the chart are thin.
import {
	SENSITIVITY_FACTORS,
	siteVerdict,
	type SensitivityMetric,
	type SensitivityResult,
	type SiteValues,
	type SiteVerdict
} from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { pct, sig } from './bands';

/** What the tornado can show at a site. */
export type TornadoMetric = 'daysNotMet' | 'shortfallMm3' | 'reserveRate';

export const TORNADO_METRICS: Record<TornadoMetric, { label: string; unit: string; fmt: (v: number | null | undefined) => string }> = {
	daysNotMet: { label: 'EWR days not met', unit: 'days', fmt: (v) => fmtNum(v) },
	shortfallMm3: { label: 'Shortfall against the EWR', unit: 'Mm³', fmt: sig },
	reserveRate: { label: 'Months meeting the Reserve rule table', unit: '% of months', fmt: pct }
};

/** The metrics a site has: the Reserve rate only with a rule table, first then, as its verdict is judged on it. */
export function metricsFor(hasRuleTable: boolean): TornadoMetric[] {
	return hasRuleTable ? ['reserveRate', 'daysNotMet', 'shortfallMm3'] : ['daysNotMet', 'shortfallMm3'];
}

export interface TornadoRow {
	factor: string;
	label: string;
	lowLabel: string;
	highLabel: string;
	low: number | null;
	high: number | null;
	/** |high − low|; 0 when either is missing. */
	swing: number;
}

/** One row per factor run at a site, largest swing first (ties in the factors' own order). */
export function tornadoRows(result: SensitivityResult, site: number, metric: TornadoMetric): TornadoRow[] {
	const rows = result.factors.map((f) => {
		const low = f.low.values[site]?.[metric] ?? null;
		const high = f.high.values[site]?.[metric] ?? null;
		return {
			factor: f.factor,
			label: f.label,
			lowLabel: f.low.label,
			highLabel: f.high.label,
			low,
			high,
			swing: low === null || high === null ? 0 : Math.abs(high - low)
		};
	});
	const order = (f: string) => (SENSITIVITY_FACTORS as readonly string[]).indexOf(f);
	return rows.sort((a, b) => b.swing - a.swing || order(a.factor) - order(b.factor));
}

/** Round step for about `n` ticks across `span`. */
function niceStep(span: number, n: number): number {
	const raw = span / n;
	const p = 10 ** Math.floor(Math.log10(raw));
	const m = raw / p;
	return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export interface TornadoScale {
	lo: number;
	hi: number;
	/** Position of a value, 0–1 across the scale. */
	at: (v: number) => number;
	ticks: number[];
}

/** A linear scale holding the central value, every row's ends and the threshold, on round ticks. */
export function tornadoScale(rows: TornadoRow[], central: number | null, threshold: number | null = null): TornadoScale {
	const vs = [central, threshold, ...rows.flatMap((r) => [r.low, r.high])].filter((v): v is number => v !== null && Number.isFinite(v));
	let lo = vs.length ? Math.min(...vs) : 0;
	let hi = vs.length ? Math.max(...vs) : 1;
	if (hi === lo) {
		const d = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1;
		lo -= d;
		hi += d;
	}
	const step = niceStep(hi - lo, 4);
	lo = Math.floor(lo / step) * step;
	hi = Math.ceil(hi / step) * step;
	const ticks: number[] = [];
	for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
	return { lo, hi, at: (v) => (v - lo) / (hi - lo), ticks };
}

/**
 * The threshold as the tornado's metric reads it, when that metric is the
 * one the site's verdict is judged on (or its complement): a share of
 * months met is drawn as is; a share of days met as the days not met it
 * allows. null for the shortfall, which has none.
 */
export function thresholdOn(metric: TornadoMetric, verdict: SiteVerdict | undefined, days: number): number | null {
	if (!verdict) return null;
	if (metric === 'reserveRate' && verdict.metric === 'reserveRate') return verdict.threshold;
	if (metric === 'daysNotMet' && verdict.metric === 'daysMet') return Math.round((1 - verdict.threshold) * days);
	return null;
}

/** The verdicts re-judged at the thresholds on screen (no re-run: the verdict reads only the stored values). */
export function verdictsAt(result: SensitivityResult, thresholds: Record<SensitivityMetric, number>): SiteVerdict[] {
	return result.sites.map((site, i) => {
		const all: SiteValues[] = [result.central[i]!, ...result.factors.flatMap((f) => [f.low.values[i]!, f.high.values[i]!])];
		return siteVerdict(site, all, result.central[i]!, thresholds);
	});
}

/** A verdict's short name for a badge. */
export const VERDICT_LABELS: Record<SiteVerdict['verdict'], string> = {
	meets: 'Meets the threshold',
	fails: 'Below the threshold',
	notDeterminable: 'Not determinable with current data',
	noData: 'Nothing to judge'
};

/** The factors and their ranges in one line: "Rain × 0.9 / × 1.1 · … · Initial dam storage empty / full". */
export function factorsLine(result: SensitivityResult): string {
	return result.factors.map((f) => `${f.label} ${f.low.label} / ${f.high.label}`).join(' · ');
}

/** A tornado row's accessible text: "Rain: × 0.9 gives 3,299, × 1.1 gives 2,938 days." */
export function rowText(r: TornadoRow, metric: TornadoMetric): string {
	const m = TORNADO_METRICS[metric];
	return `${r.label}: ${r.lowLabel} gives ${m.fmt(r.low)}, ${r.highLabel} gives ${m.fmt(r.high)}${metric === 'reserveRate' ? '' : ` ${m.unit}`}.`;
}
