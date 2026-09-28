// The farm notes card's words for the shared notes list (WP-2.7, WP-2.5):
// NotesList takes its words as a prop so the workspace, which shares it,
// never loads the catalogue (lib/components/notes/words.ts). Call it where it
// renders, so a language switch re-words the list.
import type { NotesWords } from '$lib/components/notes/words';
import { errorText } from '$lib/i18n/apiError';
import { t } from '$lib/i18n/locale.svelte';

export function farmNotesWords(): NotesWords {
	return {
		// i18n-section: farm.notes
		loadFailed: (reason) => t('Couldn’t load the notes. {reason}', { reason }),
		loading: t('Loading notes…'),
		list: t('Notes'),
		editLabel: t('Edit note'),
		save: t('Save'),
		cancel: t('Cancel'),
		you: t('You'),
		formerMember: t('A former member'),
		edited: t('edited'),
		editedAt: (date) => t('Edited {date}', { date }),
		edit: t('Edit'),
		delete: t('Delete'),
		noteFrom: (date) => ` ${t('note from {date}', { date })}`,
		confirmDelete: (n) => (n.mine ? t('Delete your note? It is hidden from everyone; the WUA’s editors keep it in the record of changes.') : t('Delete {author}’s note? It is hidden from everyone; the WUA’s editors keep it in the record of changes.', { author: n.author ?? t('A former member') })),
		add: t('Add a note'),
		plainText: t('Plain text.'),
		farmerAudience: t('Read by the WUA and anyone else linked to this hydrological unit.'),
		submit: t('Add note'),
		saving: t('Saving…'),
		writeFirst: t('Write something first.'),
		tooLong: (length, max) => t('Too long: {length} of {max} characters.', { length, max }),
		error: errorText
	};
}
