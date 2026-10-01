// The member summary (issue #118, docs/ui.md § Share page): the /share page's
// catchment view on one or two sheets of A4, for a WUA to print or save as a
// PDF and send to its members, over a period they choose. It is the share
// page's own result, re-laid for paper (MemberSummary.svelte), not a second
// report: the same publication, the same counts the link already sends
// (catchment_view: the last 30 days, the season and the whole run, per EWR
// site) and the same flow series (behind the k rule, app_share_series), so a
// member sees nothing on paper that the link doesn't show on screen.
//
// Pure functions of POST /share/view's answer and the chart's months; the
// words come from the message catalogue (the share.summary section).
import type { SharedCatchmentView } from '$lib/api/types';
import { count, DAYS, fmtDay } from '$lib/components/farm/format';
import { msg } from '$lib/i18n/msg';
import { t } from '$lib/i18n/locale.svelte';
import type { FlowMonth } from './chart';
import type { ReserveState } from './share';

/** The periods a summary can cover: the ones the publication counts the reserve over. */
export const SUMMARY_WINDOWS = ['last30', 'season', 'run'] as const;
export type SummaryWindow = (typeof SUMMARY_WINDOWS)[number];

/** What the page offers first: a season notice is what a WUA sends members most. */
export const DEFAULT_WINDOW: SummaryWindow = 'season';

// i18n-section: share.summary
const WINDOW_NAMES = {
	last30: msg('The last 30 days'),
	season: msg('This season'),
	run: msg('The whole model run')
} as const;

/** The chart never draws fewer months than this: a month or two of flow says nothing about a river. */
export const SUMMARY_MIN_MONTHS = 12;

export interface WindowSpan {
	from: string;
	to: string;
	days: number;
}

/** The days a window covers, as the publication counted them. */
export function windowSpan(cv: SharedCatchmentView, w: SummaryWindow): WindowSpan {
	if (w === 'last30') return cv.last30;
	if (w === 'season') return cv.season;
	return { from: cv.runStart, to: cv.dataUntil, days: cv.runDays };
}

/** "This season" */
export const windowName = (w: SummaryWindow) => t(WINDOW_NAMES[w]);

/** "1 Oct 2023 to 10 Jan 2024" */
export function windowDates(cv: SharedCatchmentView, w: SummaryWindow): string {
	const s = windowSpan(cv, w);
	return t('{from} to {to}', { from: fmtDay(s.from), to: fmtDay(s.to) });
}

/** The line under the summary's heading: "This season: 1 Oct 2023 to 10 Jan 2024". */
export const windowLine = (cv: SharedCatchmentView, w: SummaryWindow) => t('{period}: {dates}', { period: windowName(w), dates: windowDates(cv, w) });

export interface SummaryRow {
	place: string;
	state: ReserveState;
	/** "Below its reserve on 12 of the 102 days from 1 Oct 2023 to 10 Jan 2024." */
	line: string;
}

/**
 * The reserve at each EWR site over the window, the outlet first, as on the
 * page. Always with its dates: paper outlives "the last 30 days".
 */
export function summaryRows(cv: SharedCatchmentView, w: SummaryWindow): SummaryRow[] {
	const span = windowSpan(cv, w);
	return cv.sites.map((s) => {
		const n = s.daysNotMet[w];
		const v = { n, days: count(DAYS, span.days), from: fmtDay(span.from), to: fmtDay(span.to) };
		return {
			place: s.isOutlet || !s.name ? t('At the catchment outlet') : t('At {place}', { place: s.name }),
			state: n <= 0 ? 'met' : n >= span.days ? 'missed' : 'partly',
			line:
				n <= 0
					? t('Kept its reserve on every one of the {days} from {from} to {to}.', v)
					: n >= span.days
						? t('Below its reserve on all of the {days} from {from} to {to}.', v)
						: t('Below its reserve on {n} of the {days} from {from} to {to}.', v)
		};
	});
}

/**
 * The chart's months for the window: those from the window's first month to
 * its last, and never fewer than SUMMARY_MIN_MONTHS (counting back from the
 * last), so "the last 30 days" still shows the year it sits in.
 */
export function summaryMonths(all: readonly FlowMonth[], cv: SharedCatchmentView, w: SummaryWindow): FlowMonth[] {
	const span = windowSpan(cv, w);
	const first = span.from.slice(0, 7);
	const last = span.to.slice(0, 7);
	const upTo = all.filter((m) => m.month <= last);
	const inside = upTo.filter((m) => m.month >= first);
	return inside.length >= SUMMARY_MIN_MONTHS ? inside : upTo.slice(Math.max(0, upTo.length - SUMMARY_MIN_MONTHS));
}

/** "Printed on 12 Jan 2024." The day the paper was made, which a reader can't otherwise tell. */
export const printedLine = (today: string) => t('Printed on {date}.', { date: fmtDay(today) });
