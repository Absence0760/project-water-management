import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_ANCHORS } from './links';
import { panelLabel, projectNavGroups, sameNav } from './sections';

describe('panelLabel', () => {
	it('keeps the heading’s words, collapsing white space', () => {
		expect(panelLabel('  Shared directly\n  with ')).toBe('Shared directly with');
		expect(panelLabel('Two-step sign-in')).toBe('Two-step sign-in');
	});

	it('drops a trailing count, so the link keeps its name while the count loads', () => {
		expect(panelLabel('Farmers (3)')).toBe('Farmers');
		expect(panelLabel('Farmers (1 200)')).toBe('Farmers');
		expect(panelLabel('Farmers')).toBe('Farmers');
		// Words in brackets are part of the name.
		expect(panelLabel('Dam capacity (2 dams)')).toBe('Dam capacity (2 dams)');
	});
});

describe('projectNavGroups', () => {
	// The page is one column in this order (issue #586 R4-B), each group a column of its own.
	const PROJECT = 'The project';
	const ACCESS = 'People and access';
	const NOTES = 'Notes, facts and reports';
	const groupOf = (id: string) =>
		['details-h', 'import-record-h'].includes(id) ? PROJECT : ['recent-notes-h', 'model-h', 'project-report-schedules'].includes(id) ? NOTES : ACCESS;
	const all = (id: string) => ({ label: `Heading of ${id}`, group: groupOf(id) });

	it('lists every drawn panel in PROJECT_ANCHORS order, grouped by its column', () => {
		const groups = projectNavGroups(all);
		expect(groups.map((g) => g.label)).toEqual([PROJECT, ACCESS, NOTES]);
		expect(groups.flatMap((g) => g.sections.map((s) => s.id))).toEqual([...PROJECT_ANCHORS]);
		expect(groups[0]!.sections[0]).toEqual({ id: 'details-h', label: 'Heading of details-h' });
	});

	it('reads what the project is, then who can open it, then its notes, facts and reports (issue #586 R4-B)', () => {
		const order = [...PROJECT_ANCHORS];
		// Each group's panels sit together, so the index's groups follow the page.
		const groups = order.map(groupOf);
		expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([PROJECT, ACCESS, NOTES]);
		// Who can open it straight after the details: the team, then the members.
		expect(order.slice(0, 4)).toEqual(['details-h', 'import-record-h', 'team-h', 'members-h']);
		// The facts repeat other tabs' lines, so they come after everything the page is for (issue #176).
		expect(order.indexOf('model-h')).toBeGreaterThan(order.indexOf('licence-record'));
	});

	it('leaves out a panel this reader isn’t shown (a viewer has no share links) and one with no heading text', () => {
		const viewer = projectNavGroups((id) => (id === 'share-h' ? null : id === 'model-h' ? { label: '', group: NOTES } : all(id)));
		const ids = viewer.flatMap((g) => g.sections.map((s) => s.id));
		expect(ids).not.toContain('share-h');
		expect(ids).not.toContain('model-h');
		expect(ids).toHaveLength(PROJECT_ANCHORS.length - 2);
	});

	it('takes a panel added to the list with no other change (#586: API keys and Scheduled reports, 15 in all)', () => {
		const anchors = [...PROJECT_ANCHORS, 'new-panel-h'];
		// Drawn at the foot of the last column.
		const groups = projectNavGroups((id) => (id === 'new-panel-h' ? { label: 'New panel', group: NOTES } : all(id)), anchors);
		const ids = groups.flatMap((g) => g.sections.map((s) => s.id));
		expect(ids).toEqual(anchors);
		expect(groups.at(-1)!.sections.at(-1)).toEqual({ id: 'new-panel-h', label: 'New panel' });
	});

	it('a page with no panel drawn yet has no menu', () => {
		expect(projectNavGroups(() => null)).toEqual([]);
	});

	it('the page names its three columns as the groups, in this order', () => {
		const tab = readFileSync(new URL('./ProjectTab.svelte', import.meta.url), 'utf8');
		expect([...tab.matchAll(/data-nav-group="([^"]+)"/g)].map((m) => m[1])).toEqual([PROJECT, ACCESS, NOTES]);
	});
});

describe('sameNav', () => {
	it('tells a changed name or link from the same menu', () => {
		const a = [{ label: 'X', sections: [{ id: 'a', label: 'A' }] }];
		expect(sameNav(a, [{ label: 'X', sections: [{ id: 'a', label: 'A' }] }])).toBe(true);
		expect(sameNav(a, [{ label: 'X', sections: [{ id: 'a', label: 'B' }] }])).toBe(false);
		expect(sameNav(a, [])).toBe(false);
	});
});
