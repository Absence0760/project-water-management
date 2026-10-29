import { defaultProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { blockerHref, periodError, reportingError, settingsBlockers } from './blockers';
import { CHILD_ERRORS, editableSettings, type ChildError } from './settingsDraft.svelte';

const none = () => Object.fromEntries(CHILD_ERRORS.map((k) => [k, null])) as Record<ChildError, string | null>;

describe('settingsBlockers (issue #586 round 3)', () => {
	it('is empty for the defaults', () => {
		expect(settingsBlockers(editableSettings(defaultProjectSettings()), none())).toEqual([]);
	});

	it('lists Model settings’ panels first, then Calibration’s, each once with its first message', () => {
		const s = editableSettings({ ...defaultProjectSettings(), reportStart: '2020-02-01', reportEnd: '2020-01-01' });
		const errors = { ...none(), wr2012: 'The WR2012 check has 1 problem to fix.', rules: 'Give the rules a reason.', reserve: 'A rule table has no site.' };
		expect(settingsBlockers(s, errors).map((b) => b.id)).toEqual(['set-reporting', 'set-reserve', 'set-fit', 'set-wr2012']);
	});

	it('blocks Save on a catchment MAP without its source, under Flow generation (issue #612)', () => {
		const s = editableSettings({ ...defaultProjectSettings(), rainStations: { catchmentMapMm: 750 } } as never);
		expect(settingsBlockers(s, none())).toEqual([expect.objectContaining({ id: 'set-share', message: expect.stringMatching(/needs its source/) })]);
		const ok = editableSettings({ ...defaultProjectSettings(), rainStations: { catchmentMapMm: 750, catchmentMapSource: 'a study' } } as never);
		expect(settingsBlockers(ok, none())).toEqual([]);
	});

	it('checks the two windows', () => {
		expect(periodError({ simulationStart: '2020-01-02', simulationEnd: '2020-01-01' })).toBe('Simulation start must be before the end.');
		expect(periodError({ simulationStart: '2020-01-01', simulationEnd: null })).toBeNull();
		expect(reportingError({ reportStart: '2020-01-01', reportEnd: '2020-01-01' })).toBeNull();
	});
});

describe('blockerHref', () => {
	it('links a panel in place on its own page, and through that page from any other', () => {
		expect(blockerHref('set-period', 'settings')).toBe('#set-period');
		expect(blockerHref('set-period', 'calibration')).toBe('?tab=settings#set-period');
		expect(blockerHref('set-fit', 'calibration')).toBe('#set-fit');
		expect(blockerHref('set-fit', 'settings')).toBe('?tab=calibration#set-fit');
		expect(blockerHref('set-record', 'runs')).toBe('?tab=calibration#set-record');
		expect(blockerHref('set-ewr', 'network')).toBe('?tab=settings#set-ewr');
	});
});
