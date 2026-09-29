import { describe, expect, it } from 'vitest';
import { leaveQuestion, listAnd, pathChanges, unsavedDroppedBy, type UnsavedWork } from './unsaved';

const u = (s: string) => new URL(s, 'http://app.test');

describe('unsavedDroppedBy', () => {
	const model: UnsavedWork = { dirty: () => true, what: 'model edits' };
	const clean: UnsavedWork = { dirty: () => false, what: 'project details' };
	const scenario: UnsavedWork = {
		dirty: () => true,
		what: 'override edits',
		leaves: (from, to) => to.searchParams.get('tab') !== from.searchParams.get('tab')
	};
	const from = u('/projects/p1?tab=scenarios&scenario=s1');

	it('a change of page drops dirty work; clean work never counts', () => {
		expect(unsavedDroppedBy(from, u('/'), [model, clean])).toEqual([model]);
	});
	it('a tab change keeps the page-level work but drops a tab’s own', () => {
		expect(unsavedDroppedBy(from, u('/projects/p1?tab=network'), [model, scenario])).toEqual([scenario]);
		// Positive control: staying on the tab keeps both.
		expect(unsavedDroppedBy(from, u('/projects/p1?tab=scenarios&range=1y'), [model, scenario])).toEqual([]);
	});
	it('unloading (no destination) drops everything dirty', () => {
		expect(unsavedDroppedBy(from, null, [model, clean, scenario])).toEqual([model, scenario]);
	});
	it('pathChanges compares paths only', () => {
		expect(pathChanges(u('/projects/p1?tab=a'), u('/projects/p1?tab=b'))).toBe(false);
		expect(pathChanges(u('/projects/p1'), u('/projects/p2'))).toBe(true);
	});
});

describe('leaveQuestion', () => {
	it('names what is unsaved and where the navigation goes', () => {
		const q = leaveQuestion(['model edits', 'project details'], 'All projects');
		expect(q.title).toBe('Leave without saving?');
		expect(q.message).toBe('You have unsaved changes (model edits and project details). Leave and go to All projects? They will be lost.');
	});
	it('says each thing once, and "this page" when the destination is outside the app', () => {
		expect(leaveQuestion(['model edits', 'model edits'], null).message).toBe(
			'You have unsaved changes (model edits). Leave this page? They will be lost.'
		);
	});
	it('listAnd joins with commas and a final and', () => {
		expect(listAnd([])).toBe('');
		expect(listAnd(['a'])).toBe('a');
		expect(listAnd(['a', 'b', 'c'])).toBe('a, b and c');
	});
});
