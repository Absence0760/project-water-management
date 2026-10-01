// Alert emails (WP-2.13): escaping, both locales, the liability line, the
// unsubscribe links and RFC 8058 headers, and what a farmer's mail can name.
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../alerts/rules.js';
import { alertMail, cutPctText, dateText, digestMail, liabilityKey, pctText, type AlertFacts } from './alerts.js';
import { en } from './i18n/en.js';

const unsub = { pageUrl: 'http://localhost:7777/alerts/unsubscribe#t=TOKEN', oneClickUrl: 'http://localhost:3001/alerts/unsubscribe?token=TOKEN' };
const farmer = { email: 'f@example.com', locale: null, farmer: true };
const project = { id: 'p1', name: 'Rustenvrede WUA' };
const dam: AlertFacts = { kind: 'dam_below', farm: 'Farm One', pct: 0.28, threshold: 0.3, source: 'latest', date: '2026-09-20' };
const staff = { email: 'e@example.com', locale: null, farmer: false };
const ONE_OF_EACH: Record<AlertFacts['kind'], AlertFacts> = {
	dam_below: dam,
	ewr_forecast_fail: { kind: 'ewr_forecast_fail', days: 5, of: 14, from: '2026-09-27', to: '2026-10-10', madeOn: '2026-09-26', threshold: 3 },
	data_stale: { kind: 'data_stale', threshold: 3, feeds: [{ label: 'DWS gauge flow', newest: '2026-01-02', overdue: 10 }] },
	feed_failing: { kind: 'feed_failing', threshold: 3, feeds: [{ label: 'CHIRPS', failures: 4 }] },
	job_dead: { kind: 'job_dead', count: 2 },
	farms_short: { kind: 'farms_short', count: 3, of: 14, from: '2026-09-20', to: '2026-09-26', publishedAt: '2026-09-27T04:00:00Z', threshold: 2 },
	restriction_published: { kind: 'restriction_published', level: 'advisory', pct: null, notice: null, publishedAt: '2026-09-26T08:00:00Z', lifted: false }
};
const LIABILITY = [en['mail.alert.model'], en['mail.alert.model.dam.staff'], en['mail.alert.model.staff'], en['mail.alert.model.short.staff'], en['mail.alert.restriction.wua']];

describe('alertMail', () => {
	it('says what the model estimates, below which line, with the liability line and where to go', () => {
		const m = alertMail(farmer, project, dam, unsub);
		expect(m.subject).toBe('Dam low on Farm One — Rustenvrede WUA');
		expect(m.text).toContain('The model puts the dam on Farm One at about 28 % of capacity on 20 Sept 2026, below the alert level of 30 %.');
		expect(m.text).toContain('It is not a measurement of your dam and not an instruction.');
		expect(m.text).toContain('Open your hydrological unit: http://localhost:7777/farm/p1');
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
		// A cut, as the WUA entered it and the farm page says it (never “20 % of registered use”, which reads as an allowance).
		expect(n.text).toMatch(/: restricted, a 20\s% cut in registered water use\./);
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
		// Counted (issue #51): never "1 days", "1 failures", "1 background jobs".
		const one = alertMail(wua, project, { kind: 'data_stale', threshold: 1, feeds: [{ label: 'DWS gauge flow', newest: '2026-01-02', overdue: 1 }] }, unsub).text;
		expect(one).toContain('more than 1 day later than usual');
		expect(one).toContain('DWS gauge flow: newest day 2 Jan 2026, 1 day late');
		expect(alertMail(wua, project, { kind: 'feed_failing', threshold: 1, feeds: [{ label: 'CHIRPS', failures: 1 }] }, unsub).text).toContain('CHIRPS: 1 failure in a row');
		expect(alertMail(wua, project, { kind: 'job_dead', count: 1 }, unsub).text).toContain('1 background job failed for good');
		expect(digestMail(farmer, project, [dam], unsub, 5, 1).text).toContain('…and 1 more alert. Open the catchment to see it.');
		expect(alertMail(wua, project, { kind: 'job_dead', count: 2 }, unsub).subject).toBe('Background jobs failed — Rustenvrede WUA');
	});

	it('names an ingest-key series as data sent by API key, not a data feed (issue #120)', () => {
		const m = alertMail(staff, project, { kind: 'data_stale', series: true, threshold: 2, feeds: [{ label: 'Weir', newest: '2026-09-20', overdue: 5 }] }, unsub);
		expect(m.subject).toBe('API data behind — Rustenvrede WUA');
		expect(m.text).toContain('No new readings have come in through the API key for this series for more than 2 days:');
		expect(m.text).toContain('Weir: newest day 20 Sept 2026, 5 days late');
		expect(m.text).not.toContain('data feed');
		const one = alertMail(staff, project, { kind: 'data_stale', series: true, threshold: 1, feeds: [{ label: 'S', newest: '2026-09-20', overdue: 1 }] }, unsub).text;
		expect(one).toContain('for more than 1 day:');
	});

	it('words farms_short as counts from an automatic publication, never a farm’s name (issue #120)', () => {
		const m = alertMail(staff, project, ONE_OF_EACH.farms_short, unsub);
		expect(m.subject).toBe('Hydrological units short of water — Rustenvrede WUA');
		// 04:00 UTC on the 27th is the 27th in South Africa (the catchment's day).
		expect(m.text).toContain(
			'An auto run published new figures on 27 Sept 2026. Hydrological units short of water on at least one day from 20 Sept 2026 to 26 Sept 2026: 3 of 14. The alert is set at 2.'
		);
		expect(m.text).toContain('You get this email because you get hydrological units short of water alerts for Rustenvrede WUA.');
	});
});

describe('the liability line, per kind', () => {
	// A dam alert reads the published figures; the EWR forecast alert reads the
	// newest forecast run, published or not; a notice is the WUA's own words;
	// the operational alerts are no model figure and carry no liability line.
	const expected: Record<AlertFacts['kind'], string | null> = {
		dam_below: en['mail.alert.model.dam.staff'],
		ewr_forecast_fail: en['mail.alert.model.staff'],
		farms_short: en['mail.alert.model.short.staff'],
		restriction_published: en['mail.alert.restriction.wua'],
		data_stale: null,
		feed_failing: null,
		job_dead: null
	};

	it.each([...ALERT_KINDS])('gives %s to the WUA’s staff its own line and no other', (kind) => {
		const m = alertMail(staff, project, ONE_OF_EACH[kind], unsub);
		const want = expected[kind];
		for (const line of LIABILITY) {
			if (line === want) expect(m.text, kind).toContain(line);
			else expect(m.text, kind).not.toContain(line);
		}
		expect(liabilityKey(kind, false) === null).toBe(want === null);
	});

	it('gives a farmer’s dam alert the farmer’s line (“your dam”), and the staff’s the WUA’s', () => {
		const f = alertMail(farmer, project, dam, unsub);
		expect(f.text).toContain(en['mail.alert.model']);
		expect(f.text).not.toContain(en['mail.alert.model.dam.staff']);
		const s = alertMail(staff, project, dam, unsub);
		expect(s.text).toContain(en['mail.alert.model.dam.staff']);
		expect(s.text).not.toContain(en['mail.alert.model']);
		expect(s.text).not.toContain('your dam');
		expect(liabilityKey('dam_below', true)).toBe('mail.alert.model');
		expect(liabilityKey('restriction_published', true)).toBe('mail.alert.restriction.wua');
	});

	it('gives a farmer’s dam alert the published-figures line in Afrikaans too', () => {
		const m = alertMail({ ...farmer, locale: 'af' }, project, dam, unsub);
		expect(m.text).toContain('Net ’n kennisgewing van jou WGV of van die DWS is ’n beperking.');
	});

	it('gives a digest each distinct line once, and none for operational alerts alone', () => {
		const ops = digestMail(staff, project, [ONE_OF_EACH.data_stale, ONE_OF_EACH.feed_failing, ONE_OF_EACH.job_dead], unsub, 5);
		for (const line of LIABILITY) expect(ops.text).not.toContain(line);
		const all = digestMail(staff, project, [dam, dam, ONE_OF_EACH.ewr_forecast_fail, ONE_OF_EACH.farms_short, ONE_OF_EACH.farms_short, ONE_OF_EACH.restriction_published, ONE_OF_EACH.job_dead], unsub, 5);
		for (const line of LIABILITY.filter((l) => l !== en['mail.alert.model'])) expect(all.text.split(line)).toHaveLength(2);
		expect(all.text).not.toContain(en['mail.alert.model']);
		const mine = digestMail(farmer, project, [dam, ONE_OF_EACH.restriction_published], unsub, 5);
		expect(mine.text.split(en['mail.alert.model'])).toHaveLength(2);
		expect(mine.text).not.toContain(en['mail.alert.model.dam.staff']);
	});
});

// Issue #51 (WCAG 3.1.2): the notice falls back to another language than the mail's; it keeps its own lang.
describe('the WUA’s notice in another language', () => {
	const notice = (noticeLang: string | null, text = 'Irrigate at night.'): AlertFacts => ({ kind: 'restriction_published', level: 'advisory', pct: null, notice: text, noticeLang, publishedAt: '2026-09-26T08:00:00Z', lifted: false });
	const af = { ...farmer, locale: 'af' };

	it('marks an English notice in an Afrikaans mail with lang="en", in the one alert and in the digest', () => {
		const m = alertMail(af, project, notice('en'), unsub);
		expect(m.html).toContain('<html lang="af">');
		expect(m.html).toMatch(/“<span lang="en">Irrigate at night\.<\/span>”/);
		expect(m.text).toContain('“Irrigate at night.”');
		const d = digestMail(af, project, [dam, notice('en')], unsub, 5);
		expect(d.html).toContain('<span lang="en">Irrigate at night.</span>');
		expect(d.text).toContain('“Irrigate at night.”');
	});

	it('leaves a notice in the mail’s own language unmarked, and escapes both the words and the code', () => {
		expect(alertMail(af, project, notice('af'), unsub).html).not.toContain('<span lang=');
		expect(alertMail(farmer, project, notice('en'), unsub).html).not.toContain('<span lang=');
		const x = alertMail(af, project, notice('en"><script>', '<b>x</b>'), unsub).html;
		expect(x).not.toContain('<script>');
		expect(x).not.toContain('<b>x</b>');
		expect(x).toContain('<span lang="en&quot;&gt;&lt;script&gt;">&lt;b&gt;x&lt;/b&gt;</span>');
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
		expect(m.text).toContain('Open your hydrological unit: http://localhost:7777/farm/p1');
	});
});

describe('"Was this useful?" (147_alert_feedback)', () => {
	const fb = { yesUrl: 'http://localhost:7777/alerts/feedback#t=FB&a=yes', noUrl: 'http://localhost:7777/alerts/feedback#t=FB&a=no' };

	it('asks under the action with two plain links, in text and HTML, and never an image', () => {
		const m = alertMail(farmer, project, dam, unsub, fb);
		expect(m.text).toContain('Was this alert useful?\nYes: http://localhost:7777/alerts/feedback#t=FB&a=yes\nNo: http://localhost:7777/alerts/feedback#t=FB&a=no');
		expect(m.html).toContain('Was this alert useful? <a href="http://localhost:7777/alerts/feedback#t=FB&amp;a=yes"');
		expect(m.html).toContain('<a href="http://localhost:7777/alerts/feedback#t=FB&amp;a=no"');
		expect(m.html).not.toMatch(/<img\b/i);
		// After the action, before "why you got this".
		expect(m.text.indexOf('Was this alert useful?')).toBeGreaterThan(m.text.indexOf('Open your hydrological unit'));
		expect(m.text.indexOf('Was this alert useful?')).toBeLessThan(m.text.indexOf('You get this email because'));
	});

	it('asks about the summary in a digest, and in Afrikaans for an Afrikaans reader', () => {
		expect(digestMail(staff, project, [dam], unsub, 5, 0, fb).text).toContain('Was this summary useful?');
		const af = alertMail({ ...farmer, locale: 'af' }, project, dam, unsub, fb);
		expect(af.text).not.toContain('Was this alert useful?');
		expect(af.text).toContain('Was hierdie waarskuwing nuttig?\nJa: ');
		expect(af.text).toContain('#t=FB&a=yes');
	});

	it('asks nothing without links', () => {
		expect(alertMail(farmer, project, dam, unsub).text).not.toContain('useful');
	});
});

describe('formatting', () => {
	// Issue #51: numeric(5,2) gave "12.5 %" (a decimal point) in an Afrikaans mail while the farm page showed "13 %".
	it('writes the WUA’s cut as the farm page does: whole, with the ends marked', () => {
		expect([12.5, 20, 0, 0.4, 99.6, 100, 150].map((p) => cutPctText(p).replace(/\u00a0/g, ' '))).toEqual(['13 %', '20 %', '0 %', '<1 %', '>99 %', '100 %', '100 %']);
		const m = alertMail({ ...farmer, locale: 'af' }, project, { kind: 'restriction_published', level: 'restricted', pct: 12.5, notice: null, publishedAt: '2026-09-26T08:00:00Z', lifted: false }, unsub);
		expect(m.text).toMatch(/13\s%/);
		expect(m.text).not.toContain('12.5');
	});

	// Issue #51: a notice published at 01:00 on 2 October in South Africa is 23:00 on the 1st in UTC.
	it('dates a timestamp by its day in the catchment’s zone, whatever the server’s zone', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'America/Los_Angeles';
		try {
			expect(dateText('2026-10-01T23:00:00.000Z', 'en', 'Africa/Johannesburg')).toBe('2 Oct 2026');
			expect(dateText('2026-10-01T23:00:00.000Z', 'en', 'UTC')).toBe('1 Oct 2026');
			// South Africa's by default; a calendar day is never shifted.
			expect(dateText('2026-10-01T23:00:00.000Z', 'en')).toBe('2 Oct 2026');
			expect(dateText('2026-10-01', 'en', 'Pacific/Kiritimati')).toBe('1 Oct 2026');
			const m = alertMail(farmer, { ...project, timeZone: 'Africa/Johannesburg' }, { kind: 'restriction_published', level: 'advisory', pct: null, notice: null, publishedAt: '2026-10-01T23:00:00.000Z', lifted: false }, unsub);
			expect(m.text).toContain('on 2 Oct 2026: please use less water (advisory).');
		} finally {
			process.env.TZ = tz;
		}
	});

	it('writes percentages the farm view’s way and dates in the mail’s language', () => {
		expect(pctText(0.284)).toBe('28 %');
		expect(pctText(1.2)).toBe('100 %');
		expect(dateText('2026-09-20', 'en')).toBe('20 Sept 2026');
		// en-ZA from the language table, written the way en-GB was: no leading zero on the day.
		expect(dateText('2026-10-03', 'en')).toBe('3 Oct 2026');
		expect(dateText('not a date', 'en')).toBe('not a date');
	});
});
