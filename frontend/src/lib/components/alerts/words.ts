// Alert emails on the translated pages (WP-2.13, docs/ui.md § Alerts): the
// alert emails page, the unsubscribe page and the farm view's alert card,
// from the message catalogue. Pure, so it is unit-tested apart from the pages.
import type { AlertChoice, AlertEvent, AlertMode, Unsubscribed, User } from '$lib/api/types';
import { ApiError } from '$lib/api/client';
import { fmtPct } from '$lib/components/farm/numbers';
import { msg, t, type Msg } from '$lib/i18n/locale.svelte';

export const ALERT_MODES: readonly AlertMode[] = ['immediate', 'daily_digest', 'off'];

// i18n-section: alerts.mode
const MODES: Record<AlertMode, Msg> = { immediate: msg('Right away'), daily_digest: msg('Once a day (06:00)'), off: msg('Off') };

const KINDS: Record<AlertChoice['kind'], Msg> = {
	// i18n-section: alerts.kind
	dam_below: msg('Dam running low'),
	ewr_forecast_fail: msg('River flow at risk in the forecast'),
	data_stale: msg('Data feed behind'),
	restriction_published: msg('Restriction notices from the WUA'),
	job_dead: msg('Failed background jobs'),
	feed_failing: msg('Failing data feeds'),
	farms_short: msg('Hydrological units short of water (automatic publications)')
};

const UNSUBSCRIBED: Record<Exclude<Unsubscribed['kind'], 'all'>, Msg> = {
	// i18n-section: unsubscribe.kind
	dam_below: msg('dam level'),
	ewr_forecast_fail: msg('river flow forecast'),
	data_stale: msg('missing data'),
	restriction_published: msg('restriction notice'),
	job_dead: msg('failed background job'),
	feed_failing: msg('failing data feed'),
	farms_short: msg('hydrological units short of water')
};

/** Immediate alert mails a person gets a day before the rest wait for the digest (the backend's ALERTS_DAILY_CAP default). */
export const DAILY_CAP = 5;

/** The token in an unsubscribe link's fragment (`#t=…`, 43 base64url characters), or null. */
export function fragmentToken(hash: string): string | null {
	const m = /^#?(?:.*&)?t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
	return m ? m[1]! : null;
}

/** "Dam running low: Farm One" or the kind's name. */
export function choiceLabel(c: Pick<AlertChoice, 'kind' | 'nodeName'>): string {
	// i18n-section: alerts.kind
	if (c.kind === 'dam_below' && c.nodeName) return t('Dam running low: {farm}', { farm: c.nodeName });
	return t(KINDS[c.kind]);
}

export const modeLabel = (m: AlertMode) => t(MODES[m]);

/**
 * "Warns when the model puts your dam below 30 %." for a farm's dam alert
 * the WUA has switched on, so a farmer knows the level (issue #51); null
 * otherwise. The level is the WUA's rule, not the farmer's to set.
 */
export function thresholdLine(c: Pick<AlertChoice, 'kind' | 'nodeId' | 'ruleOn' | 'threshold'>): string | null {
	if (c.kind !== 'dam_below' || !c.nodeId || !c.ruleOn || c.threshold == null) return null;
	// i18n-section: alerts
	return t('Warns when the model puts your dam below {pct}. Your WUA sets this level.', { pct: fmtPct(c.threshold) });
}

/** What the unsubscribe page says once it's done. */
export function unsubscribedText(u: Unsubscribed): string {
	// i18n-section: unsubscribe
	if (u.kind === 'all') return t('You won’t get any alert emails for {project} any more.', { project: u.project.name });
	return t('You won’t get {kind} emails for {project} any more.', { kind: t(UNSUBSCRIBED[u.kind]), project: u.project.name });
}

// ---- Paused: SES suppressed the address (the account and alert pages' banner) ----

/** Why alert emails are paused, in a sentence naming the address. */
export function suppressedText(s: NonNullable<User['mailSuppressed']>, email: string): string {
	// i18n-section: alerts
	return t(s.reason === 'complaint' ? 'Your alert emails are paused. An email we sent to {email} was marked as spam, so we stopped sending.' : 'Your alert emails are paused. Our emails to {email} bounced back: the address may be wrong, or the mailbox full or closed.', { email });
}

/** What the banner says when turning mail back on failed: the day's wait (429), else the server's message. */
export function resumeProblem(e: unknown): string {
	if (e instanceof ApiError && e.status === 429) return t('Emails to this address were refused again less than a day after you turned them back on. Check the address, then try again tomorrow.');
	return e instanceof Error ? e.message : String(e);
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---- Farm view ----------------------------------------------------------------

/** The farm's own firing dam alert, as the farm page's card says it; null when none. */
export function farmAlertText(events: AlertEvent[], nodeId: string, fmt: { pct: (f: number) => string; date: (iso: string) => string }): string | null {
	const e = events.find((x) => x.kind === 'dam_below' && x.nodeId === nodeId && x.state === 'firing');
	if (!e) return null;
	const d = e.detail;
	const vars = { threshold: fmt.pct(e.threshold), pct: fmt.pct(n(d.pct)), date: typeof d.date === 'string' ? fmt.date(d.date) : '' };
	// i18n-section: farm.alerts
	return t(d.source === 'forecast' ? 'On the rain forecast, your dam may fall below the alert level of {threshold}: about {pct} around {date}.' : 'Your dam is below the alert level of {threshold}: about {pct} on {date}.', vars);
}
