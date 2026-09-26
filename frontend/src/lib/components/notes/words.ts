// The words of a notes list that a farmer can see (WP-2.7, WP-2.5; docs/ui.md
// § Notes). NotesList is shared by the workspace, which is English and never
// loads the message catalogue, and the farm view's notes card, which is
// translated: so the list takes its words as a prop. The workspace uses
// NOTES_EN (below); the farm card passes the catalogue's
// (lib/components/farm/notesWords.ts). This module imports no catalogue
// (lib/i18n/boundary.test.ts).
//
// Only what a farmer's copy shows is here. The workspace-only parts (the
// "shown to the farm" badge and checkbox, the team audience lines) stay in
// NotesList in English.
import type { Note } from '$lib/api/types';

export interface NotesWords {
	/** "Couldn’t load the notes: …", with the reason already worded. */
	loadFailed: (reason: string) => string;
	loading: string;
	/** The list's accessible name. */
	list: string;
	editLabel: string;
	save: string;
	cancel: string;
	you: string;
	formerMember: string;
	edited: string;
	editedAt: (date: string) => string;
	edit: string;
	delete: string;
	/** Visually hidden after Edit / Delete: " note from 2026-09-26 14:05". */
	noteFrom: (date: string) => string;
	confirmDelete: (n: Pick<Note, 'mine' | 'author'>) => string;
	add: string;
	plainText: string;
	/** Who reads a farmer's note (the farm view's audience line). */
	farmerAudience: string;
	submit: string;
	saving: string;
	writeFirst: string;
	tooLong: (length: number, max: number) => string;
	/** An API failure as the reader should see it. */
	error: (err: unknown) => string;
}

/** The workspace's words (English; the workspace isn't translated). */
export const NOTES_EN: NotesWords = {
	loadFailed: (reason) => `Couldn’t load the notes: ${reason}`,
	loading: 'Loading notes…',
	list: 'Notes',
	editLabel: 'Edit note',
	save: 'Save',
	cancel: 'Cancel',
	you: 'You',
	formerMember: 'A former member',
	edited: 'edited',
	editedAt: (date) => `Edited ${date}`,
	edit: 'Edit',
	delete: 'Delete',
	noteFrom: (date) => ` note from ${date}`,
	confirmDelete: (n) => `Delete ${n.mine ? 'your note' : `${n.author ?? 'this person'}’s note`}? It is hidden from everyone; editors keep it in the audit trail.`,
	add: 'Add a note',
	plainText: 'Plain text.',
	farmerAudience: 'Read by the WUA and anyone else linked to this farm.',
	submit: 'Add note',
	saving: 'Saving…',
	writeFirst: 'Write something first.',
	tooLong: (length, max) => `Too long: ${length} of ${max} characters.`,
	error: (err) => (err instanceof Error ? err.message : String(err))
};
