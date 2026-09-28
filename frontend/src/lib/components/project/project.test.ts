import { describe, expect, it } from 'vitest';
import { PROJECT_ANCHORS, projectAnchor, projectHref } from './links';
import { projectContext } from './project';

describe('projectContext', () => {
	// Noon UTC, so the viewer's calendar day is the same under any TZ the tests run in.
	const createdAt = '2026-09-03T12:00:00Z';

	it('names the team, the day it was created and the time zone', () => {
		expect(projectContext({ team: { name: 'North WUA' }, createdAt, timeZone: 'UTC' })).toBe('Team “North WUA” · created 3 Sep 2026 · time zone UTC');
	});

	it('says personal without a team, and a team project when the team has no name for you', () => {
		expect(projectContext({ team: null, createdAt, timeZone: 'UTC' })).toBe('Personal project · created 3 Sep 2026 · time zone UTC');
		expect(projectContext({ team: { name: null }, createdAt, timeZone: 'UTC' })).toMatch(/^A team project · /);
	});

	it('falls back to the default zone (an older API) and leaves out a missing date', () => {
		expect(projectContext({ team: null, createdAt: '' })).toBe('Personal project · time zone Africa/Johannesburg');
	});
});

describe('Project page links', () => {
	it('knows the panels that moved from the Summary, and nothing else', () => {
		for (const id of ['details-h', 'members-h', 'farmers-h', 'share-h', 'team-h', 'recent-notes-h', 'import-record-h', 'model-h']) {
			expect(projectAnchor(id)).toBe(true);
		}
		expect(PROJECT_ANCHORS).toHaveLength(8);
		expect(projectAnchor('res-ewr')).toBe(false);
		expect(projectAnchor('setup-h')).toBe(false);
		expect(projectAnchor('')).toBe(false);
	});

	it('builds ?tab=project, with the panel when given', () => {
		expect(projectHref()).toBe('?tab=project');
		expect(projectHref('members-h')).toBe('?tab=project#members-h');
	});
});
