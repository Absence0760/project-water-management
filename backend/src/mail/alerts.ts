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
//   - the liability line for its kind and reader (liabilityKey): a dam alert
//     says it is the model's estimate from the published figures, not a
//     measurement or an instruction (a farmer's words "your dam", "your WUA";
//     the WUA's staff get the same in the third person); an EWR forecast alert (staff only) says it comes from
//     the newest forecast run, which may not be published; a restriction
//     notice says it is the WUA's own words. The WUA's operational alerts
//     (stale or failing feeds, dead jobs) are no model figure, so they get none.
import { language } from '@water-management/engine/languages';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import type { AlertKind } from '../alerts/rules.js';
import { mailT, type Locale, type MailKey, type MailTranslator } from './i18n/index.js';
import { paraText, PRODUCT, render, sitePage, type Inline, type Para } from './templates.js';
import type { Mail } from './transport.js';

export type RestrictionLevel = 'none' | 'advisory' | 'restricted';

/** What one alert says: the event's figures, from the recipient's own scope. */
export type AlertFacts =
	| { kind: 'dam_below'; farm: string; pct: number; threshold: number; source: 'latest' | 'forecast'; date: string; madeOn?: string | null }
	| { kind: 'ewr_forecast_fail'; days: number; of: number; from: string; to: string; madeOn: string; threshold: number }
	| { kind: 'data_stale'; threshold: number; feeds: { label: string; newest: string; overdue: number }[] }
	| { kind: 'feed_failing'; threshold: number; feeds: { label: string; failures: number }[] }
	| { kind: 'job_dead'; count: number }
	| {
			kind: 'restriction_published';
			level: RestrictionLevel;
			pct: number | null;
			notice: string | null;
			/** The language the notice's words are in (pickNotice: the reader's, else English, else another); null for none. */
			noticeLang?: string | null;
			publishedAt: string;
			lifted: boolean;
	  };

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

/** The catchment a mail is about; `timeZone` (project.time_zone, 058) dates its timestamps. */
export interface MailProject {
	id: string;
	name: string;
	timeZone?: string;
}

/**
 * The WUA's restriction percentage (0–100, run_publication.restriction_pct,
 * numeric(5,2)) as the farm page writes it (fmtPct of pct ÷ 100): a whole
 * percentage, "<1 %" / ">99 %" at the ends, so never "12.5 %" with an
 * English decimal point in an Afrikaans mail, and the same figure as the
 * page (issue #51).
 */
export function cutPctText(pct: number): string {
	if (!Number.isFinite(pct)) return '–';
	if (pct <= 0) return `0${NBSP}%`;
	if (pct >= 100) return `100${NBSP}%`;
	const p = Math.round(pct);
	if (p < 1) return `<1${NBSP}%`;
	if (p > 99) return `>99${NBSP}%`;
	return `${p}${NBSP}%`;
}

/**
 * "2026-10-03" → "3 Oct 2026", in the mail's language's Intl locale (the
 * language table's). The day is written without a leading zero, as the farm
 * view writes it (en-ZA's ICU data gives "03 Oct 2026"). A timestamp
 * ("2026-10-01T23:00:00Z", a notice's published_at) is dated by the day it
 * was in the catchment's time zone, never UTC's (01:00 on the 2nd in South
 * Africa is the 2nd; issue #51); a calendar day is written as it is.
 */
export function dateText(iso: string, lang: Locale, timeZone: string = DEFAULT_TIME_ZONE): string {
	const stamp = iso.length > 10 ? new Date(iso) : null;
	const day = stamp && !Number.isNaN(stamp.getTime()) ? localDate(stamp, timeZone) : iso.slice(0, 10);
	const d = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return new Intl.DateTimeFormat(language(lang).intl, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
		.formatToParts(d)
		.map((p) => (p.type === 'day' ? String(Number(p.value)) : p.value))
		.join('');
}

/**
 * "The WUA's notice: “…”", with the WUA's words marked as their own
 * language when it isn't the mail's (issue #51, WCAG 3.1.2): an English
 * notice in an Afrikaans mail is read out in English.
 */
function noticeLine(tr: MailTranslator, notice: string, noticeLang: string | null, lang: Locale): Para {
	if (!noticeLang || noticeLang === lang) return tr.t('mail.alert.restriction.notice', { notice });
	const MARK = '\u0001';
	const [before = '', after = ''] = tr.t('mail.alert.restriction.notice', { notice: MARK }).split(MARK);
	return [before, { text: notice, lang: noticeLang }, after].filter((x) => x !== '');
}

/** One alert's words: the subject's "what", and its sentences. */
export function alertLines(f: AlertFacts, tr: MailTranslator, project: string, lang: Locale, timeZone: string = DEFAULT_TIME_ZONE): { what: string; body: Para[] } {
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
					tr.tn('mail.alert.stale.body', f.threshold, { threshold: f.threshold }),
					...f.feeds.map((x) => tr.tn('mail.alert.stale.line', x.overdue, { feed: x.label, newest: dateText(x.newest, lang), overdue: x.overdue }))
				]
			};
		case 'feed_failing':
			return {
				what: tr.t('mail.alert.failing.what'),
				body: [tr.t('mail.alert.failing.body', { threshold: f.threshold }), ...f.feeds.map((x) => tr.tn('mail.alert.failing.line', x.failures, { feed: x.label, failures: x.failures }))]
			};
		case 'job_dead':
			return { what: tr.t('mail.alert.jobs.what'), body: [tr.tn('mail.alert.jobs.body', f.count, { count: f.count })] };
		case 'restriction_published': {
			const date = dateText(f.publishedAt, lang, timeZone);
			if (f.lifted) return { what: tr.t('mail.alert.restriction.liftedWhat'), body: [tr.t('mail.alert.restriction.lifted', { project, date })] };
			const level = tr.t(`mail.alert.restriction.level.${f.level}` as MailKey);
			const body: Para[] = [
				f.pct === null
					? tr.t('mail.alert.restriction.body', { project, date, level })
					: tr.t('mail.alert.restriction.bodyPct', { project, date, level, pct: cutPctText(f.pct) })
			];
			if (f.notice) body.push(noticeLine(tr, f.notice, f.noticeLang ?? null, lang));
			return { what: tr.t('mail.alert.restriction.what'), body };
		}
	}
}

/**
 * The liability line under an alert of `kind` sent to a farmer or not, or
 * null for none. dam_below reads the current publication
 * (alerts/evaluate.ts), so "the figures your WUA published" is true of it;
 * a farmer reads it about their own dam, the WUA's staff about a member's
 * (mail.alert.model.dam.staff). ewr_forecast_fail reads the newest forecast
 * run, published or not, and reaches only the WUA's staff (051 fan-out).
 */
export function liabilityKey(kind: AlertKind, farmer: boolean): MailKey | null {
	switch (kind) {
		case 'dam_below':
			return farmer ? 'mail.alert.model' : 'mail.alert.model.dam.staff';
		case 'ewr_forecast_fail':
			return 'mail.alert.model.staff';
		case 'restriction_published':
			return 'mail.alert.restriction.wua';
		case 'data_stale':
		case 'feed_failing':
		case 'job_dead':
			return null;
	}
}

const LIABILITY_ORDER = ['mail.alert.model', 'mail.alert.model.dam.staff', 'mail.alert.model.staff', 'mail.alert.restriction.wua'] as const;

/** The liability lines for a set of alerts to one reader: each distinct one once, in a fixed order. */
function liabilityLines(kinds: AlertKind[], farmer: boolean, tr: MailTranslator): string[] {
	const keys = new Set(kinds.map((k) => liabilityKey(k, farmer)).filter((k): k is MailKey => k !== null));
	return LIABILITY_ORDER.filter((k) => keys.has(k)).map((k) => tr.t(k));
}

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
export function alertMail(to: Recipient, project: MailProject, facts: AlertFacts, unsubscribe: Unsubscribe): Mail {
	const { tr, lang } = translator(to.locale);
	const { what, body } = alertLines(facts, tr, project.name, lang, project.timeZone);
	const mail = render(
		'alert',
		to.email,
		tr.t('mail.alert.subject', { what, project: project.name }),
		{
			heading: what,
			paragraphs: [...body, ...liabilityLines([facts.kind], to.farmer, tr)],
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
export function digestMail(to: Recipient, project: MailProject, items: AlertFacts[], unsubscribe: Unsubscribe, cap: number, more = 0): Mail {
	const { tr, lang } = translator(to.locale);
	const paragraphs: Para[] = [tr.t('mail.alert.digest.intro')];
	for (const f of items) {
		const { what, body } = alertLines(f, tr, project.name, lang, project.timeZone);
		// One line per alert, each paragraph's runs kept (a notice keeps its lang).
		const line: Inline[] = [`${what}: `];
		body.forEach((p, i) => line.push(...(i ? [' '] : []), ...(typeof p === 'string' ? [p] : p)));
		paragraphs.push(line.every((x) => typeof x === 'string') ? paraText(line) : line);
	}
	if (more > 0) paragraphs.push(tr.tn('mail.alert.digest.more', more, { more }));
	paragraphs.push(...liabilityLines(items.map((f) => f.kind), to.farmer, tr));
	const mail = render(
		'alert_digest',
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
