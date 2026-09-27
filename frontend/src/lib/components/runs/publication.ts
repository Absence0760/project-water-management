// The Runs tab's publication panel (WP-2.3, docs/ui.md § Publishing a run):
// pure helpers for its wording and the notice form. The panel is
// PublicationPanel.svelte.
import type { Publication, PublicationMeta, PublicationRestriction, RunMeta } from '$lib/api/types';
import { LANGUAGES, LOCALES, type Locale, type NoticeText, type RestrictionLevel } from '@water-management/engine';
import { PUBLICATION_TEXT_MAX } from '$lib/api/types';

export const LEVEL_LABEL: Record<RestrictionLevel, string> = {
	none: 'No restriction',
	advisory: 'Advisory',
	restricted: 'Restricted'
};

/** Farm dams whose stop level is 0 %: the farm view can't say how much of their water is usable (design §3 Q3, F13). */
export function damsWithoutStopLevel(nodes: readonly { kind?: string; damCapacityM3?: number; damMinPct?: number }[] | undefined): number {
	return (nodes ?? []).filter((n) => n.kind === 'farm' && (n.damCapacityM3 ?? 0) > 0 && !((n.damMinPct ?? 0) > 0)).length;
}

/** Why this run can't be published, or null. The server refuses the same (audit H1). */
export function publishBlocker(run: Pick<RunMeta, 'legacy'>): string | null {
	return run.legacy ? 'This run used the legacy runoff model (a workbook comparison), so it can’t be published. Engine 1.0.0 removed that model: run the project again (a new run uses GR4J) and publish that run.' : null;
}

/** The runs any publication in the history holds: the server keeps them (409 on delete). */
export function publishedRunIds(history: readonly Pick<PublicationMeta, 'runId'>[] | undefined): Set<string> {
	return new Set((history ?? []).map((h) => h.runId));
}

/** "Advisory · 10 %", "Restricted", "No restriction". */
export function restrictionSummary(r: Pick<PublicationRestriction, 'level' | 'pct'>): string {
	return r.level !== 'none' && r.pct !== null ? `${LEVEL_LABEL[r.level]} · ${r.pct} %` : LEVEL_LABEL[r.level];
}

/** The notice form's raw fields, as the inputs hold them. */
export interface NoticeDraft {
	level: RestrictionLevel;
	pct: string;
	/** One text per language of the table, by code ('' when not written). */
	notice: Record<Locale, string>;
	nextExpectedOn: string;
}

/**
 * The notice's text fields: one per language of the table, English first
 * (LANGUAGES' order), each labelled with the language's own name. The panel
 * marks each textarea with `lang={code}`, so the browser spell-checks and
 * reads it in that language.
 */
export function noticeTextFields(): { code: Locale; label: string }[] {
	return LANGUAGES.map((l) => ({ code: l.code, label: `Notice in ${l.name}` }));
}

/** The languages the WUA wrote the notice in, in table order, with their own names. */
export function noticeLanguages(notice: NoticeText): { code: Locale; name: string; text: string }[] {
	return LANGUAGES.flatMap((l) => {
		const text = notice[l.code];
		return text ? [{ code: l.code, name: l.name, text }] : [];
	});
}

const emptyNotice = () => Object.fromEntries(LOCALES.map((code) => [code, ''])) as Record<Locale, string>;

export const emptyDraft = (): NoticeDraft => ({ level: 'none', pct: '', notice: emptyNotice(), nextExpectedOn: '' });

export function draftFrom(p: Pick<Publication, 'restriction' | 'nextExpectedOn'> | null): NoticeDraft {
	if (!p) return emptyDraft();
	const notice = emptyNotice();
	for (const code of LOCALES) notice[code] = p.restriction.notice[code] ?? '';
	return {
		level: p.restriction.level,
		pct: p.restriction.pct === null ? '' : String(p.restriction.pct),
		notice,
		nextExpectedOn: p.nextExpectedOn ?? ''
	};
}

/**
 * The draft as the API takes it, or the first thing wrong with it. The
 * percentage is optional (0–100) and only with a restriction; an empty
 * notice is none in that language; the next date is optional.
 */
export function parseDraft(d: NoticeDraft): { ok: true; restriction: PublicationRestriction; nextExpectedOn: string | null } | { ok: false; error: string } {
	const pctText = d.pct.trim().replace(',', '.');
	let pct: number | null = null;
	if (pctText) {
		if (d.level === 'none') return { ok: false, error: 'A percentage goes with an advisory or a restriction, not with “No restriction”.' };
		pct = Number(pctText);
		if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: 'The percentage must be a number from 0 to 100.' };
	}
	const notice: NoticeText = {};
	for (const l of LANGUAGES) {
		const text = (d.notice[l.code] ?? '').trim();
		if (text.length > PUBLICATION_TEXT_MAX) return { ok: false, error: `The ${l.name} notice is ${text.length} characters; the most is ${PUBLICATION_TEXT_MAX}.` };
		if (text) notice[l.code] = text;
	}
	const next = d.nextExpectedOn.trim();
	if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next)) return { ok: false, error: 'The next update date must be a date.' };
	return { ok: true, restriction: { level: d.level, pct, notice }, nextExpectedOn: next || null };
}
