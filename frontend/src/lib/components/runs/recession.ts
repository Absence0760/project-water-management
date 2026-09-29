// Display helpers for the recession diagnostics (RunSummary.plausibility.
// recession, engine ≥ 1.19.0; docs/model.md §2.10d "Recession diagnostics",
// docs/ui.md). The run stores the segments and the two fits; the −dQ/dt, Q
// points are rebuilt here from the run's stored observed and simulated
// series with the engine's own recessionPoints, so the summary stays small.
// Pure, unit-tested.
import {
	RECESSION_B_WARN_DIFF,
	RECESSION_MIN_SEGMENTS,
	RECESSION_RATE_WARN_FACTOR,
	recessionPoints,
	recessionRateAt,
	type DailySeries,
	type RecessionCheck,
	type RecessionFit
} from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';
import { fmtNum } from '$lib/format/number';

const SEC_PER_DAY = 86_400;
const RECORD: Record<string, string> = { flow_observed_m3s: 'gauge', flow_logger_m3s: 'logger' };
const noDates = { startDate: '', values: [] as (number | null)[] };

/** "0.0123", "1.24", "3.1e-5": three significant figures. */
export const sig3 = (v: number | null | undefined) =>
	v == null || !Number.isFinite(v) ? '–' : Math.abs(v) >= 1e-3 || v === 0 ? String(Number(v.toPrecision(3))) : v.toExponential(2).replace('e-', 'e−');

/** A run series in m³/day as m³/s (NaN stays missing). */
const toM3s = (s: DailySeries | null | undefined): (number | null)[] => (s ? s.values.map((v) => (v == null || !Number.isFinite(v) ? null : v / SEC_PER_DAY)) : []);

export interface RecessionChart {
	/** x = log₁₀ Q (m³/s), shared by every series; ys: observed points, simulated points, observed fit, simulated fit. */
	xy: { x: number[]; ys: (number | null)[][] };
	series: ChartSeries[];
	/** Points plotted from each series. */
	observedPoints: number;
	simulatedPoints: number;
}

/**
 * The scatter of −dQ/dt against Q on the run's recession segments, for the
 * observed record and the simulated outflow, each with its fitted line. The
 * x axis is log₁₀ Q (LineChart's x axis is linear; the y axis goes on its log
 * scale), sorted and shared; each point sits on its own x.
 */
export function recessionChart(r: RecessionCheck, observed: DailySeries | null | undefined, simulated: DailySeries | null | undefined): RecessionChart {
	const method = r.options.dQdtMethod;
	const obs = observed ? recessionPoints(toM3s(observed), r.segments, method) : [];
	const sim = simulated ? recessionPoints(toM3s(simulated), r.segments, method) : [];
	const all = [...obs.map((p) => ({ p, s: 0 })), ...sim.map((p) => ({ p, s: 1 }))].sort((a, b) => a.p.qM3s - b.p.qM3s || a.s - b.s);
	const x = all.map(({ p }) => Math.log10(p.qM3s));
	const ys: (number | null)[][] = [0, 1].map((s) => all.map((e) => (e.s === s ? e.p.rate : null)));
	const line = (f: RecessionFit | null) => all.map(({ p }) => (f && p.qM3s >= f.minQM3s && p.qM3s <= f.maxQM3s ? f.a * p.qM3s ** f.b : null));
	ys.push(line(r.observed), line(r.simulated));
	const rec = RECORD[r.flowKind] ?? 'observed';
	const fitLabel = (who: string, f: RecessionFit | null) => (f ? `${who} fit: a = ${sig3(f.a)}, b = ${fmtNum(f.b, 2)}` : `${who} fit: too few points`);
	return {
		xy: { x, ys },
		series: [
			{ ...noDates, label: `Observed (${rec})`, style: 'points', color: '--chart-obs' },
			{ ...noDates, label: 'Simulated outflow', style: 'points', color: '--series-2' },
			{ ...noDates, label: fitLabel('Observed', r.observed), style: 'dashed', color: '--chart-obs', width: 1.75 },
			{ ...noDates, label: fitLabel('Simulated', r.simulated), color: '--series-2', width: 1.75 }
		],
		observedPoints: obs.length,
		simulatedPoints: sim.length
	};
}

/** The x axis's tick text: log₁₀ Q back to a flow, "0.01", "2.5", "300". */
export const flowTick = (log10q: number) => sig3(10 ** log10q);

export interface RecessionRow {
	label: string;
	a: string;
	b: string;
	/** −dQ/dt ÷ Q at the reference flow, per day. */
	rate: string;
	points: number | null;
	segments: number | null;
}

/** The table beside the chart: the observed and the simulated fit. */
export function recessionRows(r: RecessionCheck): RecessionRow[] {
	const row = (label: string, f: RecessionFit | null, rate: number | null): RecessionRow => ({
		label,
		a: f ? sig3(f.a) : '–',
		b: f ? fmtNum(f.b, 2) : '–',
		rate: rate === null ? '–' : sig3(rate),
		points: f?.points ?? null,
		segments: f?.segments ?? null
	});
	return [row(`Observed (${RECORD[r.flowKind] ?? 'observed'})`, r.observed, r.observedRate), row('Simulated outflow', r.simulated, r.simulatedRate)];
}

/** The one-line verdict under the chart, and whether it is a finding (false), fine (true) or not judged (null). */
export function recessionVerdict(r: RecessionCheck): { ok: boolean | null; text: string } {
	const n = r.segments.length;
	if (n < RECESSION_MIN_SEGMENTS) {
		return {
			ok: null,
			text: `Not judged: ${n === 0 ? 'no' : `only ${n}`} rain-free recession segment${n === 1 ? '' : 's'}, fewer than the ${RECESSION_MIN_SEGMENTS} a stable fit needs.`
		};
	}
	if (r.agrees === null) return { ok: null, text: 'Not judged: the observed points give no fit.' };
	if (!r.simulated) return { ok: false, text: `On ${n} segments the simulated outflow barely falls: too few falling days to fit.` };
	const ratio = r.rateRatio!;
	const pace = ratio >= 1 ? `${fmtNum(ratio, 1)}× faster` : `${fmtNum(1 / ratio, 1)}× slower`;
	const at = recessionRateAt(r.observed!, r.referenceFlowM3s!);
	return {
		ok: r.agrees,
		text:
			`On ${n} segments, at ${sig3(r.referenceFlowM3s)} m³/s (the observed points’ median) the simulated flow recedes ${pace} than the observed ` +
			`(${sig3(r.simulatedRate)} against ${sig3(at)} per day), and b differs by ${fmtNum(r.bDiff!, 2)}. ` +
			(r.agrees
				? `Within the indicative limits (a factor of ${RECESSION_RATE_WARN_FACTOR}, b within ${RECESSION_B_WARN_DIFF}).`
				: `Outside the indicative limits (a factor of ${RECESSION_RATE_WARN_FACTOR}, b within ${RECESSION_B_WARN_DIFF}).`)
	};
}
