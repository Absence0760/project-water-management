import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_ANCHORS, projectAnchor, projectHref } from './links';
import { byName, foldRows, PEOPLE_SHOWN, projectContext } from './project';

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
	it('knows every panel, and nothing else', () => {
		for (const id of ['details-h', 'members-h', 'farmers-h', 'share-h', 'team-h', 'recent-notes-h', 'import-record-h', 'model-h', 'licence-record', 'project-api-keys', 'project-report-schedules']) {
			expect(projectAnchor(id)).toBe(true);
		}
		expect(projectAnchor('res-ewr')).toBe(false);
		expect(projectAnchor('setup-h')).toBe(false);
		// The panels' old Settings ids are Settings' to forward, not this page's.
		expect(projectAnchor('set-api-keys')).toBe(false);
		expect(projectAnchor('set-report-schedules')).toBe(false);
		expect(projectAnchor('')).toBe(false);
	});

	it('lists every panel heading the page draws, in page order (a link to one lands on it, issue #586)', () => {
		// The page's panels, in the order ProjectTab draws them, and each one's h2 id read from its source;
		// a lazy panel (API keys, Scheduled reports) by its wrapper's id, which is on the page while its chunk loads.
		const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
		const tab = src('./ProjectTab.svelte');
		const own = [...tab.matchAll(/<(?:h2|div) id="([^"]+)"/g)].map((m) => [tab.indexOf(m[0]), m[1]!] as const);
		const panels = [...tab.matchAll(/<(\w+Panel|RecentNotes) /g)].map((m) => {
			const file = m[1] === 'RecentNotes' ? '../notes/RecentNotes.svelte' : `./${m[1]}.svelte`;
			const id = /<h2 id="([^"]+)"/.exec(src(file))?.[1];
			expect(id, file).toBeDefined();
			return [m.index!, id!] as const;
		});
		const drawn = [...own, ...panels].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
		expect([...PROJECT_ANCHORS]).toEqual(drawn);
	});

	it('the licence record email links a panel the page lands on', () => {
		const mail = readFileSync(new URL('../../../../../backend/src/mail/templates.ts', import.meta.url), 'utf8');
		const ids = [...mail.matchAll(/tab=project#([\w-]+)/g)].map((m) => m[1]);
		expect(ids).toContain('licence-record');
		for (const id of ids) expect(projectAnchor(id!), id).toBe(true);
	});

	it('builds ?tab=project, with the panel when given', () => {
		expect(projectHref()).toBe('?tab=project');
		expect(projectHref('members-h')).toBe('?tab=project#members-h');
	});
});

describe('foldRows', () => {
	const rows = Array.from({ length: 30 }, (_, i) => i);
	it('shows the first few and counts the rest', () => {
		expect(foldRows(rows, false, PEOPLE_SHOWN)).toEqual({ shown: rows.slice(0, 8), hidden: 22 });
	});
	it('shows everything once opened', () => {
		expect(foldRows(rows, true, PEOPLE_SHOWN)).toEqual({ shown: rows, hidden: 0 });
	});
	it('never folds away a single row', () => {
		expect(foldRows(rows.slice(0, 9), false, 8)).toEqual({ shown: rows.slice(0, 9), hidden: 0 });
		expect(foldRows(rows.slice(0, 10), false, 8).hidden).toBe(2);
	});
	it('keeps a row asked for past the fold (the reader’s own), in its place', () => {
		expect(foldRows(rows, false, 8, (r) => r === 20)).toEqual({ shown: [...rows.slice(0, 8), 20], hidden: 21 });
	});
});

describe('byName', () => {
	const p = (displayName: string, role = 'viewer') => ({ displayName, role });
	it('counts numbers in names as a reader does', () => {
		expect(byName([p('Farmer 10'), p('Farmer 2'), p('farmer 1'), p('Anna')]).map((r) => r.displayName)).toEqual(['Anna', 'farmer 1', 'Farmer 2', 'Farmer 10']);
	});
	it('keeps the server’s groups in their order, sorting only within each', () => {
		const rows = [p('Zed', 'owner'), p('Hydrologist 10', 'editor'), p('Hydrologist 2', 'editor'), p('Bea', 'viewer'), p('Al', 'viewer')];
		expect(byName(rows, (r) => r.role).map((r) => r.displayName)).toEqual(['Zed', 'Hydrologist 2', 'Hydrologist 10', 'Al', 'Bea']);
	});
});
