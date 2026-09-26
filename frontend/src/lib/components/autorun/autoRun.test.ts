import { afterEach, describe, expect, it } from 'vitest';
import type { RunMeta } from '$lib/api/types';
import { AUTO_RUN_DEFAULTS, autoRunError, autoRunToPublish, rerunQueuedText, resolveAutoRun } from './autoRun';

const tz = process.env.TZ;
afterEach(() => {
	process.env.TZ = tz;
});

describe('resolveAutoRun / autoRunError', () => {
	it('fills the defaults (off, 15 minutes, never publish) for an older API', () => {
		expect(resolveAutoRun({})).toEqual(AUTO_RUN_DEFAULTS);
		expect(resolveAutoRun(null)).toEqual({ enabled: false, debounceMinutes: 15, publish: 'never' });
		expect(resolveAutoRun({ autoRun: { enabled: true } })).toEqual({ ...AUTO_RUN_DEFAULTS, enabled: true });
	});

	it('refuses a wait outside 0–120 whole minutes', () => {
		expect(autoRunError({ ...AUTO_RUN_DEFAULTS, debounceMinutes: 0 })).toBeNull();
		expect(autoRunError({ ...AUTO_RUN_DEFAULTS, debounceMinutes: 120 })).toBeNull();
		expect(autoRunError({ ...AUTO_RUN_DEFAULTS, debounceMinutes: 121 })).toMatch(/0 to 120/);
		expect(autoRunError({ ...AUTO_RUN_DEFAULTS, debounceMinutes: 2.5 })).toMatch(/whole number/);
		expect(autoRunError({ ...AUTO_RUN_DEFAULTS, debounceMinutes: -1 })).not.toBeNull();
	});
});

describe('rerunQueuedText', () => {
	it('says the viewer’s local time, whatever the zone (TZ skewed)', () => {
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
		// 2026-09-26 00:05 UTC is 14:05 the same day in Kiritimati.
		expect(rerunQueuedText('2026-09-26T00:05:00Z', new Date('2026-09-25T23:50:00Z'))).toBe('an automatic re-run is queued for 14:05');
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11
		expect(rerunQueuedText('2026-09-26T00:05:00Z', new Date('2026-09-25T23:50:00Z'))).toBe('an automatic re-run is queued for 13:05');
	});

	it('names the day when it falls on another local day', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		// 09:50 UTC is 23:50 local; 10:05 UTC is 00:05 the next local day.
		expect(rerunQueuedText('2026-09-26T10:05:00Z', new Date('2026-09-26T09:50:00Z'))).toBe('an automatic re-run is queued for 27 Sep 00:05');
	});

	it('is due now once its time has passed, and plain "queued" without a time', () => {
		expect(rerunQueuedText('2026-09-26T10:00:00Z', new Date('2026-09-26T10:00:01Z'))).toBe('an automatic re-run is due now');
		expect(rerunQueuedText(null)).toBe('an automatic re-run is queued');
		expect(rerunQueuedText('not a date')).toBe('an automatic re-run is queued');
	});
});

describe('autoRunToPublish', () => {
	const run = (id: string, createdAt: string, trigger?: RunMeta['trigger']) =>
		({ id, createdAt, trigger, label: id, engineVersion: '1', startDate: '2020-01-01', endDate: '2020-12-31', createdBy: null, legacy: false }) as RunMeta;

	it('offers the newest auto run when it is newer than the published run', () => {
		const runs = [run('a2', '2026-09-26T10:00:00Z', 'auto'), run('m', '2026-09-25T10:00:00Z', 'manual'), run('a1', '2026-09-24T10:00:00Z', 'auto')];
		expect(autoRunToPublish(runs, 'm')?.id).toBe('a2');
	});

	it('offers nothing when the newest auto run is the published one, older, or nothing is published', () => {
		const runs = [run('m2', '2026-09-27T10:00:00Z'), run('a', '2026-09-26T10:00:00Z', 'auto'), run('m', '2026-09-25T10:00:00Z', 'manual')];
		expect(autoRunToPublish(runs, 'a')).toBeNull();
		expect(autoRunToPublish(runs, 'm2')).toBeNull();
		expect(autoRunToPublish(runs, null)).toBeNull();
		expect(autoRunToPublish([run('m', '2026-09-25T10:00:00Z')], 'm')).toBeNull();
		// Positive control: a published run missing from the list (an older page of it) still gets the offer.
		expect(autoRunToPublish(runs, 'gone')?.id).toBe('a');
	});
});
