import { describe, expect, it } from 'vitest';
import { AFTER_FORM_LABELS, saveBlockers, SETTINGS_SECTIONS, settingsNavGroups } from './sections';

describe('SETTINGS_SECTIONS', () => {
	it('has unique ids, in page order starting with Demand', () => {
		const ids = SETTINGS_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[0]).toBe('set-demand');
		// Data feeds sits after the form: it saves on its own, never through the save bar.
		expect(ids.at(-1)).toBe('set-feeds');
		expect(ids.at(-2)).toBe('set-auto');
		// The outcome matrix's reading of a sweep and the seasonal outlook's season: after the model's inputs (data quality last), they change no result.
		expect(ids.at(-3)).toBe('set-outlook');
		expect(ids.at(-4)).toBe('set-outcomes');
		expect(ids.at(-5)).toBe('set-quality');
	});
});

describe('settingsNavGroups', () => {
	it('covers every section once, in page order, then the panels after Data feeds', () => {
		const owner = settingsNavGroups(true);
		expect(owner.map((g) => g.label)).toEqual(['Model inputs', 'How results are read', 'Runs, feeds and reports']);
		expect(owner.flatMap((g) => g.ids)).toEqual([...SETTINGS_SECTIONS.map((s) => s.id), 'set-api-keys', 'set-report-schedules']);
		// Data quality is a model input: its zero-rain and low-vs-CHIRPS limits change results (issue #173).
		expect(owner[0]!.ids.at(-1)).toBe('set-quality');
		expect(owner[1]!.ids).toEqual(['set-outcomes', 'set-outlook']);
		for (const id of ['set-api-keys', 'set-report-schedules']) expect(AFTER_FORM_LABELS[id]).toBeTruthy();
	});

	it('links API keys for an owner only, since only an owner sees that panel', () => {
		expect(settingsNavGroups(false).at(-1)!.ids).toEqual(['set-auto', 'set-feeds', 'set-report-schedules']);
	});
});

describe('saveBlockers', () => {
	it('is empty when nothing has a message', () => {
		expect(saveBlockers([])).toEqual([]);
		expect(saveBlockers([{ id: 'set-period', message: null }, { id: 'set-ewr', message: '' }])).toEqual([]);
	});

	it('lists each group with a problem once, in page order, with its label and first message', () => {
		expect(
			saveBlockers([
				{ id: 'set-quality', message: 'Lowest ratio must be below the highest.' },
				{ id: 'set-flow', message: null },
				{ id: 'set-flow', message: 'Give each exclusion a reason.' },
				{ id: 'set-flow', message: 'The calibration window must start before it ends.' },
				{ id: 'set-period', message: 'Simulation start must be before the end.' }
			])
		).toEqual([
			{ id: 'set-flow', label: 'Flow calibration', message: 'Give each exclusion a reason.' },
			{ id: 'set-period', label: 'Simulation period', message: 'Simulation start must be before the end.' },
			{ id: 'set-quality', label: 'Data quality', message: 'Lowest ratio must be below the highest.' }
		]);
	});
});
