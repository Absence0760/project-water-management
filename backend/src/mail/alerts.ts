// Alert emails (roadmap WP-2.13): one alert, or the daily digest of several.
// Built by the worker as the recipient, from what that recipient may read
// (alerts/send.ts), so a farmer's mail names their own farm and nothing of a
// neighbour's. Words from the mail catalogue (./i18n, the recipient's
// app_user.locale), escaped by the shared frame (templates.ts render).
//
// Every mail carries:
//   - a one-click unsubscribe: a link to the landing page (token in the
//     fragment) and the RFC 8058 headers pointing at POST /alerts/unsubscribe;
//   - "why you got this" and a link to manage alerts;
//   - the liability line: a model estimate, not an instruction (a restriction
//     notice says it is the WUA's own words instead).
import { language } from '@water-management/engine/languages';
import type { AlertKind } from '../alerts/rules.js';
import { mailT, type Locale, type MailKey, type MailTranslator } from './i18n/index.js';
import { PRODUCT, render, sitePage } from './templates.js';
import type { Mail } from './transport.js';

export type RestrictionLevel = 'none' | 'advisory' | 'restricted';

/** What one alert says: the event's figures, from the recipient's own scope. */
export type AlertFacts =
	| { kind: 'dam_below'; farm: string; pct: number; threshold: number; source: 'latest' | 'forecast'; date: string; madeOn?: string | null }
	| { kind: 'ewr_forecast_fail'; days: number; of: number; from: string; to: string; madeOn: string; threshold: number }
	| { kind: 'data_stale'; threshold: number; feeds: { label: string; newest: string; overdue: number }[] }
	| { kind: 'feed_failing'; threshold: number; feeds: { label: string; failures: number }[] }
	| { kind: 'job_dead'; count: number }
	| { kind: 'restriction_published'; level: RestrictionLevel; pct: number | null; notice: string | null; publishedAt: string; lifted: boolean };

export interface Recipient {
	email: string;
	locale: string | null;
	/** Where "Open …" goes: a farmer to their farm page, everyone else to the workspace. */
	farmer: boolean;
}

export interface Unsubscribe {
	/** The landing page (token in the fragment). */
	pageUrl: string;
	/** The RFC 8058 one-click POST address. */
	oneClickUrl: string;
}

const NBSP = ' ';

/** 0.28 → "28 %" (the farm view's rule, non-breaking space). */
export function pctText(fraction: number): string {
	if (!Number.isFinite(fraction)) return '–';
	const p = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
	return `${p}${NBSP}%`;
}

/**
 * "2026-10-03" → "3 Oct 2026", in the mail's language's Intl locale (the
 * language table's). The day is written without a leading zero, as the farm
 * view writes it (en-ZA's ICU data gives "03 Oct 2026").
 */
export function dateText(iso: string, lang: Locale): string {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return new Intl.DateTimeFormat(language(lang).intl, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
		.formatToParts(d)
		.map((p) => (p.type === 'day' ? String(Number(p.value)) : p.value))
		.join('');
}

/** One alert's words: the subject's "what", and its sentences. */
export function alertLines(f: AlertFacts, tr: MailTranslator, project: string, lang: Locale): { what: string; body: string[] } {
	switch (f.kind) {
		case 'dam_below': {
			const v = { farm: f.farm, pct: pctText(f.pct), threshold: pctText(f.threshold), date: dateText(f.date, lang), madeOn: f.madeOn ? dateText(f.madeOn, lang) : '' };
			return { what: tr.t('mail.alert.dam.what', v), body: [tr.t(f.source === 'forecast' ? 'mail.alert.dam.forecast' : 'mail.alert.dam.latest', v)] };
		}
		case 'ewr_forecast_fail':
			return {
				what: tr.t('mail.alert.ewr.what'),
				body: [
					tr.t('mail.alert.ewr.body', { madeOn: dateText(f.madeOn, lang), days: f.days, of: f.of, from: dateText(f.from, lang), to: dateText(f.to, lang), threshold: f.threshold })
				]
			};
		case 'data_stale':
			return {
				what: tr.t('mail.alert.stale.what'),
				body: [
					tr.t('mail.alert.stale.body', { threshold: f.threshold }),
					...f.feeds.map((x) => tr.t('mail.alert.stale.line', { feed: x.label, newest: dateText(x.newest, lang), overdue: x.overdue }))
				]
			};
		case 'feed_failing':
			return {
				what: tr.t('mail.alert.failing.what'),
				body: [tr.t('mail.alert.failing.body', { threshold: f.threshold }), ...f.feeds.map((x) => tr.t('mail.alert.failing.line', { feed: x.label, failures: x.failures }))]
			};
		case 'job_dead':
			return { what: tr.t('mail.alert.jobs.what'), body: [tr.t('mail.alert.jobs.body', { count: f.count })] };
		case 'restriction_published': {
			const date = dateText(f.publishedAt, lang);
			if (f.lifted) return { what: tr.t('mail.alert.restriction.liftedWhat'), body: [tr.t('mail.alert.restriction.lifted', { project, date })] };
			const level = tr.t(`mail.alert.restriction.level.${f.level}` as MailKey);
			const body = [
				f.pct === null
					? tr.t('mail.alert.restriction.body', { project, date, level })
					: tr.t('mail.alert.restriction.bodyPct', { project, date, level, pct: `${f.pct}${NBSP}%` })
			];
			if (f.notice) body.push(tr.t('mail.alert.restriction.notice', { notice: f.notice }));
			return { what: tr.t('mail.alert.restriction.what'), body };
		}
	}
}

/** The line under every alert: a model estimate (or, for a notice, the WUA's own words). */
const liability = (kind: AlertKind, tr: MailTranslator) => tr.t(kind === 'restriction_published' ? 'mail.alert.restriction.wua' : 'mail.alert.model');

function headers(u: Unsubscribe): Record<string, string> {
	return {
		'List-Unsubscribe': `<${u.oneClickUrl}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		'Auto-Submitted': 'auto-generated'
	};
}

const openAction = (tr: MailTranslator, to: Recipient, projectId: string) =>
	to.farmer
		? { label: tr.t('mail.alert.openFarm'), url: sitePage(`/farm/${projectId}`) }
		: { label: tr.t('mail.alert.openProject'), url: sitePage(`/projects/${projectId}`) };

/**
 * The translator, and the language to write dates in: the frame's sentence
 * is asked first, so a locale whose alert words aren't translated yet
 * writes its dates in English too, like its words.
 */
function translator(locale: string | null): { tr: MailTranslator; lang: Locale } {
	const tr = mailT(locale);
	tr.t('mail.alert.model');
	return { tr, lang: tr.lang };
}

/** One alert, as its own email. */
export function alertMail(to: Recipient, project: { id: string; name: string }, facts: AlertFacts, unsubscribe: Unsubscribe): Mail {
	const { tr, lang } = translator(to.locale);
	const { what, body } = alertLines(facts, tr, project.name, lang);
	const mail = render(
		to.email,
		tr.t('mail.alert.subject', { what, project: project.name }),
		{
			heading: what,
			paragraphs: [...body, liability(facts.kind, tr)],
			action: openAction(tr, to, project.id),
			footer: [tr.t('mail.alert.why', { kind: tr.t(`mail.alert.kind.${facts.kind}` as MailKey), project: project.name })],
			links: [
				{ label: tr.t('mail.alert.unsubscribe'), url: unsubscribe.pageUrl },
				{ label: tr.t('mail.alert.manage'), url: sitePage('/account/alerts') }
			]
		},
		tr
	);
	return { ...mail, headers: headers(unsubscribe) };
}

/**
 * Several alerts of one project in one email (the 06:00 digest). `more`: the
 * alerts left out past the digest's line limit (alerts/send.ts
 * DIGEST_MAX_LINES), said as "and N more" pointing at the app.
 */
export function digestMail(to: Recipient, project: { id: string; name: string }, items: AlertFacts[], unsubscribe: Unsubscribe, cap: number, more = 0): Mail {
	const { tr, lang } = translator(to.locale);
	const paragraphs = [tr.t('mail.alert.digest.intro')];
	for (const f of items) {
		const { what, body } = alertLines(f, tr, project.name, lang);
		paragraphs.push(`${what}: ${body.join(' ')}`);
	}
	if (more > 0) paragraphs.push(tr.t('mail.alert.digest.more', { more }));
	if (items.some((f) => f.kind !== 'restriction_published')) paragraphs.push(tr.t('mail.alert.model'));
	if (items.some((f) => f.kind === 'restriction_published')) paragraphs.push(tr.t('mail.alert.restriction.wua'));
	const mail = render(
		to.email,
		tr.t('mail.alert.digest.subject', { project: project.name, product: PRODUCT }),
		{
			heading: tr.t('mail.alert.digest.heading', { project: project.name }),
			paragraphs,
			action: openAction(tr, to, project.id),
			footer: [tr.t('mail.alert.digest.why', { project: project.name, cap })],
			links: [
				{ label: tr.t('mail.alert.digest.unsubscribe'), url: unsubscribe.pageUrl },
				{ label: tr.t('mail.alert.manage'), url: sitePage('/account/alerts') }
			]
		},
		tr
	);
	return { ...mail, headers: headers(unsubscribe) };
}
