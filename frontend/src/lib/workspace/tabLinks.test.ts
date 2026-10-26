import { describe, expect, it } from 'vitest';
import { carriedRun, pickOf, RUN_TABS, tabHref } from './tabLinks';

const runs = [{ id: 'new' }, { id: 'mid', published: true }, { id: 'old' }];

describe('carriedRun', () => {
	it('carries a run picked that is not the default', () => {
		expect(carriedRun('old', runs, 'editor')).toBe('old');
		expect(carriedRun('new', runs, 'viewer')).toBe('new');
	});

	it('carries nothing for the default (the newest; a viewer’s published baseline), so a run made since still wins', () => {
		expect(carriedRun('new', runs, 'editor')).toBeNull();
		expect(carriedRun('mid', runs, 'viewer')).toBeNull();
	});

	it('carries nothing without a pick, before the runs are in, or for a run that is gone', () => {
		expect(carriedRun(null, runs, 'editor')).toBeNull();
		expect(carriedRun('old', null, 'editor')).toBeNull();
		expect(carriedRun('deleted', runs, 'editor')).toBeNull();
	});
});

describe('tabHref', () => {
	it('is the project’s own path for the Summary and ?tab= for the rest', () => {
		expect(tabHref('overview', '/projects/p', 'old')).toBe('/projects/p');
		expect(tabHref('settings', '/projects/p', 'old')).toBe('?tab=settings');
		expect(tabHref('series', '/projects/p', null)).toBe('?tab=series');
	});

	it('keeps the picked run on every tab that shows one', () => {
		for (const id of RUN_TABS) expect(tabHref(id, '/projects/p', 'old')).toBe(`?tab=${id}&run=old`);
		expect(tabHref('runs', '/projects/p', null)).toBe('?tab=runs');
	});
});

describe('pickOf', () => {
	it('keeps no pick for the default a tab writes on opening, so a run made later still opens first', () => {
		// Runs opened while A was the newest: ?run=A written in place, not a pick.
		expect(pickOf('a', [{ id: 'a' }], 'editor')).toBeNull();
		// B made since: the sidebar carries nothing, and Runs opens on B.
		expect(carriedRun(pickOf('a', [{ id: 'a' }], 'editor'), [{ id: 'b' }, { id: 'a' }], 'editor')).toBeNull();
	});

	it('keeps a run that is not the default, which the links then carry past a newer run', () => {
		expect(pickOf('old', runs, 'editor')).toBe('old');
		expect(carriedRun(pickOf('old', runs, 'editor'), [{ id: 'newer' }, ...runs], 'editor')).toBe('old');
	});
});
