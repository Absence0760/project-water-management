import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '$lib/api/client';
import { describeReport, describeSchedule, emptyScheduleDraft, isPending, type ReportView, reportsApi, scheduleDraftToBody, scheduleStatus } from './serverPdf';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

const view = (over: Partial<ReportView> = {}): ReportView => ({
	jobId: 'j',
	status: 'queued',
	runId: 'r',
	impact: false,
	scheduled: false,
	pages: null,
	createdAt: '2026-09-25T10:00:00Z',
	finishedAt: null,
	error: null,
	emailed: 0,
	...over
});

/** The two parts of the app's API client reportsApi uses. */
const fakeApi = (request: unknown) => ({ request, reports: createApi('http://api.test').reports }) as never;

describe('reportsApi', () => {
	it('calls the report routes, with ids encoded', async () => {
		const request = vi.fn(async (..._a: unknown[]) => ({ jobId: 'j1', report: view(), schedules: [], schedule: { id: 's' } }) as never);
		const r = reportsApi(fakeApi(request), 'p/1');
		expect(await r.create({ runId: 'r', email: true })).toBe('j1');
		await r.get('j 1');
		await r.schedules();
		await r.addSchedule({ frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: ['u'] });
		await r.updateSchedule('s/1', { enabled: false });
		await r.removeSchedule('s');
		expect(request.mock.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
			'POST /projects/p%2F1/reports',
			'GET /projects/p%2F1/reports/j%201',
			'GET /projects/p%2F1/report-schedules',
			'POST /projects/p%2F1/report-schedules',
			'PATCH /projects/p%2F1/report-schedules/s%2F1',
			'DELETE /projects/p%2F1/report-schedules/s'
		]);
		expect(request.mock.calls[0]![2]).toEqual({ runId: 'r', email: true });
	});

	it('sends an impact report’s baseline as the report route’s `against`', async () => {
		const request = vi.fn(async (..._a: unknown[]) => ({ jobId: 'j2' }) as never);
		expect(await reportsApi(fakeApi(request), 'p').create({ runId: 'r', against: 'p0:r0' })).toBe('j2');
		expect(request.mock.calls[0]![2]).toEqual({ runId: 'r', against: 'p0:r0' });
	});

	it('links a done PDF to the API download route, built from the ids, never from the response', async () => {
		const got = async (status: ReportView['status'], url?: string) => {
			const request = vi.fn(async () => ({ report: view({ status }), ...(url === undefined ? {} : { url }) }) as never);
			return (await reportsApi(fakeApi(request), 'p/1').get('j 1')).url;
		};
		expect(await got('done')).toBe('http://api.test/projects/p%2F1/reports/j%201/pdf');
		// Not ready yet: no link.
		for (const s of ['queued', 'rendering', 'retrying', 'failed'] as const) expect(await got(s), s).toBeUndefined();
		// Whatever the response says is ignored: a hostile or stale link never reaches the href.
		for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://evil.example/x.pdf']) {
			expect(await got('done', hostile), hostile).toBe('http://api.test/projects/p%2F1/reports/j%201/pdf');
			expect(await got('queued', hostile), hostile).toBeUndefined();
		}
	});
});

describe('describeReport', () => {
	it('says where the PDF is, in words', () => {
		expect(isPending('queued') && isPending('rendering') && isPending('retrying')).toBe(true);
		expect(isPending('done') || isPending('failed')).toBe(false);
		expect(describeReport(view(), false)).toBe('PDF queued: waiting for the background worker…');
		expect(describeReport(view({ status: 'rendering' }), false)).toBe('Making the PDF…');
		expect(describeReport(view({ status: 'retrying', error: 'the browser failed' }), false)).toBe('The first try failed (the browser failed); trying again shortly…');
		expect(describeReport(view({ status: 'failed', error: 'the render took longer than 90 s' }), false)).toBe('The PDF could not be made: the render took longer than 90 s.');
		expect(describeReport(view({ status: 'done', pages: 1 }), false)).toBe('PDF ready (1 page).');
		expect(describeReport(view({ status: 'done', pages: 9, emailed: 1 }), true)).toBe('PDF ready (9 pages). The link is on its way by email.');
		expect(describeReport(view({ status: 'done', pages: 9, emailed: 1, error: 'the email to 1 of 1 recipients could not be sent' }), true)).toBe(
			'PDF ready (9 pages). The email to 1 of 1 recipients could not be sent.'
		);
	});
});

describe('schedules in words', () => {
	it('describes the timing in the schedule’s own zone', () => {
		expect(describeSchedule({ frequency: 'weekly', weekday: 1, monthDay: null, hour: 7, timezone: 'Africa/Johannesburg' })).toBe('Every Monday at 07:00 (Africa/Johannesburg)');
		expect(describeSchedule({ frequency: 'weekly', weekday: 7, monthDay: null, hour: 18, timezone: 'UTC' })).toBe('Every Sunday at 18:00 (UTC)');
		for (const [d, want] of [
			[1, '1st'],
			[2, '2nd'],
			[3, '3rd'],
			[4, '4th'],
			[11, '11th'],
			[12, '12th'],
			[13, '13th'],
			[21, '21st'],
			[22, '22nd'],
			[23, '23rd']
		] as const) {
			expect(describeSchedule({ frequency: 'monthly', weekday: null, monthDay: d, hour: 6, timezone: 'UTC' })).toBe(`On the ${want} of every month at 06:00 (UTC)`);
		}
	});

	it('says what comes next, or why nothing was sent, under a skewed TZ', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		expect(scheduleStatus({ enabled: false, nextAt: '2026-09-28T05:00:00Z', lastError: null, lastSentFor: null })).toBe('Paused.');
		expect(scheduleStatus({ enabled: true, nextAt: '2026-09-28T05:00:00Z', lastError: 'the project had no runs to report on', lastSentFor: '2026-09-21T05:00:00Z' })).toMatch(
			/^Next: .+\. Last time nothing was sent: the project had no runs to report on\.$/
		);
		expect(scheduleStatus({ enabled: true, nextAt: null, lastError: null, lastSentFor: '2026-09-21T05:00:00Z' })).toMatch(/^Last sent for .+\.$/);
	});
});

describe('scheduleDraftToBody', () => {
	it('sends the chosen frequency’s own day only, and needs a recipient and a zone', () => {
		const d = emptyScheduleDraft('me', 'Africa/Johannesburg');
		expect(scheduleDraftToBody(d)).toEqual({ body: { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'Africa/Johannesburg', recipients: ['me'] } });
		expect(scheduleDraftToBody({ ...d, frequency: 'monthly', monthDay: 15 })).toEqual({
			body: { frequency: 'monthly', monthDay: 15, hour: 7, timezone: 'Africa/Johannesburg', recipients: ['me'] }
		});
		expect(scheduleDraftToBody({ ...d, recipients: [] })).toEqual({ error: 'Choose at least one member to send the report to.' });
		expect(scheduleDraftToBody({ ...d, timezone: ' ' })).toEqual({ error: 'Enter a time zone, like Africa/Johannesburg.' });
		expect(emptyScheduleDraft(null, 'UTC').recipients).toEqual([]);
	});
});
