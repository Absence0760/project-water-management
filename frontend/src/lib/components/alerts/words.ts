// Alert emails on the translated pages (WP-2.13, docs/ui.md § Alerts): the
// alert emails page, the unsubscribe page and the farm view's alert card,
// from the message catalogue. Pure, so it is unit-tested apart from the pages.
import type { AlertChoice, AlertEvent, AlertMode, Unsubscribed, User } from '$lib/api/types';
import { ApiError } from '$lib/api/client';
import { t, type MessageKey } from '$lib/i18n/locale.svelte';

export const ALERT_MODES: readonly AlertMode[] = ['immediate', 'daily_digest', 'off'];

/** Immediate alert mails a person gets a day before the rest wait for the digest (the backend's ALERTS_DAILY_CAP default). */
export const DAILY_CAP = 5;

/** The token in an unsubscribe link's fragment (`#t=…`, 43 base64url characters), or null. */
export function fragmentToken(hash: string): string | null {
	const m = /^#?(?:.*&)?t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
	return m ? m[1]! : null;
}

/** "Dam running low: Farm One" or the kind's name. */
export function choiceLabel(c: Pick<AlertChoice, 'kind' | 'nodeName'>): string {
	if (c.kind === 'dam_below' && c.nodeName) return t('alerts.kind.damFarm', { farm: c.nodeName });
	return t(`alerts.kind.${c.kind}` as MessageKey);
}

export const modeLabel = (m: AlertMode) => t(`alerts.mode.${m}` as MessageKey);

/** What the unsubscribe page says once it's done. */
export function unsubscribedText(u: Unsubscribed): string {
	if (u.kind === 'all') return t('unsubscribe.doneAll', { project: u.project.name });
	return t('unsubscribe.done', { kind: t(`unsubscribe.kind.${u.kind}` as MessageKey), project: u.project.name });
}

// ---- Paused: SES suppressed the address (the account and alert pages' banner) ----

/** Why alert emails are paused, in a sentence naming the address. */
export function suppressedText(s: NonNullable<User['mailSuppressed']>, email: string): string {
	return t(s.reason === 'complaint' ? 'alerts.suppressed.complaint' : 'alerts.suppressed.bounce', { email });
}

/** What the banner says when turning mail back on failed: the day's wait (429), else the server's message. */
export function resumeProblem(e: unknown): string {
	if (e instanceof ApiError && e.status === 429) return t('alerts.suppressed.tooSoon');
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
	return t(d.source === 'forecast' ? 'farm.alerts.damForecast' : 'farm.alerts.dam', vars);
}
