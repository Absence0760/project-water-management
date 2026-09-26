// Alert emails on the translated pages (WP-2.13, docs/ui.md § Alerts): the
// alert emails page, the unsubscribe page and the farm view's alert card,
// from the message catalogue. Pure, so it is unit-tested apart from the pages.
import type { AlertChoice, AlertEvent, AlertMode, Unsubscribed } from '$lib/api/types';
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
