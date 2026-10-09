import { describe, expect, it } from 'vitest';
import { AUTOMATION_LABEL, saveBlockers, SETTINGS_SECTIONS, settingsNavGroups } from './sections';

describe('SETTINGS_SECTIONS', () => {
	it('has unique ids, in page order, grouped by task', () => {
		const ids = SETTINGS_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			'set-period',
			'set-rain',
			'set-quality',
			'set-demand',
			'set-share',
			'set-restrict',
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
			'set-auto',
			// Data feeds sits after the form: it saves on its own, never through the save bar.
			'set-feeds'
		]);
		// Each group's panels sit together, so the menu's groups follow the page.
		const groups = SETTINGS_SECTIONS.map((s) => s.group);
		expect(groups.filter((g, i) => g !== groups[i - 1])).toEqual([
			'Data & rain',
			'Demand & supply',
			'Runoff & calibration',
			'EWR & Reserve',
			'Reading results',
			'Automation & access'
		]);
	});
});

describe('settingsNavGroups', () => {
	it('in the rail, lists every panel under its task, the panels after the form under Automation & access', () => {
		const rail = settingsNavGroups(true, true);
		expect(rail.map((g) => g.label)).toEqual(['Data & rain', 'Demand & supply', 'Runoff & calibration', 'EWR & Reserve', 'Reading results', AUTOMATION_LABEL]);
		expect(rail[0]!.sections.map((s) => s.label)).toEqual(['Simulation period', 'Rain gaps', 'Data quality']);
		expect(rail.at(-1)!.sections.map((s) => [s.id, s.label])).toEqual([
			['set-auto', 'Automatic runs'],
			['set-feeds', 'Data feeds'],
			['set-api-keys', 'API keys'],
			['set-report-schedules', 'Scheduled reports']
		]);
		// API keys is an owner's panel.
		expect(settingsNavGroups(false, true).at(-1)!.sections.map((s) => s.id)).toEqual(['set-auto', 'set-feeds', 'set-report-schedules']);
	});

	it('on the bar, puts the last four behind one Automation & access link that lands on Automatic runs and stands for them all', () => {
		const owner = settingsNavGroups(true);
		expect(owner.at(-1)!.sections).toEqual([{ id: 'set-auto', label: AUTOMATION_LABEL, covers: ['set-feeds', 'set-api-keys', 'set-report-schedules'] }]);
		expect(settingsNavGroups(false).at(-1)!.sections[0]!.covers).toEqual(['set-feeds', 'set-report-schedules']);
		// Every other panel keeps its own link, in page order.
		const auto = SETTINGS_SECTIONS.findIndex((s) => s.id === 'set-auto');
		expect(owner.flatMap((g) => g.sections.map((s) => s.id))).toEqual([...SETTINGS_SECTIONS.slice(0, auto).map((s) => s.id), 'set-auto']);
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
