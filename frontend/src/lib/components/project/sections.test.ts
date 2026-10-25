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
	const LEFT = 'The project';
	const RIGHT = 'People and access';
	const left = new Set(['details-h', 'import-record-h', 'recent-notes-h', 'model-h']);
	const all = (id: string) => ({ label: `Heading of ${id}`, group: left.has(id) ? LEFT : RIGHT });

	it('lists every drawn panel in PROJECT_ANCHORS order, grouped by its column', () => {
		const groups = projectNavGroups(all);
		expect(groups.map((g) => g.label)).toEqual([LEFT, RIGHT]);
		expect(groups.flatMap((g) => g.sections.map((s) => s.id))).toEqual([...PROJECT_ANCHORS]);
		expect(groups[0]!.sections[0]).toEqual({ id: 'details-h', label: 'Heading of details-h' });
	});

	it('leaves out a panel this reader isn’t shown (a viewer has no share links) and one with no heading text', () => {
		const viewer = projectNavGroups((id) => (id === 'share-h' ? null : id === 'model-h' ? { label: '', group: LEFT } : all(id)));
		const ids = viewer.flatMap((g) => g.sections.map((s) => s.id));
		expect(ids).not.toContain('share-h');
		expect(ids).not.toContain('model-h');
		expect(ids).toHaveLength(PROJECT_ANCHORS.length - 2);
	});

	it('takes a panel added to the list with no other change (#586: API keys and Scheduled reports, 15 in all)', () => {
		const anchors = [...PROJECT_ANCHORS, 'project-api-keys', 'project-report-schedules'];
		const groups = projectNavGroups(all, anchors);
		const ids = groups.flatMap((g) => g.sections.map((s) => s.id));
		expect(ids).toEqual(anchors);
		expect(ids.slice(-2)).toEqual(['project-api-keys', 'project-report-schedules']);
		expect(groups.at(-1)!.label).toBe(RIGHT);
	});

	it('a page with no panel drawn yet has no menu', () => {
		expect(projectNavGroups(() => null)).toEqual([]);
	});

	it('the page names its two columns as the groups', () => {
		const tab = readFileSync(new URL('./ProjectTab.svelte', import.meta.url), 'utf8');
		expect([...tab.matchAll(/data-nav-group="([^"]+)"/g)].map((m) => m[1])).toEqual([LEFT, RIGHT]);
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
