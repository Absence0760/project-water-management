// The farm notes card's words for the shared NotesList: from the catalogue,
// with the same shape as the workspace's English (notes/words.ts), and server
// errors worded from their code, never the server's English.
import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import { NOTE_MAX } from '$lib/api/types';
import { bodyProblem } from '$lib/components/notes/notes';
import { NOTES_EN } from '$lib/components/notes/words';
import { farmNotesWords } from './notesWords';

describe('farmNotesWords', () => {
	const w = farmNotesWords();

	it('fills every word the list uses', () => {
		expect(Object.keys(w).sort()).toEqual(Object.keys(NOTES_EN).sort());
		for (const [k, v] of Object.entries(w)) if (typeof v === 'string') expect(v, k).not.toBe('');
	});

	it('words the list from the catalogue', () => {
		expect(w.loading).toBe('Loading notes…');
		expect(w.farmerAudience).toBe('Read by the WUA and anyone else linked to this farm.');
		expect(w.noteFrom('2026-09-26 14:05')).toBe(' note from 2026-09-26 14:05');
		expect(w.confirmDelete({ mine: true, author: null })).toMatch(/^Delete your note\?/);
		expect(w.confirmDelete({ mine: false, author: 'Thandi' })).toMatch(/^Delete Thandi’s note\?/);
		expect(bodyProblem('  ', w)).toBe('Write something first.');
		expect(bodyProblem('x'.repeat(NOTE_MAX + 1), w)).toBe(`Too long: ${NOTE_MAX + 1} of ${NOTE_MAX} characters.`);
	});

	it('words a server error from its code, where the workspace shows the server’s text', () => {
		const err = new ApiError(403, 'a farmer may add notes only to their own farm, shown to the farm', undefined, 'note_farmer_own_farm');
		expect(w.error(err)).toBe('You can add notes only to your own farm.');
		expect(NOTES_EN.error(err)).toBe(err.message);
		expect(w.loadFailed(w.error(new ApiError(0, 'Could not reach the server')))).toBe(
			'Couldn’t load the notes. Couldn’t reach the server. Check your connection and try again.'
		);
	});
});
