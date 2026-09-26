// Every word on the public /share page (roadmap WP-2.3 phase 2, docs/ui.md §
// Share page), as pure functions of POST /share/view's answer. The page only
// lays these out; share.test.ts pins them.
//
// The page is for people outside the project (a catchment forum, a
// municipality): the catchment-level result only, in the farmer view's plain
// words, with no farm named anywhere (the API sends none).
//
// The share page isn't in the message catalogue yet (WP-2.5 translated the
// signed-in farmer surfaces; docs/followups.md § Afrikaans), so its words are
// English here rather than borrowed from the farm view's catalogue keys.
import type { PublicationRestriction, SharedCatchmentView, ShareView } from '$lib/api/types';
import { splitNotice, type NoticeVm } from '$lib/components/farm/cards';
import { fmtDay, fmtPct, fmtStampDay, NBSP } from '$lib/components/farm/format';

const LEVEL_WORD: Record<PublicationRestriction['level'], string> = { none: 'No restriction', advisory: 'Advisory', restricted: 'Restriction' };

/** "1 day", "3 farms". */
const plural = (n: number, one: string) => `${n}${NBSP}${n === 1 ? one : `${one}s`}`;

/** A share token as we issue it: 32 bytes, base64url (backend auth/tokens.ts). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The token from the URL's fragment (`#t=…`), or null when there is none or it can't be one of ours. */
export function readShareToken(hash: string): string | null {
	const t = new URLSearchParams(hash.replace(/^#/, '')).get('t');
	return t && TOKEN_RE.test(t) ? t : null;
}

export const DEAD_LINK = 'This link has expired or was withdrawn. Ask whoever sent it for a new one.';
export const NO_LINK = 'This page needs the whole link. Open the link you were sent again, or ask whoever sent it for a new one.';
export const LOAD_FAILED = 'Couldn’t load this just now. Check your connection and try again.';
export const NO_CHART = 'The flow chart isn’t shown for this catchment: with so few farms, the river’s flows could reveal a farm’s water use.';
export const ABOUT =
	'This is the catchment’s published result from its water balance model: whether the river kept its ecological reserve (the flow it needs to stay healthy) and the Water User Association’s notice. It is read-only, and it shows no farm’s figures.';

/**
 * Afrikaans when the browser prefers it: the first of its languages that is
 * English or Afrikaans is Afrikaans. Anything else reads English.
 */
export function prefersAfrikaans(languages: readonly string[]): boolean {
	for (const l of languages) {
		const primary = l.toLowerCase().split('-')[0];
		if (primary === 'af') return true;
		if (primary === 'en') return false;
	}
	return false;
}

/** The notice in the reader's language, or in the other one when theirs isn't written; null without one. */
export function pickNotice(r: PublicationRestriction, languages: readonly string[]): { text: string; lang: 'en' | 'af' } | null {
	const af = r.noticeAf?.trim() ? r.noticeAf : null;
	const en = r.noticeEn?.trim() ? r.noticeEn : null;
	if (prefersAfrikaans(languages) && af) return { text: af, lang: 'af' };
	if (en) return { text: en, lang: 'en' };
	if (af) return { text: af, lang: 'af' };
	return null;
}

/** The WUA's notice card (the farmer view's NoticeCard lays it out); null for level `none`. */
export function shareNotice(view: ShareView, languages: readonly string[]): (NoticeVm & { lang: 'en' | 'af' | null }) | null {
	const { restriction: r, publishedAt, publishedBy } = view.publication;
	if (r.level === 'none') return null;
	const picked = pickNotice(r, languages);
	const { title, body } = splitNotice(picked?.text ?? null);
	const label = `Notice from the WUA · ${LEVEL_WORD[r.level]}`;
	return {
		level: r.level,
		label: title ? label : null,
		heading: title ?? label,
		body,
		// As the farm view: the percentage alone only when the WUA gave no text to carry it.
		pctLine: !title && !body && r.pct != null ? `Set by the WUA: ${fmtPct(r.pct / 100)} of registered use.` : null,
		byline: `${publishedBy ?? 'A former member'}, ${fmtStampDay(publishedAt)}`,
		title,
		lang: picked?.lang ?? null
	};
}

/** "Published by Thandi Mokoena on 12 Jan 2024. Data up to 10 Jan 2024. Next update expected around 1 Feb 2024." */
export function publishedLine(view: ShareView): string {
	const p = view.publication;
	let text = `Published by ${p.publishedBy ?? 'a former member'} on ${fmtStampDay(p.publishedAt)}. Data up to ${fmtDay(p.catchmentView.dataUntil)}.`;
	if (p.nextExpectedOn) text += ` Next update expected around ${fmtDay(p.nextExpectedOn)}.`;
	return text;
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

function daysLine(n: number, of: number, span: string): string {
	if (n <= 0) return `Kept its reserve on every one of ${span}.`;
	if (n >= of) return `Below its reserve on all of ${span}.`;
	return `Below its reserve on ${n} of ${span}.`;
}

/** The reserve at each EWR site, the outlet first, then the gauges (counts only, from catchment_view). */
export function reserveRows(cv: SharedCatchmentView): ReserveRow[] {
	return cv.sites.map((s) => {
		const n = s.daysNotMet.last30;
		const of = cv.last30.days;
		return {
			place: s.isOutlet || !s.name ? 'At the catchment outlet' : `At ${s.name}`,
			state: n <= 0 ? 'met' : n >= of ? 'missed' : 'partly',
			last30: daysLine(n, of, `the last ${plural(of, 'day')}`),
			season: `${s.daysNotMet.season} of ${plural(cv.season.days, 'day')} below it this season (since ${fmtDay(cv.season.from)}).`
		};
	});
}

/** "6 farms in the catchment." A count only, never which. */
export const farmsLine = (cv: SharedCatchmentView) => `${plural(cv.farmCount, 'farm')} in the catchment.`;
