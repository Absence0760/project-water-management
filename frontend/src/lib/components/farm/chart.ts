// Geometry and words for the farmer view's two small charts (docs/design/
// farmer-view.md §3, §7; boards 1 and 3): monthly needed/received bars and the
// dam's month-end line. Drawn as inline SVG at the rendered width, so the
// 13 px labels are never scaled down. The charts are decorative
// (aria-hidden); the summary sentence and the "Show the numbers" table carry
// the content, and both come from here too.
import type { MonthTotals } from '@water-management/engine';
import { fmtMonthLong, fmtMonthLongYear, fmtMonthShort, fmtMonthYear, fmtNumber, fmtPct, fmtVolume, joinAnd, monthEnd } from './format';

export const CHART_HEIGHT = 152;
const TOP = 10;
/** The x axis (y of zero). */
export const CHART_BASE = 130;
const BASE = CHART_BASE;
/** Baseline of the month letters. */
export const LABEL_Y = 147;
/** The design's minimum text size, chart labels included (§7). */
export const CHART_FONT_PX = 13;

export interface MonthLabel {
	month: string;
	/** "F", or "J*" for a month cut short by dataUntil. */
	letter: string;
	partial: boolean;
	/** "Feb 2023", or "1–10 Jan 2024" for the partial month. */
	row: string;
}

export function monthLabels(monthly: readonly MonthTotals[], dataUntil: string): MonthLabel[] {
	return monthly.map((m) => {
		const partial = dataUntil.startsWith(m.month) && dataUntil < monthEnd(m.month);
		const short = fmtMonthShort(m.month);
		return {
			month: m.month,
			letter: short.charAt(0) + (partial ? '*' : ''),
			partial,
			row: partial ? `1–${Number(dataUntil.slice(8, 10))} ${fmtMonthYear(m.month)}` : fmtMonthYear(m.month)
		};
	});
}

/** "Feb 2023 to Jan 2024. * January to the 10th." */
export function rangeCaption(monthly: readonly MonthTotals[], dataUntil: string): string {
	if (!monthly.length) return '';
	const first = fmtMonthYear(monthly[0]!.month);
	const lastMonth = monthly[monthly.length - 1]!.month;
	const labels = monthLabels(monthly, dataUntil);
	const partial = labels[labels.length - 1]!.partial;
	const day = Number(dataUntil.slice(8, 10));
	const th = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
	return `${first} to ${fmtMonthYear(lastMonth)}.${partial ? ` * ${fmtMonthLong(lastMonth)} to the ${day}${th}.` : ''}`;
}

/** A round top for the axis whose half is round too: 116.5 → 120, 45 → 50, 7 → 8. */
export function niceMax(v: number): number {
	if (!(v > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
	return 10 * p;
}

const approxTextWidth = (s: string) => s.length * CHART_FONT_PX * 0.6;

export interface BarChart {
	width: number;
	height: number;
	ticks: { y: number; label: string }[];
	axisLeft: number;
	groups: { need: { x: number; y: number; w: number; h: number }; got: { x: number; y: number; w: number; h: number }; labelX: number; label: string }[];
}

/** Needed (an outline) and received (a fill) per month, in ML. */
export function barChart(monthly: readonly MonthTotals[], dataUntil: string, width: number): BarChart {
	const ml = monthly.map((m) => ({ need: m.demandM3 / 1000, got: m.suppliedM3 / 1000 }));
	const top = niceMax(Math.max(0, ...ml.flatMap((m) => [m.need, m.got])));
	const tickVals = [top, top / 2, 0];
	const tickText = tickVals.map((v) => fmtNumber(v, 1, true));
	const axisLeft = Math.ceil(Math.max(...tickText.map(approxTextWidth))) + 6;
	const plotW = Math.max(width - axisLeft, 1);
	const groupW = plotW / Math.max(ml.length, 1);
	const barW = Math.max(2, Math.min(14, (groupW - 4) / 2));
	const y = (v: number) => BASE - (Math.max(v, 0) / top) * (BASE - TOP);
	const labels = monthLabels(monthly, dataUntil);
	return {
		width,
		height: CHART_HEIGHT,
		axisLeft,
		ticks: tickVals.map((v, i) => ({ y: y(v), label: tickText[i]! })),
		groups: ml.map((m, i) => {
			const cx = axisLeft + groupW * (i + 0.5);
			return {
				need: { x: cx - barW - 0.5, y: y(m.need), w: barW, h: BASE - y(m.need) },
				got: { x: cx + 0.5, y: y(m.got), w: barW, h: BASE - y(m.got) },
				labelX: cx,
				label: labels[i]!.letter
			};
		})
	};
}

/** Short when received is under needed by more than rounding crumbs. */
const wasShort = (m: MonthTotals) => m.demandM3 - m.suppliedM3 > Math.max(1, m.demandM3 * 0.001);

/** The chart's visually hidden summary sentence. */
export function supplySummary(monthly: readonly MonthTotals[], dataUntil: string): string {
	if (!monthly.length) return 'No monthly figures yet.';
	const labels = monthLabels(monthly, dataUntil);
	const last = labels[labels.length - 1]!;
	const end = last.partial ? `${Number(dataUntil.slice(8, 10))} ${fmtMonthLongYear(last.month)}` : fmtMonthLongYear(last.month);
	const short = monthly.filter(wasShort).map((m) => fmtMonthLong(m.month));
	const shortText = short.length ? `You were short in ${joinAnd(short)}.` : 'You received all you needed every month.';
	return `Water you needed and received each month, ${fmtMonthLongYear(monthly[0]!.month)} to ${end}. ${shortText} The numbers are in the table below.`;
}

/** The "Show the numbers" rows: every month with its year, in ML. */
export function supplyRows(monthly: readonly MonthTotals[], dataUntil: string) {
	const labels = monthLabels(monthly, dataUntil);
	return monthly.map((m, i) => ({ label: labels[i]!.row, need: fmtVolume(m.demandM3, 'ML'), got: fmtVolume(m.suppliedM3, 'ML') }));
}

// ---- The dam's month-end line ------------------------------------------------

export interface DamChart {
	width: number;
	height: number;
	axisLeft: number;
	ticks: { y: number; label: string }[];
	points: string;
	/** The stop level's dashed line; null without one. */
	stopY: number | null;
	labels: { x: number; label: string }[];
}

export function damChart(monthly: readonly MonthTotals[], dataUntil: string, width: number, damMinPct: number): DamChart {
	const ticks = [1, 0.5, 0];
	const tickText = ticks.map((t) => fmtPct(t));
	const axisLeft = Math.ceil(Math.max(...tickText.map(approxTextWidth))) + 6;
	const plotW = Math.max(width - axisLeft, 1);
	const groupW = plotW / Math.max(monthly.length, 1);
	const y = (f: number) => BASE - Math.min(Math.max(f, 0), 1) * (BASE - TOP);
	const labels = monthLabels(monthly, dataUntil);
	const pts: string[] = [];
	monthly.forEach((m, i) => {
		if (m.damPctEnd == null) return;
		pts.push(`${(axisLeft + groupW * (i + 0.5)).toFixed(1)},${y(m.damPctEnd).toFixed(1)}`);
	});
	return {
		width,
		height: CHART_HEIGHT,
		axisLeft,
		ticks: ticks.map((t, i) => ({ y: y(t), label: tickText[i]! })),
		points: pts.join(' '),
		stopY: damMinPct > 0 ? y(damMinPct) : null,
		labels: labels.map((l, i) => ({ x: axisLeft + groupW * (i + 0.5), label: l.letter }))
	};
}

/** The dam chart's visually hidden summary: lowest, highest and latest month-end levels. */
export function damSummary(monthly: readonly MonthTotals[], dataUntil: string): string {
	const withDam = monthly.filter((m) => m.damPctEnd != null) as (MonthTotals & { damPctEnd: number })[];
	if (!withDam.length) return 'No dam levels yet.';
	const labels = monthLabels(monthly, dataUntil);
	const last = labels[labels.length - 1]!;
	const end = last.partial ? `${Number(dataUntil.slice(8, 10))} ${fmtMonthLongYear(last.month)}` : fmtMonthLongYear(last.month);
	const low = withDam.reduce((a, b) => (b.damPctEnd < a.damPctEnd ? b : a));
	const high = withDam.reduce((a, b) => (b.damPctEnd > a.damPctEnd ? b : a));
	const latest = withDam[withDam.length - 1]!;
	return (
		`Dam level at the end of each month, ${fmtMonthLongYear(monthly[0]!.month)} to ${end}. ` +
		`Lowest ${fmtPct(low.damPctEnd)} at the end of ${fmtMonthLongYear(low.month)}, highest ${fmtPct(high.damPctEnd)} at the end of ${fmtMonthLongYear(high.month)}, ` +
		`and ${fmtPct(latest.damPctEnd)} on ${end}. The numbers are in the table below.`
	);
}

/** The dam table's rows: every month with its year. */
export function damRows(monthly: readonly MonthTotals[], dataUntil: string) {
	const labels = monthLabels(monthly, dataUntil);
	return monthly.map((m, i) => ({ label: labels[i]!.row, pct: m.damPctEnd == null ? '–' : fmtPct(m.damPctEnd) }));
}
