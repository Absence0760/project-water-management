// Geometry and words for the farmer view's two small charts (docs/design/
// farmer-view.md §3, §7; boards 1 and 3): monthly needed/received bars and the
// dam's month-end line. Drawn as inline SVG at the rendered width, so the
// 13 px labels are never scaled down. The charts are decorative
// (aria-hidden); the summary sentence and the "Show the numbers" table carry
// the content, and both come from here too, in the active language ($lib/i18n).
import { STRESS_THRESHOLDS, stressClassOf, type MonthTotals, type StressClass } from '@water-management/engine';
import { msg, plural, t, tn, type Msg } from '$lib/i18n/locale.svelte';
import { fmtMonthLong, fmtMonthLongYear, fmtMonthShort, fmtMonthYear, fmtNumber, fmtPct, fmtVolume, joinAnd, monthEnd, type VolumeUnit } from './format';

import { CHART_BASE, CHART_FONT_PX, CHART_HEIGHT, CHART_TOP as TOP, niceMax } from './chartGeometry';

// i18n-section: farm.ordinal
/** A day of the month as an ordinal: “10th”. */
export const ORDINAL = plural({ one: '{n}st', two: '{n}nd', few: '{n}rd', other: '{n}th' });

export { CHART_BASE, CHART_FONT_PX, CHART_HEIGHT, LABEL_Y, niceMax } from './chartGeometry';
const BASE = CHART_BASE;

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
			// i18n-section: farm.chart
			row: partial ? t('1–{day} {month}', { day: Number(dataUntil.slice(8, 10)), month: fmtMonthYear(m.month) }) : fmtMonthYear(m.month)
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
	const range = t('{from} to {to}.', { from: first, to: fmtMonthYear(lastMonth) });
	return partial ? `${range} ${t('* {month} to the {day}.', { month: fmtMonthLong(lastMonth), day: tn(ORDINAL, day, {}, true) })}` : range;
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
	if (!monthly.length) return t('No monthly figures yet.');
	const labels = monthLabels(monthly, dataUntil);
	const last = labels[labels.length - 1]!;
	const end = last.partial ? `${Number(dataUntil.slice(8, 10))} ${fmtMonthLongYear(last.month)}` : fmtMonthLongYear(last.month);
	const short = monthly.filter(wasShort).map((m) => fmtMonthLong(m.month));
	const shortText = short.length ? t('You were short in {months}.', { months: joinAnd(short) }) : t('You received all you needed every month.');
	return t('Water you needed and received each month, {from} to {to}. {short} The numbers are in the table below.', { from: fmtMonthLongYear(monthly[0]!.month), to: end, short: shortText });
}

/**
 * The engine's stress classes (network/reliability.ts, docs/model.md §4) in a
 * farmer's words (issue #70): how much of the month's need arrived, never
 * "stress" or "reliability".
 */
const STRESS_WORDS: Record<StressClass, Msg> = {
	low: msg('all or nearly all'),
	moderate: msg('a little short'),
	high: msg('short'),
	severe: msg('very short'),
	critical: msg('far too little')
};

/** The share of the month's need received and its class in words; '–' and '' without a need. */
export function supplyLevel(m: MonthTotals): { share: string; level: string } {
	const ratio = m.demandM3 > 0 ? m.suppliedM3 / m.demandM3 : null;
	const cls = stressClassOf(ratio);
	return cls === null || ratio === null ? { share: '–', level: '' } : { share: fmtPct(ratio), level: t(STRESS_WORDS[cls]) };
}

/** What each word under "Share received" means, from the engine's thresholds. */
export function supplyLevelKey(): string {
	const at = (cls: StressClass) => fmtPct(STRESS_THRESHOLDS.find((x) => x.cls === cls)!.min);
	return t('All or nearly all is {low} or more of what you needed; a little short, {moderate} or more; short, {high} or more; very short, {severe} or more; far too little, less than {severe}.', {
		low: at('low'),
		moderate: at('moderate'),
		high: at('high'),
		severe: at('severe')
	});
}

/** The "Show the numbers" rows: every month with its year, in the reader's unit (the chart's axis stays in ML), and the share received. */
export function supplyRows(monthly: readonly MonthTotals[], dataUntil: string, unit: VolumeUnit) {
	const labels = monthLabels(monthly, dataUntil);
	return monthly.map((m, i) => ({ label: labels[i]!.row, need: fmtVolume(m.demandM3, unit), got: fmtVolume(m.suppliedM3, unit), ...supplyLevel(m) }));
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
	if (!withDam.length) return t('No dam levels yet.');
	const labels = monthLabels(monthly, dataUntil);
	const last = labels[labels.length - 1]!;
	const end = last.partial ? `${Number(dataUntil.slice(8, 10))} ${fmtMonthLongYear(last.month)}` : fmtMonthLongYear(last.month);
	const low = withDam.reduce((a, b) => (b.damPctEnd < a.damPctEnd ? b : a));
	const high = withDam.reduce((a, b) => (b.damPctEnd > a.damPctEnd ? b : a));
	const latest = withDam[withDam.length - 1]!;
	// A complete last month is a month, not a day: "at the end of December 2024", never "on December 2024" (issue #51).
	return t(last.partial ? 'Dam level at the end of each month, {from} to {to}. Lowest {low} at the end of {lowMonth}, highest {high} at the end of {highMonth}, and {latest} on {to}. The numbers are in the table below.' : 'Dam level at the end of each month, {from} to {to}. Lowest {low} at the end of {lowMonth}, highest {high} at the end of {highMonth}, and {latest} at the end of {to}. The numbers are in the table below.', {
		from: fmtMonthLongYear(monthly[0]!.month),
		to: end,
		low: fmtPct(low.damPctEnd),
		lowMonth: fmtMonthLongYear(low.month),
		high: fmtPct(high.damPctEnd),
		highMonth: fmtMonthLongYear(high.month),
		latest: fmtPct(latest.damPctEnd)
	});
}

/** The dam table's rows: every month with its year. */
export function damRows(monthly: readonly MonthTotals[], dataUntil: string) {
	const labels = monthLabels(monthly, dataUntil);
	return monthly.map((m, i) => ({ label: labels[i]!.row, pct: m.damPctEnd == null ? '–' : fmtPct(m.damPctEnd) }));
}
