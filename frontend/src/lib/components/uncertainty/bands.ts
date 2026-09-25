// How an uncertainty ensemble is shown (issue #4 phase 9, docs/ui.md §
// Uncertainty bands). Pure, so it is unit-tested; the panels are thin.
import {
	diffEnsembleOptions,
	RECORD_LABELS,
	REJECT_LABELS,
	type Band,
	type EnsembleSummary,
	type OptionChange,
	type PairedSummary,
	type RecordCoverage,
	type RejectReason
} from '@water-management/engine';
import type { Ensemble } from '$lib/api';
import { fmtDate, fmtNum } from '$lib/format/number';

/** Digits that read well for a value of this size (3 significant figures, whole numbers from 100). */
export function sig(v: number | null | undefined): string {
	if (v == null || !Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	return fmtNum(v, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}

/** "12 – 30" (5th – 95th percentile); "–" when the band has no percentiles. */
export const rangeText = (b: Band, f: (v: number) => string = sig) => (b.p5 === null || b.p95 === null ? '–' : `${f(b.p5)} – ${f(b.p95)}`);

/** A band's three numbers for a table row, "–" for each when gated. */
export const bandCells = (b: Band, f: (v: number) => string = sig) => [b.p5, b.p50, b.p95].map((v) => (v === null ? '–' : f(v)));

/** A share as a whole %, "–" for null. */
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${fmtNum(v * 100, 0)} %`);

/** Coverage in words: how many held-out observations fall inside the band. */
export function coverageText(c: RecordCoverage, minMembers: number): string {
	const rec = RECORD_LABELS[c.record];
	if (c.inside === null || c.fraction === null) {
		return c.heldOutDays === 0 ? `No held-out ${rec} days.` : `Withheld for the ${rec}: fewer than ${minMembers} parameter sets kept.`;
	}
	return `${fmtNum(c.inside)} of ${fmtNum(c.heldOutDays)} held-out ${rec} observations (${pct(c.fraction)}) fall inside the 5–95 % band.`;
}

/** Why members were rejected, most common first: "197 on the low-flow check, 2 on the skill score". */
export function rejectedText(r: Record<RejectReason, number>): string {
	const parts = (Object.entries(r) as [RejectReason, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
	return parts.length ? parts.map(([k, n]) => `${fmtNum(n)} on the ${REJECT_LABELS[k]}`).join(', ') : 'none';
}

export const isPaired = (s: EnsembleSummary | PairedSummary | null): s is PairedSummary => !!s && !('accepted' in s);

/** The ensemble a run's panel shows: the newest complete one of the run itself (never a paired row). */
export const shownEnsemble = (list: readonly Ensemble[]): Ensemble | null => list.find((e) => e.status === 'complete' && !e.baselineId) ?? null;

export interface HistoryRow {
	id: string;
	when: string;
	by: string;
	status: string;
	seed: number;
	members: number;
	accepted: number | null;
	shown: boolean;
	/** How its rule differs from the shown ensemble's (empty = the same rule). */
	changes: OptionChange[];
}

/**
 * Every ensemble started for the run, newest first, each with what differs
 * from the shown one's rule: the stored thresholds, diffed. Paired rows are
 * left out (the compare page shows them).
 */
export function historyRows(list: readonly Ensemble[], shown: Ensemble | null): HistoryRow[] {
	return list
		.filter((e) => !e.baselineId)
		.map((e) => ({
			id: e.id,
			when: fmtDate(e.createdAt, true),
			by: e.createdBy ?? '–',
			status: e.status === 'complete' ? 'stored' : 'started, never stored',
			seed: e.seed,
			members: e.members,
			accepted: e.accepted,
			shown: e.id === shown?.id,
			changes: shown && e.id !== shown.id ? diffEnsembleOptions(shown.options, e.options) : []
		}));
}

/** "2 of the 5 ensembles started for this run were never stored" (null when every one was). */
export function abandonedText(list: readonly Ensemble[]): string | null {
	const own = list.filter((e) => !e.baselineId);
	const n = own.filter((e) => e.status === 'started').length;
	if (!n) return null;
	const which = own.length === 1 ? 'The one ensemble' : `${n} of the ${own.length} ensembles`;
	return `${which} started for this run ${n === 1 ? 'was' : 'were'} never stored (cancelled or abandoned). Every start is kept, with its seed and rule.`;
}

// ---------------------------------------------------------------------------
// The monthly flow-duration chart
// ---------------------------------------------------------------------------

export interface FdcChart {
	/** SVG path of the 5–95 % band (a closed polygon); '' when gated. */
	band: string;
	median: string;
	/** y of the EWR line; null when it is off the chart's range. */
	ewrY: number | null;
	xTicks: { x: number; label: string }[];
	yTicks: { y: number; label: string }[];
}

/**
 * Geometry of one month's flow-duration band against the EWR: exceedance %
 * on x (linear), flow on a log y axis (m³/day) covering the band and the EWR.
 * Zero flows sit on the axis floor (a tenth of the smallest positive value).
 */
export function fdcChart(points: readonly Band[], exceedance: readonly number[], ewr: number, w: number, h: number, pad = { l: 56, r: 10, t: 8, b: 26 }): FdcChart {
	const vals = points.flatMap((b) => [b.p5, b.p95]).filter((v): v is number => v !== null);
	const positive = [...vals, ewr].filter((v) => v > 0);
	const lo = positive.length ? Math.min(...positive) / 1.5 : 1;
	const hi = positive.length ? Math.max(...positive) * 1.5 : 10;
	const floor = lo;
	const ly = (v: number) => Math.log10(Math.max(v, floor));
	const y = (v: number) => pad.t + ((ly(hi) - ly(v)) / (ly(hi) - ly(floor))) * (h - pad.t - pad.b);
	const x = (p: number) => pad.l + (p / 100) * (w - pad.l - pad.r);
	const r = (n: number) => Math.round(n * 10) / 10;
	const gated = points.some((b) => b.p5 === null || b.p50 === null || b.p95 === null);
	const line = (key: 'p5' | 'p50' | 'p95') => points.map((b, i) => `${i ? 'L' : 'M'}${r(x(exceedance[i]!))},${r(y(b[key]!))}`).join(' ');
	const band = gated
		? ''
		: `${line('p95')} ${[...points.keys()]
				.reverse()
				.map((i) => `L${r(x(exceedance[i]!))},${r(y(points[i]!.p5!))}`)
				.join(' ')} Z`;
	const yTicks: FdcChart['yTicks'] = [];
	for (let e = Math.ceil(Math.log10(floor)); e <= Math.floor(Math.log10(hi)); e++) yTicks.push({ y: r(y(10 ** e)), label: fmtNum(10 ** e) });
	return {
		band,
		median: gated ? '' : line('p50'),
		ewrY: ewr > 0 && ewr >= floor && ewr <= hi ? r(y(ewr)) : null,
		xTicks: [0, 20, 40, 60, 80, 100].map((p) => ({ x: r(x(p)), label: `${p} %` })),
		yTicks
	};
}

/** How many of a month's exceedance points have a median flow below the EWR. */
export function pointsBelowEwr(points: readonly Band[], ewr: number): number {
	return points.filter((b) => b.p50 !== null && b.p50 < ewr).length;
}
