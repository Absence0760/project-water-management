// Alert emails (WP-2.13): escaping, both locales, the liability line, the
// unsubscribe links and RFC 8058 headers, and what a farmer's mail can name.
import { describe, expect, it } from 'vitest';
import { alertMail, dateText, digestMail, pctText, type AlertFacts } from './alerts.js';

const unsub = { pageUrl: 'http://localhost:7777/alerts/unsubscribe#t=TOKEN', oneClickUrl: 'http://localhost:3001/alerts/unsubscribe?token=TOKEN' };
const farmer = { email: 'f@example.com', locale: null, farmer: true };
const project = { id: 'p1', name: 'Rustenvrede WUA' };
const dam: AlertFacts = { kind: 'dam_below', farm: 'Farm One', pct: 0.28, threshold: 0.3, source: 'latest', date: '2026-09-20' };

describe('alertMail', () => {
	it('says what the model estimates, below which line, with the liability line and where to go', () => {
		const m = alertMail(farmer, project, dam, unsub);
		expect(m.subject).toBe('Dam low on Farm One — Rustenvrede WUA');
		expect(m.text).toContain('The model puts the dam on Farm One at about 28 % of capacity on 20 Sept 2026, below the alert level of 30 %.');
		expect(m.text).toContain('not a measurement, and not an instruction');
		expect(m.text).toContain('Open your farm: http://localhost:7777/farm/p1');
		expect(m.text).toContain('You get this email because you get dam level alerts for Rustenvrede WUA.');
		expect(m.text).toContain('Stop these emails: http://localhost:7777/alerts/unsubscribe#t=TOKEN');
		expect(m.text).toContain('Manage your alerts: http://localhost:7777/account/alerts');
		expect(m.html).toContain('<a href="http://localhost:7777/alerts/unsubscribe#t=TOKEN"');
	});

	it('carries the RFC 8058 one-click headers', () => {
		expect(alertMail(farmer, project, dam, unsub).headers).toEqual({
			'List-Unsubscribe': '<http://localhost:3001/alerts/unsubscribe?token=TOKEN>',
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
			'Auto-Submitted': 'auto-generated'
		});
	});

	it('words a forecast as what the model expects, with the day the forecast was made', () => {
		const m = alertMail(farmer, project, { ...dam, source: 'forecast', date: '2026-10-03', madeOn: '2026-09-26' }, unsub);
		expect(m.text).toContain('On the rain forecast of 26 Sept 2026, the model expects the dam on Farm One to fall to about 28 % of capacity around 3 Oct 2026');
		expect(m.text).toContain('Forecasts change.');
	});

	it('escapes user-controlled names in the HTML part (farm, project, notice)', () => {
		const m = alertMail(farmer, { id: 'p1', name: '<b>WUA</b>' }, { ...dam, farm: '"Farm" & <script>' }, unsub);
		expect(m.html).not.toContain('<script>');
		expect(m.html).not.toContain('<b>WUA</b>');
		expect(m.html).toContain('&quot;Farm&quot; &amp; &lt;script&gt;');
		const n = alertMail(farmer, project, { kind: 'restriction_published', level: 'restricted', pct: 20, notice: '<img src=x onerror=alert(1)>', publishedAt: '2026-09-26T08:00:00Z', lifted: false }, unsub);
		expect(n.html).not.toContain('<img');
		expect(n.text).toContain('The WUA’s notice: “<img src=x onerror=alert(1)>”');
	});

	it('sends Afrikaans readers Afrikaans, marked lang="af", with Afrikaans dates; English readers English', () => {
		const af = alertMail({ ...farmer, locale: 'af' }, project, dam, unsub);
		expect(af.html).toContain('<html lang="af">');
		expect(af.subject).toBe('Dam laag op Farm One — Rustenvrede WUA');
		// Dates follow the words' language.
		expect(af.text).toContain(dateText('2026-09-20', 'af'));
		expect(af.text).not.toContain('20 Sept 2026');
		expect(af.text).not.toContain('The model puts');
		const en = alertMail({ ...farmer, locale: 'en' }, project, dam, unsub);
		expect(en.html).toContain('<html lang="en">');
		expect(en.subject).toBe('Dam low on Farm One — Rustenvrede WUA');
	});

	it('names only the farm it was given: a farmer’s mail carries no other farm (the neighbour-name scan)', () => {
		const neighbours = ['Farm Two', 'Farm Three', 'Vaalbank'];
		const m = alertMail(farmer, project, dam, unsub);
		for (const n of neighbours) {
			expect(m.text).not.toContain(n);
			expect(m.html).not.toContain(n);
		}
	});

	it('sends the WUA to the workspace, and says a notice is the WUA’s own words (not a model estimate)', () => {
		const wua = { email: 'e@example.com', locale: null, farmer: false };
		const m = alertMail(wua, project, { kind: 'restriction_published', level: 'advisory', pct: null, notice: null, publishedAt: '2026-09-26T08:00:00Z', lifted: false }, unsub);
		expect(m.text).toContain('Open the catchment: http://localhost:7777/projects/p1');
		expect(m.text).toContain('The WUA published a notice for Rustenvrede WUA on 26 Sept 2026: please use less water (advisory).');
		expect(m.text).toContain('This notice is the WUA’s own.');
		expect(m.text).not.toContain('not a measurement');
	});

	it('words each WUA kind', () => {
		const wua = { email: 'e@example.com', locale: null, farmer: false };
		expect(alertMail(wua, project, { kind: 'ewr_forecast_fail', days: 5, of: 14, from: '2026-09-27', to: '2026-10-10', madeOn: '2026-09-26', threshold: 3 }, unsub).text).toContain(
			'missed on 5 of the 14 forecast days (27 Sept 2026 to 10 Oct 2026)'
		);
		expect(alertMail(wua, project, { kind: 'data_stale', threshold: 3, feeds: [{ label: 'DWS gauge flow', newest: '2026-01-02', overdue: 10 }] }, unsub).text).toContain(
			'DWS gauge flow: newest day 2 Jan 2026, 10 days late'
		);
		expect(alertMail(wua, project, { kind: 'feed_failing', threshold: 3, feeds: [{ label: 'CHIRPS', failures: 4 }] }, unsub).text).toContain('CHIRPS: 4 failures in a row');
		expect(alertMail(wua, project, { kind: 'job_dead', count: 2 }, unsub).subject).toBe('Background jobs failed — Rustenvrede WUA');
	});
});

describe('digestMail', () => {
	it('lists every alert in one email with one unsubscribe for the project, and says why it came', () => {
		const m = digestMail(farmer, project, [dam, { ...dam, pct: 0.2 }], unsub, 5);
		expect(m.subject).toBe('Your alerts for Rustenvrede WUA — Water Management');
		expect(m.text.match(/Dam low on Farm One:/g)).toHaveLength(2);
		expect(m.text).toContain('or had more than 5 alert emails in a day');
		expect(m.text).toContain('Stop all alert emails for this catchment: http://localhost:7777/alerts/unsubscribe#t=TOKEN');
		expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(m.text).not.toContain('more alerts');
	});

	it('ends a digest cut at its line limit with how many more, pointing at the app', () => {
		const m = digestMail(farmer, project, [dam], unsub, 5, 80);
		expect(m.text).toContain('…and 80 more alerts. Open the catchment to see them all.');
		expect(m.text).toContain('Open your farm: http://localhost:7777/farm/p1');
	});
});

describe('formatting', () => {
	it('writes percentages the farm view’s way and dates in the mail’s language', () => {
		expect(pctText(0.284)).toBe('28 %');
		expect(pctText(1.2)).toBe('100 %');
		expect(dateText('2026-09-20', 'en')).toBe('20 Sept 2026');
		// en-ZA from the language table, written the way en-GB was: no leading zero on the day.
		expect(dateText('2026-10-03', 'en')).toBe('3 Oct 2026');
		expect(dateText('not a date', 'en')).toBe('not a date');
	});
});
