// Helpers for a run's written explanation (RunMeta.notes, 007_run_notes).
import type { Wr2012FlagLevel } from '@water-management/engine';

/** The note as the server stores it: trimmed at both ends. */
export const normaliseNotes = (s: string) => s.trim();

/** True when the draft would change the stored note. */
export const notesDirty = (draft: string, saved: string | undefined) => normaliseNotes(draft) !== (saved ?? '');

/**
 * What to ask for when a WR2012 flag needs the modeller's reason and the run
 * has none yet (an assessor reads a query or not-usable flag next to it), or
 * null when nothing is missing.
 */
export function explanationPrompt(level: Wr2012FlagLevel | null | undefined, notes: string | undefined): string | null {
	if (notes?.trim()) return null;
	if (level === 'query') return 'The WR2012 check queries this run. Say why the difference stands, so a reviewer reads it next to the flag.';
	if (level === 'unusable') return 'The WR2012 check marks this run not usable for EWR findings until it is explained. Say why the difference stands.';
	return null;
}

/**
 * The note's first line for the run header, cut at a word near `max`
 * characters with an ellipsis; null without a note. The whole note sits in
 * the Record group, which the header links to.
 */
export function notesPreview(notes: string | undefined, max = 140): string | null {
	const first = normaliseNotes(notes ?? '').split(/\r?\n/)[0]!.trim();
	if (!first) return null;
	const more = first.length > max || normaliseNotes(notes ?? '').includes('\n');
	if (first.length <= max) return more ? `${first} …` : first;
	const cut = first.slice(0, max);
	const at = cut.lastIndexOf(' ');
	return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()} …`;
}
