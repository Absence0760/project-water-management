// The Runs hydrograph's shading of the periods left out of calibration
// (settings.calibrationExclusions, docs/model.md §2.10; ui.md § Runs). Pure,
// so it is unit-tested; RunsTab.svelte picks the run's own exclusions and
// RunCharts.svelte shades them.
import { exclusionError, exclusionLabel, exclusionRange, waterYearLabel, type CalibrationExclusion, type ExclusionRange } from '@water-management/engine';

/** One excluded period, as the chart shades it and its key lists it. */
export interface ExcludedPeriod {
	/** Inclusive ISO dates shaded (clipped to the chart by clipExclusions). */
	start: string;
	end: string;
	/** "WY 2015/16" or "2015-01-01 – 2015-03-31": the period as stored, never clipped. */
	label: string;
	reason: string;
	/** Part of the period lies outside the chart's days. */
	clipped: boolean;
}

/** A range that is exactly one water year (1 Oct Y – 30 Sep Y + 1) is labelled as one. */
function rangeLabel(r: ExclusionRange): string {
	const y = Number(r.start.slice(0, 4));
	return r.start === `${y}-10-01` && r.end === `${y + 1}-09-30` ? `WY ${waterYearLabel(y)}` : `${r.start} – ${r.end}`;
}

/**
 * The exclusions a run was made with, never the project's current ones: the
 * run's settings snapshot (`detail.run.settings`, its valid entries, as the
 * engine applies them), else what the run's calibration statistics record
 * they applied (`summary.calibration.exclusions`, for a detail cached before
 * runs carried their settings). Oldest first.
 */
export function runExclusions(
	snapshot: { calibrationExclusions?: unknown } | null | undefined,
	applied?: readonly ExclusionRange[] | null
): ExcludedPeriod[] {
	const stored = snapshot?.calibrationExclusions;
	const out: ExcludedPeriod[] = Array.isArray(stored)
		? (stored as unknown[])
				.filter((x): x is CalibrationExclusion => exclusionError(x) === null)
				.map((x) => ({ ...exclusionRange(x), label: exclusionLabel(x), clipped: false }))
		: (applied ?? []).map((r) => ({ start: r.start, end: r.end, reason: r.reason, label: rangeLabel(r), clipped: false }));
	return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
}

/** First and last day of the daily series drawn (ISO), or null when there is none. */
export function seriesSpan(series: readonly { startDate: string; values: ArrayLike<unknown> }[]): { start: string; end: string } | null {
	let lo: number | null = null;
	let hi: number | null = null;
	for (const s of series) {
		if (!s.values.length) continue;
		const a = Date.parse(`${s.startDate}T00:00:00Z`);
		const b = a + (s.values.length - 1) * 86_400_000;
		if (lo === null || a < lo) lo = a;
		if (hi === null || b > hi) hi = b;
	}
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	return lo === null || hi === null ? null : { start: iso(lo), end: iso(hi) };
}

/** The periods that overlap the chart's days, each clipped to them; none without a span. */
export function clipExclusions(list: readonly ExcludedPeriod[], span: { start: string; end: string } | null): ExcludedPeriod[] {
	if (!span) return [];
	return list
		.filter((x) => x.end >= span.start && x.start <= span.end)
		.map((x) => {
			const start = x.start < span.start ? span.start : x.start;
			const end = x.end > span.end ? span.end : x.end;
			return { ...x, start, end, clipped: x.clipped || start !== x.start || end !== x.end };
		});
}

/** One line of the chart's key: "WY 2015/16: suspect rain (partly outside the run)". */
export const exclusionKeyText = (x: ExcludedPeriod): string => `${x.label}: ${x.reason}${x.clipped ? ' (partly outside the run)' : ''}`;
