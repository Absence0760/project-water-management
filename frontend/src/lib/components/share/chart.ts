// The /share page's one chart: the river's monthly mean flow at the outlet
// against its ecological reserve (EWR), from POST /share/series. Inline SVG
// drawn at the rendered width, like the farm view's charts
// (lib/components/farm/chart.ts, whose axis rounding and sizes it shares).
// The SVG is decorative; the summary sentence and the "Show the numbers"
// table carry the content, and both come from here, worded from the message
// catalogue (the share.chart.* keys, WP-2.5).
import type { ShareSeries } from '$lib/api/types';
import { CHART_BASE, CHART_FONT_PX, CHART_HEIGHT, niceMax } from '$lib/components/farm/chartGeometry';
import { fmtMonthLongYear, fmtMonthShort, fmtMonthYear, fmtNumber, NBSP } from '$lib/components/farm/numbers';
import { t } from '$lib/i18n/locale.svelte';

/** The most recent months drawn. */
export const FLOW_MONTHS = 24;
const TOP = 10;

export interface FlowMonth {
	/** 'YYYY-MM'. */
	month: string;
	flow: number | null;
	ewr: number | null;
}

/** 'YYYY-MM' + n months. */
export function addMonths(month: string, n: number): string {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7)) - 1 + n;
	const yy = y + Math.floor(m / 12);
	const mm = ((m % 12) + 12) % 12;
	return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

/** The months the page's chart draws: the latest FLOW_MONTHS. */
export const recentMonths = (months: readonly FlowMonth[]) => months.slice(Math.max(0, months.length - FLOW_MONTHS));

/** The last `max` months of the flow series, each with the reserve of the same month (null where either has none). */
export function flowMonths(flow: ShareSeries, ewr: ShareSeries, max = FLOW_MONTHS): FlowMonth[] {
	const reserve = new Map(ewr.monthly.values.map((v, i) => [addMonths(ewr.monthly.startMonth, i), v]));
	const all = flow.monthly.values.map((v, i) => {
		const month = addMonths(flow.monthly.startMonth, i);
		return { month, flow: v, ewr: reserve.get(month) ?? null };
	});
	return all.slice(Math.max(0, all.length - max));
}

export interface FlowChart {
	width: number;
	height: number;
	axisLeft: number;
	ticks: { y: number; label: string }[];
	/** One polyline per unbroken run of months (a month with no value breaks the line). */
	flow: string[];
	ewr: string[];
	labels: { x: number; label: string }[];
}

const approxTextWidth = (s: string) => s.length * CHART_FONT_PX * 0.6;

function lines(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	values.forEach((v, i) => {
		if (v == null) {
			if (cur.length) out.push(cur.join(' '));
			cur = [];
			return;
		}
		cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
	});
	if (cur.length) out.push(cur.join(' '));
	return out;
}

export function flowChart(months: readonly FlowMonth[], width: number): FlowChart {
	const top = niceMax(Math.max(0, ...months.flatMap((m) => [m.flow ?? 0, m.ewr ?? 0])));
	const tickVals = [top, top / 2, 0];
	const tickText = tickVals.map((v) => fmtNumber(v));
	const axisLeft = Math.ceil(Math.max(...tickText.map(approxTextWidth))) + 6;
	const plotW = Math.max(width - axisLeft, 1);
	const step = plotW / Math.max(months.length, 1);
	const x = (i: number) => axisLeft + step * (i + 0.5);
	const y = (v: number) => CHART_BASE - (Math.max(v, 0) / top) * (CHART_BASE - TOP);
	// A label every few months, so they never collide: about one per 48 px.
	const every = Math.max(1, Math.ceil(48 / step));
	return {
		width,
		height: CHART_HEIGHT,
		axisLeft,
		ticks: tickVals.map((v, i) => ({ y: y(v), label: tickText[i]! })),
		flow: lines(
			months.map((m) => m.flow),
			x,
			y
		),
		ewr: lines(
			months.map((m) => m.ewr),
			x,
			y
		),
		labels: months.length > FLOW_MONTHS ? yearLabels(months, x, step) : months.flatMap((m, i) => ((months.length - 1 - i) % every === 0 ? [{ x: x(i), label: fmtMonthShort(m.month) }] : []))
	};
}

/**
 * Past two years (the member summary's whole run) a month name says nothing
 * without its year: label the Januaries with their year, every few years so
 * they never collide (about one per 48 px).
 */
function yearLabels(months: readonly FlowMonth[], x: (i: number) => number, step: number): { x: number; label: string }[] {
	const everyYears = Math.max(1, Math.ceil(48 / (step * 12)));
	return months.flatMap((m, i) => {
		const year = Number(m.month.slice(0, 4));
		return m.month.endsWith('-01') && year % everyYears === 0 ? [{ x: x(i), label: String(year) }] : [];
	});
}

/** Months whose mean flow was below the mean reserve. */
export const monthsBelow = (months: readonly FlowMonth[]) => months.filter((m) => m.flow != null && m.ewr != null && m.flow < m.ewr);

/** "The mean flow was below the reserve in 3 of the 24 months." (the summary sentence's verdict; the member summary prints it). */
export function flowVerdict(months: readonly FlowMonth[]): string {
	// i18n-section: share.chart
	const below = monthsBelow(months).length;
	return below === 0
		? t('The mean flow was above the reserve in every month.')
		: below === months.length
			? t('The mean flow was below the reserve in every month.')
			: t('The mean flow was below the reserve in {n} of the {months} months.', { n: below, months: months.length });
}

/** The chart's visually hidden summary. */
export function flowSummary(months: readonly FlowMonth[]): string {
	if (!months.length) return t('No flows to show.');
	const verdict = flowVerdict(months);
	return t('River flow at the catchment outlet each month against its ecological reserve, {from} to {to}. {verdict} The numbers are in the table below.', { from: fmtMonthLongYear(months[0]!.month), to: fmtMonthLongYear(months[months.length - 1]!.month), verdict });
}

/** "Oct 2021 to Sept 2023. Monthly means of the modelled daily flow." */
export const flowCaption = (months: readonly FlowMonth[]) =>
	months.length ? t('{from} to {to}. Monthly means of the modelled daily flow.', { from: fmtMonthYear(months[0]!.month), to: fmtMonthYear(months[months.length - 1]!.month) }) : '';

const m3Day = (v: number | null) => (v == null ? '–' : `${fmtNumber(Math.round(v))}${NBSP}m³`);

/** The table's rows: every month with its year, newest last. */
export const flowRows = (months: readonly FlowMonth[]) => months.map((m) => ({ label: fmtMonthYear(m.month), flow: m3Day(m.flow), ewr: m3Day(m.ewr) }));
