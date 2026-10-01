// Alert emails are service messages, never direct marketing (POPIA s1, s69;
// docs/security.md § Personal information, "Lawful basis"): an alert or a
// digest may link only to what the alert is about and to the reader's own
// controls over it. One promotional link ("try the new feature", an upsell, a
// newsletter) would make the email an s69 communication, which needs opt-in
// consent. So every alert and digest, for every kind, for a farmer and for
// staff, in English and Afrikaans, is rendered here and each link in its text
// and HTML must be one of the allowlist below. A new link in a template fails
// this test until it is added here, with why it is not promotion.
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS } from '../alerts/rules.js';
import { feedbackPageUrl, oneClickUrl, unsubscribePageUrl } from '../alerts/tokens.js';
import { alertMail, digestMail, type AlertFacts } from './alerts.js';
import { sitePage } from './templates.js';

const PROJECT = { id: '00000000-0000-4000-8000-000000000001', name: 'Rustenvrede WUA' };
const SITE = sitePage('');

/**
 * Paths on the app's own site an alert email may link to, each with why.
 * Anything else, on the site or off it, fails.
 */
const ALLOWED: { path: RegExp; why: string }[] = [
	{ path: /^\/alerts\/unsubscribe#t=[\w-]+$/, why: 'the one-click unsubscribe (the s11(3) objection)' },
	{ path: /^\/alerts\/feedback#t=[\w-]+&a=(yes|no)$/, why: '"Was this useful?" (151): about this alert, records nothing until Send' },
	{ path: new RegExp(`^/farm/${PROJECT.id}$`), why: 'a farmer’s own farm page, where the alert’s figures are' },
	{ path: new RegExp(`^/projects/${PROJECT.id}$`), why: 'the staff’s workspace of the project the alert is about' },
	{ path: /^\/account\/alerts$/, why: 'the reader’s alert settings' },
	{ path: /^\/account$/, why: 'the reader’s account page' },
	{ path: /^\/privacy$/, why: 'the privacy notice' }
];

const facts: Record<AlertFacts['kind'], AlertFacts[]> = {
	dam_below: [
		{ kind: 'dam_below', farm: 'Farm One', pct: 0.28, threshold: 0.3, source: 'latest', date: '2026-09-20' },
		{ kind: 'dam_below', farm: 'Farm One', pct: 0.28, threshold: 0.3, source: 'forecast', date: '2026-10-03', madeOn: '2026-09-26' }
	],
	ewr_forecast_fail: [
		{ kind: 'ewr_forecast_fail', days: 5, of: 14, from: '2026-09-27', to: '2026-10-10', madeOn: '2026-09-26', threshold: 3 },
		{ kind: 'ewr_forecast_fail', days: 5, of: 14, from: '2026-09-27', to: '2026-10-10', madeOn: '2026-09-26', threshold: 3, outOfDate: { observedTo: '2026-09-28', rainUntil: '2026-09-30' } }
	],
	data_stale: [
		{ kind: 'data_stale', threshold: 3, feeds: [{ label: 'DWS gauge flow', newest: '2026-01-02', overdue: 10 }] },
		{ kind: 'data_stale', threshold: 3, series: true, feeds: [{ label: 'Logger', newest: '2026-01-02', overdue: 10 }] }
	],
	feed_failing: [{ kind: 'feed_failing', threshold: 3, feeds: [{ label: 'CHIRPS', failures: 4 }] }],
	job_dead: [{ kind: 'job_dead', count: 2 }],
	farms_short: [{ kind: 'farms_short', count: 3, of: 14, from: '2026-09-20', to: '2026-09-26', publishedAt: '2026-09-27T04:00:00Z', threshold: 2 }],
	restriction_published: [
		{ kind: 'restriction_published', level: 'restricted', pct: 20, notice: 'Irrigate at night only.', noticeLang: 'en', publishedAt: '2026-09-26T08:00:00Z', lifted: false },
		{ kind: 'restriction_published', level: 'none', pct: null, notice: null, publishedAt: '2026-09-26T08:00:00Z', lifted: true }
	]
};

const unsubscribe = { pageUrl: unsubscribePageUrl('TOKEN_u-1'), oneClickUrl: oneClickUrl('TOKEN_u-1') };
const feedback = { yesUrl: feedbackPageUrl('TOKEN_f-1', true), noUrl: feedbackPageUrl('TOKEN_f-1', false) };

/** Every http(s) address in a mail part: href values in HTML, bare addresses in text. */
function links(part: string): string[] {
	return [...part.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));
}

function offending(urls: string[]): string[] {
	return urls.filter((u) => !(u.startsWith(SITE) && ALLOWED.some((a) => a.path.test(u.slice(SITE.length)))));
}

const all = Object.values(facts).flat();
const mails = ['en', 'af'].flatMap((locale) =>
	[true, false].flatMap((farmer) => {
		const to = { email: 'reader@example.com', locale, farmer };
		const label = `${locale} ${farmer ? 'farmer' : 'staff'}`;
		return [
			...all.map((f) => ({ label: `${label} ${f.kind}`, mail: alertMail(to, PROJECT, f, unsubscribe, feedback) })),
			...all.map((f) => ({ label: `${label} ${f.kind} without feedback`, mail: alertMail(to, PROJECT, f, unsubscribe) })),
			{ label: `${label} digest`, mail: digestMail(to, PROJECT, all, unsubscribe, 20, 3, feedback) }
		];
	})
);

describe('alert emails are service messages: links only to the alert and the reader’s controls (POPIA s69)', () => {
	it('covers every alert kind', () => {
		expect(Object.keys(facts).sort()).toEqual([...ALERT_KINDS].sort());
	});

	it.each(mails)('$label links nowhere but the allowlist', ({ mail }) => {
		const found = [...links(mail.text), ...links(mail.html)];
		expect(found.length).toBeGreaterThan(0);
		expect(offending(found)).toEqual([]);
		// The one-click header is the API's own unsubscribe address, nothing else.
		expect(mail.headers?.['List-Unsubscribe']).toBe(`<${unsubscribe.oneClickUrl}>`);
	});

	it('positive control: a promotional link, or one off the site, is caught', () => {
		expect(offending([sitePage('/pricing'), sitePage('/whats-new'), 'https://example.com/offer', `${SITE}/alerts/unsubscribe#t=x`])).toEqual([
			sitePage('/pricing'),
			sitePage('/whats-new'),
			'https://example.com/offer'
		]);
	});
});
