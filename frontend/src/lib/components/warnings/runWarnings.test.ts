import { describe, expect, it } from 'vitest';
import { WARNING_CODES, type WarningCode } from '@water-management/engine';
import { runWarningRows, runWarningState, settingLink } from './runWarnings';

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

describe('runWarningState (the page and the badge alike)', () => {
	it('is kept by its id, fixed once its one-value fix is saved, else open', async () => {
		const { defaultProjectSettings } = await import('@water-management/engine');
		const base = defaultProjectSettings();
		const [row] = runWarningRows({ warnings: ['acc'], warningCodes: [{ code: 'rain.accumulation.asRecorded', params: { windows: 1 }, text: 'acc' }] });
		const asRecorded = { ...base, zeroRainRuns: { ...base.zeroRainRuns, accumulationMode: 'asRecorded' as const } };
		expect(runWarningState(row!, asRecorded)).toBe('open');
		expect(runWarningState(row!, base)).toBe('fixed');
		expect(runWarningState(row!, { ...asRecorded, warningsKept: [{ id: row!.id, note: '' }] })).toBe('kept');
	});
});

describe('runWarningRows', () => {
	it('lists checks, then notes, each text once, each with a stable id, an area and its fix', () => {
		const summary = {
			warnings: ['catchment rain treated as missing on 4 days', 'no observed flow to calibrate against', 'bed losses are on', 'no observed flow to calibrate against'],
			warningCodes: [
				{ code: 'rain.zeroRun.missing' as const, params: { days: 4 }, text: 'catchment rain treated as missing on 4 days' },
				{ code: 'calibration.noObserved' as const, params: {} as Record<string, number>, text: 'no observed flow to calibrate against' },
				{ code: 'calibration.noObserved' as const, params: {}, text: 'no observed flow to calibrate against' }
			]
		};
		const rows = runWarningRows(summary, '/help/g');
		expect(rows.map((x) => [x.text, x.group, x.area, x.fix.action.label])).toEqual([
			['No observed flow to calibrate against', 'check', 'calibration', 'Add data'],
			['Bed losses are on', 'check', 'runs', 'How to read run warnings'],
			['Catchment rain treated as missing on 4 days', 'note', 'rain', 'Go to Keep dry']
		]);
		// The id holds across runs whose counts differ.
		const next = runWarningRows({ warnings: ['catchment rain treated as missing on 9 days'], warningCodes: [{ code: 'rain.zeroRun.missing', params: { days: 9 }, text: 'catchment rain treated as missing on 9 days' }] });
		expect(next[0]!.id).toBe(rows[2]!.id);
		expect(rows[2]!.id).toMatch(/^run:rain\.zeroRun\.missing:[0-9a-f]{8}$/);
		expect(rows[1]!.id).toMatch(/^run:text:[0-9a-f]{8}$/);
	});
	it('groups an older run’s uncoded warnings by their text, each with a fix by its words or the guide', () => {
		expect(runWarningRows({ warnings: ['x', 'Catchment rain treated as missing on 3 days'] }, '/help/g').map((r) => [r.text, r.group, r.label])).toEqual([
			['X', 'check', 'How to read run warnings'],
			['Catchment rain treated as missing on 3 days', 'note', 'Go to Flagged zero runs']
		]);
		expect(runWarningRows(null)).toEqual([]);
	});
});
