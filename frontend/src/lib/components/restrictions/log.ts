// The Restriction log page (?tab=restrictions, docs/ui.md § Restriction log):
// pure helpers for its wording. The page is RestrictionLogTab.svelte, each
// decision RestrictionLogList.svelte; the decisions come from GET
// …/restriction-log (backend publish/restrictionLog.ts).
import type { RestrictionDecision } from '#lib/api/types.js';
import { fmtDate, fmtDay } from '#lib/format/number.js';
import { FORMER_MEMBER } from '#lib/format/maker.js';
import { LEVEL_LABEL, noticeLanguages } from '#lib/components/runs/publication.js';

/** "Restricted · 25 %", "Advisory", "No restriction"; "Level not recorded" for a level the app doesn't know. */
export function levelText(r: RestrictionDecision['restriction']): string {
	if (!r.level) return 'Level not recorded';
	return r.level !== 'none' && r.pct !== null ? `${LEVEL_LABEL[r.level]} · ${r.pct} %` : LEVEL_LABEL[r.level];
}

/** The level's tone, for the pill's colour; the words say it too. */
export function levelTone(r: RestrictionDecision['restriction']): 'none' | 'advisory' | 'restricted' | 'unknown' {
	return r.level ?? 'unknown';
}

const FIELD_WORDS: Record<string, string> = { restriction: 'restriction', nextExpectedOn: 'next publication date', note: 'note' };

/** What the decision was: "Published a run", "Published an automatic run", "Changed the restriction and next publication date". */
export function decisionTitle(d: RestrictionDecision): string {
	if (d.kind === 'published') return d.auto ? 'Published an automatic run' : 'Published a run';
	const fields = (d.fields ?? []).map((f) => FIELD_WORDS[f] ?? f);
	if (!fields.length) return 'Changed the notice';
	return `Changed the ${fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`}`;
}

/** Who made it: their name then; an auto run's own publish when no one is named; else a former member. */
export function decisionBy(d: RestrictionDecision): string {
	if (d.by) return d.by;
	return d.auto ? 'the automatic run' : FORMER_MEMBER;
}

/**
 * The decision in force: the newest one of the current publication (the list
 * is newest first, so the first one marked current). Its notice is the one
 * farmers read now.
 */
export function inForceId(items: readonly RestrictionDecision[]): string | null {
	return items.find((d) => d.current)?.id ?? null;
}

/** The section header's line: what is in force and since when, or that nothing is published. */
export function logContext(items: readonly RestrictionDecision[] | null): string {
	if (!items) return 'Every restriction published to farmers, and every change to its notice';
	if (!items.length) return 'Nothing published yet';
	const id = inForceId(items);
	const d = items.find((x) => x.id === id);
	if (!d) return `Latest decision ${fmtDate(items[0]!.at)}: ${levelText(items[0]!.restriction)}`;
	return `In force: ${levelText(d.restriction)}, since ${fmtDate(d.at)} by ${decisionBy(d)}`;
}

/** The decision's facts, one line each: the season its figures cover, the units it went to, the next date. */
export function decisionFacts(d: RestrictionDecision): string[] {
	const lines: string[] = [];
	if (d.season) {
		const until = d.season.dataUntil && d.season.dataUntil !== d.season.to ? `, data to ${fmtDay(d.season.dataUntil)}` : '';
		lines.push(`Season ${fmtDay(d.season.from)} to ${fmtDay(d.season.to)}${until}`);
	}
	if (d.farms !== null) lines.push(d.farms === 1 ? 'Sent to 1 hydrological unit' : `Sent to ${d.farms} hydrological units`);
	if (d.nextExpectedOn !== undefined) lines.push(d.nextExpectedOn ? `Next publication expected ${fmtDay(d.nextExpectedOn)}` : 'No next publication date');
	return lines;
}

/** The notice in each language it was written in, table order; null when the decision kept no text (older than the decision log). */
export function decisionNotices(d: RestrictionDecision): { code: string; name: string; text: string }[] | null {
	return d.restriction.notice ? noticeLanguages(d.restriction.notice) : null;
}

/** The run's Publication panel on Runs & results, or null once the run is no longer kept. */
export function runHref(d: RestrictionDecision): string | null {
	return d.runKept && d.runId ? `?tab=runs&run=${encodeURIComponent(d.runId)}#res-publication` : null;
}

/** A run's id in short, as the runs list names an unlabelled run's id: its first 8 characters. */
export const shortId = (id: string): string => id.slice(0, 8);

/**
 * The printed page's line under the heading (print only): what the paper holds. With older decisions not loaded,
 * it says the paper stops there and the CSV holds the whole log.
 */
export function printedNote(shown: number, more: boolean, printedAt: Date = new Date()): string {
	const what = shown === 1 ? '1 decision' : `${shown} decisions`;
	const when = `Printed ${fmtDate(printedAt.toISOString(), true)}: ${what}, newest first.`;
	return more ? `${when} Older decisions weren’t loaded: Download CSV holds the whole log.` : when;
}
