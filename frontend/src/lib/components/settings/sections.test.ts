import { describe, expect, it } from 'vitest';
import { findElsewhere } from '#lib/components/common/sectionNav.js';
import { saveBlockers, SETTINGS_ELSEWHERE, SETTINGS_MOVED, SETTINGS_SECTIONS, settingsElsewhere, settingsForward, settingsNavGroups } from './sections';

describe('SETTINGS_SECTIONS', () => {
	it('has unique ids, in page order, grouped by task', () => {
		const ids = SETTINGS_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			'set-period',
			'set-rain',
			'set-quality',
			'set-demand',
			'set-restrict',
			'set-reporting',
			// Flow generation (issue #553 round 3) keeps the Flow share panel's id and leads Runoff & calibration.
			'set-share',
			'set-flow',
			'set-record',
			'set-fit',
			'set-wr2012',
			'set-ewr',
			'set-reserve',
			// The outcome matrix's reading of a sweep, the seasonal outlook's season and the declared uncertainty rule: they change no result.
			'set-outcomes',
			'set-outlook',
			'set-evidence',
			// Last: Data feeds, API keys and Scheduled reports, which followed it, moved to Data and Project (issue #586).
			'set-auto'
		]);
		// Each group's panels sit together, so the menu's groups follow the page.
		const groups = SETTINGS_SECTIONS.map((s) => s.group);
		expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([
			'Data & rain',
			'Demand & supply',
			'Runoff & calibration',
			'EWR & Reserve',
			'Reading results',
			// Its one panel's heading, word for word (issue #586, C9).
			'Automatic runs'
		]);
	});
});

describe('settingsElsewhere (issue #586)', () => {
	it('offers API keys to an owner only, since Project shows no such panel to anyone else', () => {
		expect(settingsElsewhere(true).map((e) => e.text)).toContain('API keys');
		expect(settingsElsewhere(false).map((e) => e.text)).not.toContain('API keys');
		expect(settingsElsewhere(false).map((e) => e.text)).toEqual(['Comparison band', 'Data feeds', 'Scheduled reports']);
	});
});

describe('SETTINGS_ELSEWHERE (issue #521)', () => {
	it('offers the comparison band on Allocations for each way a reader may ask for it', () => {
		for (const q of ['comparison band', 'registered volumes', 'tolerance']) {
			expect(findElsewhere(SETTINGS_ELSEWHERE, q).map((e) => e.href), q).toEqual(['?tab=allocations#alloc-band']);
		}
	});

	it('finds the three panels that moved away at their new homes (issue #586 round 1)', () => {
		for (const [q, href, page] of [
			['data feeds', '?tab=series#data-feeds', 'Data'],
			['CHIRPS', '?tab=series#data-feeds', 'Data'],
			['API keys', '?tab=project#project-api-keys', 'Project'],
			['ingest', '?tab=project#project-api-keys', 'Project'],
			['scheduled reports', '?tab=project#project-report-schedules', 'Project'],
			['schedule', '?tab=project#project-report-schedules', 'Project']
		] as const) {
			expect(findElsewhere(SETTINGS_ELSEWHERE, q).map((e) => [e.href, e.page]), q).toEqual([[href, page]]);
		}
		// Each one points where its old anchor forwards to.
		for (const [old, to] of Object.entries(SETTINGS_MOVED)) {
			expect(SETTINGS_ELSEWHERE.map((e) => e.href), old).toContain(`?tab=${to.tab}#${to.hash}`);
		}
	});
});

describe('settingsNavGroups', () => {
	it('lists every panel under its task, the last group Automatic runs alone, on the bar and in the rail alike', () => {
		const groups = settingsNavGroups();
		expect(groups.map((g) => g.label)).toEqual(['Data & rain', 'Demand & supply', 'Runoff & calibration', 'EWR & Reserve', 'Reading results', 'Automatic runs']);
		expect(groups[0]!.sections.map((s) => s.label)).toEqual(['Simulation period', 'Rain gaps', 'Data quality']);
		expect(groups.at(-1)!.sections).toEqual([{ id: 'set-auto', label: 'Automatic runs' }]);
		// Every panel has its own link, in page order, and none stands for another.
		expect(groups.flatMap((g) => g.sections.map((s) => s.id))).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
		expect(groups.flatMap((g) => g.sections).some((s) => 'covers' in s)).toBe(false);
	});
});

describe('settingsForward (issue #586 round 1)', () => {
	const at = (path: string) => new URL(path, 'https://example.org');

	it('sends each moved anchor to its new page and anchor', () => {
		expect(settingsForward(at('/projects/p1?tab=settings#set-feeds'))).toBe('/projects/p1?tab=series#data-feeds');
		expect(settingsForward(at('/projects/p1?tab=settings#set-api-keys'))).toBe('/projects/p1?tab=project#project-api-keys');
		expect(settingsForward(at('/projects/p1?tab=settings#set-report-schedules'))).toBe('/projects/p1?tab=project#project-report-schedules');
	});

	it('keeps every other parameter, in its place', () => {
		expect(settingsForward(at('/projects/p1?tab=settings&rain=boundary#set-feeds'))).toBe('/projects/p1?tab=series&rain=boundary#data-feeds');
		expect(settingsForward(at('/projects/p1?rain=units&tab=settings&run=r9#set-feeds'))).toBe('/projects/p1?rain=units&tab=series&run=r9#data-feeds');
		// The calibration alias forwards too, and a percent-encoded hash is read as its id.
		expect(settingsForward(at('/projects/p1?tab=calibration#set%2Dfeeds'))).toBe('/projects/p1?tab=series#data-feeds');
		// A base path (a production deploy under a prefix) stays.
		expect(settingsForward(at('/app/projects/p1?tab=settings#set-api-keys'))).toBe('/app/projects/p1?tab=project#project-api-keys');
	});

	it('sends a map proposal’s link (?rain=boundary, ?rain=units) to Data feeds without its #', () => {
		expect(settingsForward(at('/projects/p1?tab=settings&rain=boundary'))).toBe('/projects/p1?tab=series&rain=boundary#data-feeds');
		expect(settingsForward(at('/projects/p1?tab=settings&rain=units'))).toBe('/projects/p1?tab=series&rain=units#data-feeds');
		expect(settingsForward(at('/projects/p1?tab=settings&rain=other'))).toBeNull();
		// Another panel's anchor wins: the rain= is for Data feeds only.
		expect(settingsForward(at('/projects/p1?tab=settings&rain=boundary#set-ewr'))).toBeNull();
	});

	it('leaves every other anchor here', () => {
		for (const hash of ['', '#set-auto', '#set-ewr', '#set-feeds-x', '#data-feeds', '#%E0', '#constructor', '#toString']) {
			expect(settingsForward(at(`/projects/p1?tab=settings${hash}`)), hash).toBeNull();
		}
		for (const s of SETTINGS_SECTIONS) expect(SETTINGS_MOVED[s.id], s.id).toBeUndefined();
	});
});

describe('saveBlockers', () => {
	it('is empty when nothing has a message', () => {
		expect(saveBlockers([])).toEqual([]);
		expect(saveBlockers([{ id: 'set-period', message: null }, { id: 'set-ewr', message: '' }])).toEqual([]);
	});

	it('lists each panel with a problem once, in page order, with its label and first message', () => {
		expect(
			saveBlockers([
				{ id: 'set-quality', message: 'Lowest ratio must be below the highest.' },
				{ id: 'set-flow', message: null },
				{ id: 'set-flow', message: 'Give each exclusion a reason.' },
				{ id: 'set-flow', message: 'The calibration window must start before it ends.' },
				{ id: 'set-period', message: 'Simulation start must be before the end.' }
			])
		).toEqual([
			{ id: 'set-period', label: 'Simulation period', message: 'Simulation start must be before the end.' },
			{ id: 'set-quality', label: 'Data quality', message: 'Lowest ratio must be below the highest.' },
			{ id: 'set-flow', label: 'Flow calibration', message: 'Give each exclusion a reason.' }
		]);
	});
});
