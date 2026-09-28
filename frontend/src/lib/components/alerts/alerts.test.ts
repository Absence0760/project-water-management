// The alert pages' words and parsing (WP-2.13): the workspace's (./alerts.ts) and the translated pages' (./words.ts).
import { describe, expect, it } from 'vitest';
import type { AlertEvent, AlertRule } from '$lib/api/types';
import { eventText, feedRuleLabel, groupRules, thresholdFromInput, thresholdLabel, thresholdProblem, thresholdToInput } from './alerts';
import { ApiError } from '$lib/api/client';
import { choiceLabel, farmAlertText, fragmentToken, modeLabel, resumeProblem, suppressedText, thresholdLine, unsubscribedText } from './words';

// A token's shape (43 base64url characters); low entropy, so no secret scanner mistakes it for a key.
const TOKEN = 'a'.repeat(20) + '_-' + 'b'.repeat(21);
const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
	id: 'e1',
	kind: 'dam_below',
	state: 'firing',
	value: 0.08,
	threshold: 0.3,
	nodeId: 'n1',
	nodeName: 'Farm One',
	feedId: null,
	openedAt: '2026-09-26T08:00:00Z',
	clearedAt: null,
	detail: { source: 'latest', pct: 0.08, date: '2026-09-20' },
	...over
});

describe('fragmentToken', () => {
	it('reads the token from #t=…, and nothing else', () => {
		expect(TOKEN).toHaveLength(43);
		expect(fragmentToken(`#t=${TOKEN}`)).toBe(TOKEN);
		expect(fragmentToken(`t=${TOKEN}`)).toBe(TOKEN);
		expect(fragmentToken(`#x=1&t=${TOKEN}`)).toBe(TOKEN);
		expect(fragmentToken(`#t=${TOKEN}x`)).toBeNull();
		expect(fragmentToken('#t=short')).toBeNull();
		expect(fragmentToken('')).toBeNull();
		expect(fragmentToken(`#t=${TOKEN.slice(0, 42)}!`)).toBeNull();
	});
});

describe('the preferences page’s words', () => {
	it('names a farmer’s dam alert by their farm, and every other kind by its name', () => {
		expect(choiceLabel({ kind: 'dam_below', nodeName: 'Farm One' })).toBe('Dam running low: Farm One');
		expect(choiceLabel({ kind: 'dam_below', nodeName: null })).toBe('Dam running low');
		expect(choiceLabel({ kind: 'restriction_published', nodeName: null })).toBe('Restriction notices from the WUA');
		expect(['immediate', 'daily_digest', 'off'].map((m) => modeLabel(m as 'off'))).toEqual(['Right away', 'Once a day (06:00)', 'Off']);
	});

	// Issue #51: the page never said at what level a farmer is warned.
	it('says the level a farm’s dam alert warns below, only when the WUA has it on', () => {
		const dam = { kind: 'dam_below' as const, nodeId: 'n1', ruleOn: true, threshold: 0.3 };
		expect(thresholdLine(dam)?.replace(/\u00a0/g, ' ')).toBe('Warns when the model puts your dam below 30 %. Your WUA sets this level.');
		expect(thresholdLine({ ...dam, ruleOn: false })).toBeNull();
		expect(thresholdLine({ ...dam, threshold: null })).toBeNull();
		expect(thresholdLine({ ...dam, nodeId: null })).toBeNull();
		expect(thresholdLine({ kind: 'restriction_published', nodeId: null, ruleOn: true, threshold: null })).toBeNull();
	});

	it('names every kind of alert, and each in an unsubscribe sentence', () => {
		const kinds = ['dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing'] as const;
		expect(kinds.map((kind) => choiceLabel({ kind, nodeName: null }))).toEqual([
			'Dam running low',
			'River flow at risk in the forecast',
			'Data feed behind',
			'Restriction notices from the WUA',
			'Failed background jobs',
			'Failing data feeds'
		]);
		expect(kinds.map((kind) => unsubscribedText({ kind, project: { name: 'R' }, farm: null }))).toEqual(
			['dam level', 'river flow forecast', 'missing data', 'restriction notice', 'failed background job', 'failing data feed'].map(
				(k) => `You won’t get ${k} emails for R any more.`
			)
		);
	});

	it('says what the unsubscribe turned off', () => {
		expect(unsubscribedText({ kind: 'dam_below', project: { name: 'Rustenvrede' }, farm: 'Farm One' })).toBe('You won’t get dam level emails for Rustenvrede any more.');
		expect(unsubscribedText({ kind: 'all', project: { name: 'Rustenvrede' }, farm: null })).toBe('You won’t get any alert emails for Rustenvrede any more.');
	});
});

describe('the paused-alerts banner (SES suppressed the address)', () => {
	it('says why, naming the address', () => {
		expect(suppressedText({ reason: 'bounce', at: '2026-09-20T08:00:00Z' }, 'ann@example.com')).toBe(
			'Your alert emails are paused. Our emails to ann@example.com bounced back: the address may be wrong, or the mailbox full or closed.'
		);
		expect(suppressedText({ reason: 'complaint', at: '2026-09-20T08:00:00Z' }, 'ann@example.com')).toBe(
			'Your alert emails are paused. An email we sent to ann@example.com was marked as spam, so we stopped sending.'
		);
	});

	it('explains the day’s wait (429), and passes any other failure’s message through', () => {
		expect(resumeProblem(new ApiError(429, 'too soon'))).toBe(
			'Emails to this address were refused again less than a day after you turned them back on. Check the address, then try again tomorrow.'
		);
		expect(resumeProblem(new ApiError(500, 'Internal error'))).toBe('Internal error');
		expect(resumeProblem('offline')).toBe('offline');
	});
});

describe('the workspace’s Active alerts', () => {
	it('writes each firing alert as a sentence', () => {
		expect(eventText(event())).toBe('Farm One: dam about 8 % on 20 Sep 2026 (alert below 30 %)');
		expect(eventText(event({ detail: { source: 'forecast', pct: 0.12, date: '2026-10-03' } }))).toBe(
			'Farm One: dam may fall to about 12 % around 3 Oct 2026 on the forecast (alert below 30 %)'
		);
		expect(eventText(event({ kind: 'ewr_forecast_fail', nodeId: null, nodeName: null, threshold: 3, detail: { days: 5, of: 14 } }))).toBe(
			'EWR at the outlet at risk on 5 of 14 forecast days (alert at 3)'
		);
		expect(eventText(event({ kind: 'data_stale', detail: { feeds: [{ label: 'DWS gauge flow', overdue: 10 }] } }))).toBe('Late: DWS gauge flow (10 days)');
		expect(eventText(event({ kind: 'job_dead', detail: { count: 1 } }))).toBe('1 background job failed in the last 24 hours');
		expect(eventText(event({ kind: 'feed_failing', detail: {} }))).toBe('A data feed is failing');
	});
});

describe('the rule editor', () => {
	it('types a dam level in percent and stores a fraction', () => {
		expect(thresholdToInput('dam_below', 0.3)).toBe(30);
		expect(thresholdFromInput('dam_below', 25)).toBe(0.25);
		expect(thresholdToInput('data_stale', 3)).toBe(3);
	});

	it('refuses a level outside its kind’s range', () => {
		expect(thresholdProblem('dam_below', 30)).toBeNull();
		expect(thresholdProblem('dam_below', 0)).toBe('Between 1 and 99.');
		expect(thresholdProblem('ewr_forecast_fail', 2.5)).toBe('Enter a whole number.');
		expect(thresholdProblem('data_stale', Number.NaN)).toBe('Enter a number.');
		expect(thresholdProblem('restriction_published', 0)).toBeNull();
	});

	it('puts the catchment’s rules first, then the farms’ dam rules, then a staleness rule per data feed', () => {
		const r = (kind: AlertRule['kind'], enabled = false): AlertRule => ({
			id: null,
			kind,
			nodeId: kind === 'dam_below' ? 'n' : null,
			nodeName: null,
			feedId: kind === 'data_stale' ? 'f' : null,
			feedName: kind === 'data_stale' ? 'DWS gauge flow (gauge)' : null,
			feedEnabled: kind === 'data_stale' ? true : null,
			threshold: 1,
			enabled,
			firing: false
		});
		const g = groupRules([r('dam_below'), r('data_stale'), r('ewr_forecast_fail'), r('dam_below', true)]);
		expect(g.catchment.map((x) => x.kind)).toEqual(['ewr_forecast_fail']);
		expect(g.farms).toHaveLength(2);
		expect(g.feeds.map((x) => x.feedId)).toEqual(['f']);
		expect(g.anyOn).toBe(true);
	});

	it('labels a feed’s staleness rule by the feed, and says when the feed is switched off', () => {
		expect(feedRuleLabel({ feedName: 'CHIRPS daily rainfall (Upper)', feedEnabled: true })).toBe('CHIRPS daily rainfall (Upper)');
		expect(feedRuleLabel({ feedName: 'CHIRPS daily rainfall (Upper)', feedEnabled: false })).toBe('CHIRPS daily rainfall (Upper) (feed switched off)');
		expect(thresholdLabel('data_stale')).toBe('Alert after (days later than usual for this feed)');
	});
});

describe('the farm page’s alert card', () => {
	const fmt = { pct: (f: number) => `${Math.round(f * 100)} %`, date: (d: string) => d };
	it('says the farm’s own firing dam alert, and nothing for another farm or a cleared one', () => {
		expect(farmAlertText([event()], 'n1', fmt)).toBe('Your dam is below the alert level of 30 %: about 8 % on 2026-09-20.');
		expect(farmAlertText([event()], 'n2', fmt)).toBeNull();
		expect(farmAlertText([event({ state: 'cleared' })], 'n1', fmt)).toBeNull();
		expect(farmAlertText([event({ detail: { source: 'forecast', pct: 0.1, date: '2026-10-03' } })], 'n1', fmt)).toBe(
			'On the rain forecast, your dam may fall below the alert level of 30 %: about 10 % around 2026-10-03.'
		);
	});
});
