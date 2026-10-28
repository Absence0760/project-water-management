import { describe, expect, it } from 'vitest';
import { findElsewhere } from '#lib/components/common/sectionNav.js';
import { ANCHOR_MOVES, anchorMoved } from '#lib/nav/anchorMoves.js';
import { CALIBRATION_SETTINGS_ANCHORS, CALIBRATION_SETTINGS_SECTIONS, isCalibrationSetting, saveBlockers, SETTINGS_ELSEWHERE, SETTINGS_SECTIONS, settingsElsewhere, settingsNavGroups, settingsPageOf } from './sections';

describe('SETTINGS_SECTIONS', () => {
	it('has unique ids, in page order, grouped by task', () => {
		const ids = SETTINGS_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			// The model selection for flow generation leads the page (issue #614). It keeps the Flow share panel's id
			// (issue #553 round 3), so the old links land.
			'set-share',
			// Then the EWR the results are judged by (issue #444; it headed the page until issue #614), its own link
			// since issue #586 R4-B.
			'set-judge',
			'set-period',
			'set-rain',
			'set-quality',
			'set-demand',
			'set-restrict',
			'set-reporting',
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
			// The lead group with no name, above the first task's: the model selection, then the judge panel (issue #614).
			null,
			'Data & rain',
			'Demand & supply',
			'EWR & Reserve',
			'Reading results',
			// Its one panel's heading, word for word (issue #586, C9).
			'Automatic runs'
		]);
	});
});

describe('CALIBRATION_SETTINGS_SECTIONS (issue #586 round 3)', () => {
	it('lists the four panels on the Calibration page, in its order, and none of them is on Model settings', () => {
		expect(CALIBRATION_SETTINGS_SECTIONS.map((s) => [s.id, s.label])).toEqual([
			['set-flow', 'Flow calibration'],
			['set-record', 'Calibration record'],
			['set-fit', 'Fit the parameters'],
			['set-wr2012', 'WR2012 check']
		]);
		for (const s of CALIBRATION_SETTINGS_SECTIONS) {
			expect(SETTINGS_SECTIONS.some((x) => (x.id as string) === s.id), s.id).toBe(false);
			expect(isCalibrationSetting(s.id)).toBe(true);
			expect(settingsPageOf(s.id)).toBe('calibration');
		}
		for (const s of SETTINGS_SECTIONS) expect(settingsPageOf(s.id), s.id).toBe('settings');
	});
});

describe('settingsElsewhere (issue #586)', () => {
	it('offers API keys to an owner only, since Project shows no such panel to anyone else', () => {
		expect(settingsElsewhere(true).map((e) => e.text)).toContain('API keys');
		expect(settingsElsewhere(false).map((e) => e.text)).not.toContain('API keys');
		expect(settingsElsewhere(false).map((e) => e.text)).toEqual([
			'Comparison band',
			'Data feeds',
			'Scheduled reports',
			'Flow calibration',
			'Calibration record',
			'Fit the parameters',
			'WR2012 check',
			'Evaporation from the map'
		]);
	});
});

describe('SETTINGS_ELSEWHERE (issue #521)', () => {
	it('offers the comparison band on Allocations for each way a reader may ask for it', () => {
		for (const q of ['comparison band', 'registered volumes', 'tolerance']) {
			expect(findElsewhere(SETTINGS_ELSEWHERE, q).map((e) => e.href), q).toEqual(['?tab=allocations#alloc-band']);
		}
	});

	it('finds the panels that moved to Calibration there, by their fields’ words too (issue #586 round 3)', () => {
		for (const [q, href] of [
			['warm-up', '?tab=calibration#set-flow'],
			['pan coefficient', '?tab=calibration#set-flow'],
			['exclusions', '?tab=calibration#set-record'],
			['fit automatically', '?tab=calibration#set-fit'],
			['quaternary', '?tab=calibration#set-wr2012']
		] as const) {
			expect(findElsewhere(SETTINGS_ELSEWHERE, q).map((e) => [e.href, e.page]), q).toEqual([[href, 'Calibration']]);
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
		for (const move of ANCHOR_MOVES.filter((m) => m.from === 'settings')) {
			for (const hash of typeof move.hash === 'string' ? [move.hash] : (move.hash as readonly string[])) {
				expect(SETTINGS_ELSEWHERE.map((e) => e.href), hash).toContain(`?tab=${move.tab}#${move.to ?? hash}`);
			}
		}
	});

	it('finds the calibration panels on Calibration, by their headings and the settings they hold (issue #586 round 3)', () => {
		for (const [q, id] of [
			['flow calibration', 'set-flow'],
			['X3', 'set-flow'],
			['pan coefficient', 'set-flow'],
			['dPET', 'set-evaporation'],
			['calibration record', 'set-record'],
			['exclusions', 'set-record'],
			['fit automatically', 'set-fit'],
			['calibration rules', 'set-fit'],
			['quaternary', 'set-wr2012']
		] as const) {
			expect(findElsewhere(SETTINGS_ELSEWHERE, q).map((e) => [e.href, e.page]), q).toContainEqual([`?tab=calibration#${id}`, 'Calibration']);
		}
		// Every moved anchor has its entry, each by its heading.
		expect(SETTINGS_ELSEWHERE.filter((e) => e.page === 'Calibration').map((e) => e.href.split('#')[1])).toEqual([...CALIBRATION_SETTINGS_ANCHORS]);
		for (const sec of CALIBRATION_SETTINGS_SECTIONS) expect(SETTINGS_ELSEWHERE.find((e) => e.href.endsWith(`#${sec.id}`))?.text, sec.id).toBe(sec.label);
	});
});

describe('settingsNavGroups', () => {
	it('lists every panel under its task, the last group Automatic runs alone, on the bar and in the rail alike', () => {
		const groups = settingsNavGroups();
		expect(groups.map((g) => g.label)).toEqual([null, 'Data & rain', 'Demand & supply', 'EWR & Reserve', 'Reading results', 'Automatic runs']);
		// The lead group, with no name: the model selection for flow generation first (issue #614), then the judge panel
		// (issue #586 R4-B: it had no link, so Find a setting couldn't find it), each by its heading.
		expect(groups[0]!.sections).toEqual([
			{ id: 'set-share', label: 'Model selection for flow generation' },
			{ id: 'set-judge', label: 'EWR the results are judged by' }
		]);
		expect(groups[1]!.sections.map((s) => s.label)).toEqual(['Simulation period', 'Rain gaps', 'Data quality']);
		expect(groups.at(-1)!.sections).toEqual([{ id: 'set-auto', label: 'Automatic runs' }]);
		// Every panel has its own link, in page order, and none stands for another.
		expect(groups.flatMap((g) => g.sections.map((s) => s.id))).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
		expect(groups.flatMap((g) => g.sections).some((s) => 'covers' in s)).toBe(false);
	});
});

describe('the moved anchors (nav/anchorMoves.ts)', () => {
	it('moves no anchor of a panel still here', () => {
		for (const sec of SETTINGS_SECTIONS) expect(anchorMoved('settings', sec.id), sec.id).toBe(false);
	});

	it('moves every calibration panel, and lists none of them here', () => {
		for (const sec of CALIBRATION_SETTINGS_SECTIONS) {
			expect(anchorMoved('settings', sec.id), sec.id).toBe(true);
			expect(SETTINGS_SECTIONS.map((s) => s.id as string), sec.id).not.toContain(sec.id);
		}
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

	it('lists Model settings’ panels, then Calibration’s, each on its page (issue #586 round 3)', () => {
		const list = saveBlockers([
			{ id: 'set-wr2012', message: 'Give the quaternary.' },
			{ id: 'set-ewr', message: 'The EWR must be 0 or more.' },
			{ id: 'set-record', message: 'Give each exclusion a reason.' }
		]);
		expect(list.map((b) => [b.id, settingsPageOf(b.id)])).toEqual([
			['set-ewr', 'settings'],
			['set-record', 'calibration'],
			['set-wr2012', 'calibration']
		]);
	});
});
