// The automatic re-run's pure parts (runs/autoRun.ts): the setting over its
// defaults, the settings patch's bounds, and the label's "data to" day,
// counted in calendar days whatever the machine's time zone (CLAUDE.md
// rule 7). The debounce itself is SQL (app_enqueue_rerun, timestamptz +
// minutes: zone-free); autoRun.db.test.ts covers it under a skewed TZ.
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_RUN_DEFAULTS, AutoRunPatch, autoRunLabel, observedDataEnd, resolveAutoRun } from './autoRun.js';
import { SettingsPatch } from '../projects/settings.js';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

describe('resolveAutoRun', () => {
	it('is off, 15 minutes and never publishing by default', () => {
		expect(resolveAutoRun({})).toEqual({ enabled: false, debounceMinutes: 15, publish: 'never' });
		expect(resolveAutoRun(null)).toEqual(AUTO_RUN_DEFAULTS);
		expect(resolveAutoRun({ autoRun: 'yes' })).toEqual(AUTO_RUN_DEFAULTS);
	});

	it('takes each valid stored field, and falls back field by field', () => {
		expect(resolveAutoRun({ autoRun: { enabled: true, debounceMinutes: 0, publish: 'if_no_new_warnings' } })).toEqual({
			enabled: true,
			debounceMinutes: 0,
			publish: 'if_no_new_warnings'
		});
		// Only `true` turns it on; a bad debounce or publish mode is the default, not an error.
		expect(resolveAutoRun({ autoRun: { enabled: 'true', debounceMinutes: 2.5, publish: 'always' } })).toEqual(AUTO_RUN_DEFAULTS);
		expect(resolveAutoRun({ autoRun: { enabled: true, debounceMinutes: 121 } })).toEqual({ ...AUTO_RUN_DEFAULTS, enabled: true });
	});
});

describe('the autoRun settings patch', () => {
	it('accepts any subset within bounds', () => {
		expect(AutoRunPatch.parse({ enabled: true })).toEqual({ enabled: true });
		expect(SettingsPatch.parse({ autoRun: { debounceMinutes: 0, publish: 'if_no_new_warnings' } })).toMatchObject({ autoRun: { debounceMinutes: 0 } });
	});

	it('refuses "always" publishing, a debounce past 2 h or a fraction, and unknown keys', () => {
		expect(SettingsPatch.safeParse({ autoRun: { publish: 'always' } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ autoRun: { debounceMinutes: 121 } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ autoRun: { debounceMinutes: 1.5 } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ autoRun: { debounceMinutes: -1 } }).success).toBe(false);
		expect(SettingsPatch.safeParse({ autoRun: { maxWaitMinutes: 10 } }).success).toBe(false);
		// Positive control: the bounds themselves pass.
		expect(SettingsPatch.safeParse({ autoRun: { debounceMinutes: 120 } }).success).toBe(true);
	});
});

describe('the auto run label', () => {
	const series = {
		rain_catchment_mm: { startDate: '2024-02-27', values: [1, 0, 2, null] },
		flow_observed_m3s: { startDate: '2024-02-01', values: [0.2, 0.3] },
		// A forecast reaches further but isn't data yet.
		rain_forecast_mm: { startDate: '2024-03-01', values: [5, 5, 5, 5] }
	};

	it.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns'])(
		'names the last observed day, across a leap day, in any machine zone (TZ %s)',
		(zone) => {
			process.env.TZ = zone;
			// 2024-02-27 + 2 days = 2024-02-29 (the trailing null is no data).
			expect(observedDataEnd(series)).toBe('2024-02-29');
			expect(autoRunLabel({ series })).toBe('Auto · data to 2024-02-29');
		}
	);

	it('counts recorded rain only: observed flow months past the rain does not move it', () => {
		const flowAhead = { ...series, flow_observed_m3s: { startDate: '2024-02-01', values: new Array(120).fill(0.2) } };
		expect(observedDataEnd(flowAhead)).toBe('2024-02-29');
		// CHIRPS counts as recorded rain.
		expect(observedDataEnd({ ...flowAhead, rain_chirps_mm: { startDate: '2024-03-01', values: [0, 2, null] } })).toBe('2024-03-02');
		expect(autoRunLabel({ series: { flow_observed_m3s: { startDate: '2024-02-01', values: [1] } } })).toBe('Auto');
	});

	it('is plain "Auto" with no observed data', () => {
		expect(autoRunLabel({ series: {} })).toBe('Auto');
		expect(
			autoRunLabel({ series: { rain_forecast_mm: { startDate: '2024-03-01', values: [1] }, rain_catchment_mm: { startDate: '2024-01-01', values: [null] } } })
		).toBe('Auto');
	});
});
