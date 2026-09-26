// Every word on the public /share page (roadmap WP-2.3 phase 2, docs/ui.md §
// Share page), as pure functions of POST /share/view's answer. The page only
// lays these out; share.test.ts pins them.
//
// The page is for people outside the project (a catchment forum, a
// municipality): the catchment-level result only, in the farmer view's plain
// words, with no farm named anywhere (the API sends none).
//
// The words come from the message catalogue ($lib/i18n, WP-2.5): the share.*
// keys, and the farm view's for what the two pages say alike (the notice
// card, the level words, counted nouns). Call these where they render, so a
// language switch re-words them.
import type { SharedCatchmentView, ShareView } from '$lib/api/types';
import { count, fmtDay, fmtPct, fmtStampDay } from '$lib/components/farm/format';
import { pickNotice, splitNotice, type NoticeVm } from '$lib/components/farm/notice';
import { i18n, t, type MessageKey } from '$lib/i18n/locale.svelte';

/** A share token as we issue it: 32 bytes, base64url (backend auth/tokens.ts). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The token from the URL's fragment (`#t=…`), or null when there is none or it can't be one of ours. */
export function readShareToken(hash: string): string | null {
	const tok = new URLSearchParams(hash.replace(/^#/, '')).get('t');
	return tok && TOKEN_RE.test(tok) ? tok : null;
}

/**
 * The WUA's notice card (the farmer view's NoticeCard lays it out); null for
 * level `none`. The notice is in the reader's language (the one the page
 * resolved: this device's choice, else the browser's), or the other with a
 * line saying so, as on the farm view (design §7).
 */
export function shareNotice(view: ShareView): NoticeVm | null {
	const { restriction: r, publishedAt, publishedBy } = view.publication;
	if (r.level === 'none') return null;
	const picked = pickNotice(r, i18n.locale);
	const { title, body } = splitNotice(picked?.text ?? null);
	const label = t('farm.notice.label', { level: t(`farm.level.${r.level}` as MessageKey) });
	return {
		level: r.level,
		label: title ? label : null,
		heading: title ?? label,
		body,
		// As the farm view: the percentage alone only when the WUA gave no text to carry it.
		pctLine: !title && !body && r.pct != null ? t('farm.notice.pct', { pct: fmtPct(r.pct / 100) }) : null,
		byline: `${publishedBy ?? t('share.formerMemberByline')}, ${fmtStampDay(publishedAt)}`,
		title,
		lang: picked?.lang ?? null,
		langNote: picked && picked.lang !== i18n.locale ? t(picked.lang === 'en' ? 'farm.notice.onlyEn' : 'farm.notice.onlyAf') : null
	};
}

/** "Published by Thandi Mokoena on 12 Jan 2024. Data up to 10 Jan 2024. Next update expected around 1 Feb 2024." */
export function publishedLine(view: ShareView): string {
	const p = view.publication;
	const text = t('share.published', { name: p.publishedBy ?? t('share.formerMember'), date: fmtStampDay(p.publishedAt), until: fmtDay(p.catchmentView.dataUntil) });
	return p.nextExpectedOn ? `${text} ${t('share.next', { date: fmtDay(p.nextExpectedOn) })}` : text;
}

export type ReserveState = 'met' | 'partly' | 'missed';

export interface ReserveRow {
	/** "At the catchment outlet", "At Sandspruit weir". */
	place: string;
	state: ReserveState;
	/** "Below its reserve on 3 of the last 30 days." */
	last30: string;
	/** "12 of 104 days this season (since 1 Oct 2023)." */
	season: string;
}

/** The reserve at each EWR site, the outlet first, then the gauges (counts only, from catchment_view). */
export function reserveRows(cv: SharedCatchmentView): ReserveRow[] {
	return cv.sites.map((s) => {
		const n = s.daysNotMet.last30;
		const of = cv.last30.days;
		const days = count('farm.n.day', of);
		return {
			place: s.isOutlet || !s.name ? t('share.outlet') : t('share.at', { place: s.name }),
			state: n <= 0 ? 'met' : n >= of ? 'missed' : 'partly',
			last30: n <= 0 ? t('share.last30.kept', { days }) : n >= of ? t('share.last30.missedAll', { days }) : t('share.last30.missed', { n, days }),
			season: t('share.season', { n: s.daysNotMet.season, days: count('farm.n.day', cv.season.days), date: fmtDay(cv.season.from) })
		};
	});
}

/** "6 farms in the catchment." A count only, never which. */
export const farmsLine = (cv: SharedCatchmentView) => t('share.farms', { farms: count('farm.n.farm', cv.farmCount) });
