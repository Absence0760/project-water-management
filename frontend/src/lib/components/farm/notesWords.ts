// The farm notes card's words for the shared notes list (WP-2.7, WP-2.5):
// NotesList takes its words as a prop so the workspace, which shares it,
// never loads the catalogue (lib/components/notes/words.ts). Call it where it
// renders, so a language switch re-words the list.
import type { NotesWords } from '$lib/components/notes/words';
import { errorText } from '$lib/i18n/apiError';
import { t } from '$lib/i18n/locale.svelte';

export function farmNotesWords(): NotesWords {
	return {
		loadFailed: (reason) => t('farm.notes.loadFailed', { reason }),
		loading: t('farm.notes.loading'),
		list: t('farm.notes.list'),
		editLabel: t('farm.notes.editLabel'),
		save: t('farm.notes.save'),
		cancel: t('farm.notes.cancel'),
		you: t('farm.notes.you'),
		formerMember: t('farm.notes.formerMember'),
		edited: t('farm.notes.edited'),
		editedAt: (date) => t('farm.notes.editedAt', { date }),
		edit: t('farm.notes.edit'),
		delete: t('farm.notes.delete'),
		noteFrom: (date) => ` ${t('farm.notes.noteFrom', { date })}`,
		confirmDelete: (n) => (n.mine ? t('farm.notes.confirmMine') : t('farm.notes.confirmOther', { author: n.author ?? t('farm.notes.formerMember') })),
		add: t('farm.notes.add'),
		plainText: t('farm.notes.plainText'),
		farmerAudience: t('farm.notes.audience'),
		submit: t('farm.notes.submit'),
		saving: t('common.saving'),
		writeFirst: t('farm.notes.writeFirst'),
		tooLong: (length, max) => t('farm.notes.tooLong', { length, max }),
		error: errorText
	};
}
