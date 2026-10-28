import { describe, expect, it } from 'vitest';
import { WARNING_CODES, type WarningCode } from '@water-management/engine';
import { runWarningRows, settingLink } from './runWarnings';

describe('settingLink', () => {
	it('links a code to its settings panel on the page that has it, or to Data', () => {
		expect(settingLink('rain.zeroRun.missing')).toEqual({ href: '?tab=settings#set-rain', label: 'Go to Rain gaps' });
		expect(settingLink('calibration.noObserved')).toEqual({ href: '?tab=calibration#set-record', label: 'Go to Calibration record' });
		expect(settingLink('rain.unit.catchmentFallback')).toEqual({ href: '?tab=settings#set-unit-rain', label: 'Go to Unit rain' });
		expect(settingLink('rain.none')).toEqual({ href: '?tab=series', label: 'Go to Data' });
	});
	it('names a real panel for every code in the catalogue', () => {
		for (const code of Object.keys(WARNING_CODES) as WarningCode[]) expect(settingLink(code).label).not.toBe('Go to the setting');
	});
});

describe('runWarningRows', () => {
	it('lists checks, then notes, each text once, coded ones with their setting and the rest without', () => {
		const summary = {
			warnings: ['catchment rain treated as missing on 4 days', 'no observed flow to calibrate against', 'bed losses are on', 'no observed flow to calibrate against'],
			warningCodes: [
				{ code: 'rain.zeroRun.missing' as const, params: {}, text: 'catchment rain treated as missing on 4 days' },
				{ code: 'calibration.noObserved' as const, params: {}, text: 'no observed flow to calibrate against' },
				{ code: 'calibration.noObserved' as const, params: {}, text: 'no observed flow to calibrate against' }
			]
		};
		expect(runWarningRows(summary).map((x) => [x.text, x.group, x.href])).toEqual([
			['No observed flow to calibrate against', 'check', '?tab=calibration#set-record'],
			['Bed losses are on', 'check', null],
			['Catchment rain treated as missing on 4 days', 'note', '?tab=settings#set-rain']
		]);
	});
	it('groups an older run’s uncoded warnings by their text', () => {
		expect(runWarningRows({ warnings: ['x', 'Catchment rain treated as missing on 3 days'] }).map((r) => [r.text, r.group, r.label])).toEqual([
			['X', 'check', null],
			['Catchment rain treated as missing on 3 days', 'note', null]
		]);
		expect(runWarningRows(null)).toEqual([]);
	});
});
