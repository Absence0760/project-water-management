// Server-side PDFs of the report and their schedules (WP-2.15 Phase B;
// docs/ui.md § Report, API: docs/api.md § Reports). The types mirror
// backend/src/reports/store.ts ReportView and routes.ts ScheduleView; the
// calls go through the app's API client, and the wording helpers are pure so
// they can be tested without a page. Loaded only with the chunks that use it.
import type { Api } from '$lib/api';
import { fmtDate } from '$lib/format/number';

export type ReportState = 'queued' | 'rendering' | 'retrying' | 'done' | 'failed';

export interface ReportView {
	jobId: string;
	status: ReportState;
	runId: string | null;
	/** An impact report (the run against a baseline). */
	impact: boolean;
	scheduled: boolean;
	pages: number | null;
	createdAt: string;
	finishedAt: string | null;
	error: string | null;
	emailed: number;
}

export interface ReportStatus {
	report: ReportView;
	/**
	 * The download link once done: the API's own route (api.reports.pdfUrl),
	 * which redirects a member to a one-minute pre-signed GET per click, so it
	 * works however long the page stays open.
	 */
	url?: string;
}

export interface ScheduleRecipient {
	userId: string;
	displayName: string;
	email: string;
}

export interface ReportSchedule {
	id: string;
	frequency: 'weekly' | 'monthly';
	weekday: number | null;
	monthDay: number | null;
	hour: number;
	timezone: string;
	enabled: boolean;
	recipients: ScheduleRecipient[];
	actingUser: string | null;
	nextAt: string | null;
	lastSentFor: string | null;
	lastError: string | null;
	updatedAt: string;
}

export interface ScheduleBody {
	frequency: 'weekly' | 'monthly';
	weekday?: number | null;
	monthDay?: number | null;
	hour: number;
	timezone: string;
	enabled?: boolean;
	recipients: string[];
}

export function reportsApi(api: Pick<Api, 'request' | 'reports'>, projectId: string) {
	const p = `/projects/${encodeURIComponent(projectId)}`;
	const sched = (id: string) => `${p}/report-schedules/${encodeURIComponent(id)}`;
	return {
		/** Queue a PDF: of `runId` (the latest without one), or its impact report `against` a baseline ("<projectId>:<runId>"), emailed to me (true) or to these members. */
		create: (body: { runId?: string; against?: string; email?: boolean | string[] }) => api.request<{ jobId: string }>('POST', `${p}/reports`, body).then((r) => r.jobId),
		get: (jobId: string) => api.request<ReportStatus>('GET', `${p}/reports/${encodeURIComponent(jobId)}`).then((s) => withLink(s, api.reports.pdfUrl(projectId, jobId))),
		schedules: () => api.request<{ schedules: ReportSchedule[] }>('GET', `${p}/report-schedules`).then((r) => r.schedules),
		addSchedule: (body: ScheduleBody) => api.request<{ schedule: ReportSchedule }>('POST', `${p}/report-schedules`, body).then((r) => r.schedule),
		updateSchedule: (id: string, patch: Partial<ScheduleBody>) => api.request<{ schedule: ReportSchedule }>('PATCH', sched(id), patch).then((r) => r.schedule),
		removeSchedule: (id: string) => api.request<void>('DELETE', sched(id))
	};
}

/**
 * The status with its download link once the PDF is done. The link is built
 * here from PUBLIC_API_URL and the ids, never taken from the response, so a
 * tampered or misconfigured response can't put a script URL in the page's
 * `href` (urlAttributes.security.test.ts).
 */
function withLink(s: ReportStatus, url: string): ReportStatus {
	const { url: _ignored, ...rest } = s;
	return rest.report.status === 'done' ? { ...rest, url } : rest;
}

/** Still in hand: poll again. */
export const isPending = (s: ReportState) => s === 'queued' || s === 'rendering' || s === 'retrying';

/** A report's status in words, for a role="status" line. */
export function describeReport(r: ReportView, email: boolean): string {
	switch (r.status) {
		case 'queued':
			return 'PDF queued: waiting for the background worker…';
		case 'rendering':
			return 'Making the PDF…';
		case 'retrying':
			return `The first try failed (${r.error ?? 'no reason given'}); trying again shortly…`;
		case 'failed':
			return `The PDF could not be made: ${r.error ?? 'no reason given'}.`;
		case 'done': {
			const pages = r.pages === 1 ? '1 page' : `${r.pages ?? '?'} pages`;
			const mailed = email && r.emailed ? (r.error ? ` ${capital(r.error)}.` : ' The link is on its way by email.') : '';
			return `PDF ready (${pages}).${mailed}`;
		}
	}
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** "Every Monday at 07:00 (Africa/Johannesburg)" / "On the 1st of every month at 06:00 (UTC)". */
export function describeSchedule(s: Pick<ReportSchedule, 'frequency' | 'weekday' | 'monthDay' | 'hour' | 'timezone'>): string {
	const when = s.frequency === 'weekly' ? `Every ${WEEKDAYS[(s.weekday ?? 1) - 1]}` : `On the ${ordinal(s.monthDay ?? 1)} of every month`;
	return `${when} at ${hh(s.hour)} (${s.timezone})`;
}

/** Next send, or why it won't: for the schedule's status line. */
export function scheduleStatus(s: Pick<ReportSchedule, 'enabled' | 'nextAt' | 'lastError' | 'lastSentFor'>): string {
	if (!s.enabled) return 'Paused.';
	const next = s.nextAt ? `Next: ${fmtDate(s.nextAt, true)}.` : '';
	const last = s.lastError ? ` Last time nothing was sent: ${s.lastError}.` : s.lastSentFor ? ` Last sent for ${fmtDate(s.lastSentFor, true)}.` : '';
	return `${next}${last}`.trim();
}

/** The schedule form's state. */
export interface ScheduleDraft {
	frequency: 'weekly' | 'monthly';
	weekday: number;
	monthDay: number;
	hour: number;
	timezone: string;
	recipients: string[];
}

/** The browser's own zone, or Johannesburg (the default the API uses too). */
export function localTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Johannesburg';
	} catch {
		return 'Africa/Johannesburg';
	}
}

export const emptyScheduleDraft = (me: string | null, timezone = localTimeZone()): ScheduleDraft => ({
	frequency: 'weekly',
	weekday: 1,
	monthDay: 1,
	hour: 7,
	timezone,
	recipients: me ? [me] : []
});

/** The request body for a draft, or the first problem in words. */
export function scheduleDraftToBody(d: ScheduleDraft): { body: ScheduleBody } | { error: string } {
	if (!d.recipients.length) return { error: 'Choose at least one member to send the report to.' };
	if (!d.timezone.trim()) return { error: 'Enter a time zone, like Africa/Johannesburg.' };
	return {
		body:
			d.frequency === 'weekly'
				? { frequency: 'weekly', weekday: d.weekday, hour: d.hour, timezone: d.timezone.trim(), recipients: d.recipients }
				: { frequency: 'monthly', monthDay: d.monthDay, hour: d.hour, timezone: d.timezone.trim(), recipients: d.recipients }
	};
}
