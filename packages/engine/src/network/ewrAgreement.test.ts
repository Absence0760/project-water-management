import { describe, expect, it } from 'vitest';
import { belowEwr, ewrAgreement, scoreContingency } from './ewrAgreement';

const DAY = 86_400;
/** m³/day → the m³/s an observed record stores. */
const m3s = (v: number[]) => v.map((x) => x / DAY);

describe('ewrAgreement', () => {
	// EWR 100 m³/day. Day by day (sim, obs):
	//   0: 50, 50   both below
	//   1: 50, 150  false alarm
	//   2: 150, 50  miss
	//   3: 150, 150 both above
	//   4: 50, 50   both below
	//   5: 50, 150  false alarm
	const sim = [50, 50, 150, 150, 50, 50];
	const obs = m3s([50, 150, 50, 150, 50, 150]);
	const ewr = new Array(6).fill(100);

	it('builds the 2×2 table and its scores from a hand-counted case', () => {
		const a = ewrAgreement(sim, obs, ewr, { startDate: '2021-01-01' });
		expect(a.days).toBe(6);
		expect(a.overall).toMatchObject({ days: 6, bothBelow: 2, falseAlarm: 2, miss: 1, bothAbove: 1 });
		expect(a.overall.hitRate).toBeCloseTo(2 / 3, 12);
		expect(a.overall.falseAlarmRatio).toBeCloseTo(2 / 4, 12);
		// Model below on 4 of 6 days, the river on 3 of 6: bias 4/3.
		expect(a.overall.frequencyBias).toBeCloseTo(4 / 3, 12);
		expect(a.overall.modelFractionBelow).toBeCloseTo(4 / 6, 12);
		expect(a.overall.observedFractionBelow).toBeCloseTo(3 / 6, 12);
		expect(a.overall.frequencyBias).toBeCloseTo(a.overall.modelFractionBelow! / a.overall.observedFractionBelow!, 12);
		expect(a.firstObservedDate).toBe('2021-01-01');
		expect(a.lastObservedDate).toBe('2021-01-06');
	});

	it('splits the table per water-year month and per water year', () => {
		// 2021-09-28 … 2021-10-03: three September days (water year 2020) then three October days (2021).
		const a = ewrAgreement(sim, obs, ewr, { startDate: '2021-09-28' });
		const sep = a.byMonth[11]!;
		const oct = a.byMonth[0]!;
		expect(sep).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, miss: 1, bothAbove: 0 });
		expect(oct).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, miss: 0, bothAbove: 1 });
		expect(a.byMonth.filter((m) => m.days === 0)).toHaveLength(10);
		expect(a.byMonth[5]!.hitRate).toBeNull(); // no days: every ratio is null
		expect(a.byWaterYear.map((y) => y.waterYear)).toEqual([2020, 2021]);
		expect(a.byWaterYear[0]).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, miss: 1 });
		expect(a.byWaterYear[1]).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, bothAbove: 1 });
		// The breakdowns add back up to the overall table.
		for (const k of ['days', 'bothBelow', 'falseAlarm', 'miss', 'bothAbove'] as const) {
			expect(a.byMonth.reduce((s, m) => s + m[k], 0)).toBe(a.overall[k]);
			expect(a.byWaterYear.reduce((s, y) => s + y[k], 0)).toBe(a.overall[k]);
		}
	});

	it('assigns months by UTC date in any time zone', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
				env.TZ = zone;
				const a = ewrAgreement(sim, obs, ewr, { startDate: '2021-09-28' });
				expect(a.byMonth[11]!.days, zone).toBe(3);
				expect(a.byMonth[0]!.days, zone).toBe(3);
				expect(a.byWaterYear.map((y) => y.waterYear), zone).toEqual([2020, 2021]);
			}
		} finally {
			env.TZ = tz;
		}
	});

	it('skips days without an observation (null, NaN, past the record)', () => {
		const gappy = [obs[0]!, null, NaN, obs[3]!];
		const a = ewrAgreement(sim, gappy, ewr, { startDate: '2021-01-01' });
		expect(a.days).toBe(2);
		expect(a.overall).toMatchObject({ bothBelow: 1, falseAlarm: 0, miss: 0, bothAbove: 1 });
		expect(a.firstObservedDate).toBe('2021-01-01');
		expect(a.lastObservedDate).toBe('2021-01-04');
		expect(a.excludedDays).toBe(0);
	});

	it('returns an empty table when there is no observed day', () => {
		const a = ewrAgreement(sim, new Array(6).fill(null), ewr, { startDate: '2021-01-01' });
		expect(a.days).toBe(0);
		expect(a.overall).toMatchObject({ days: 0, bothBelow: 0, falseAlarm: 0, miss: 0, bothAbove: 0 });
		expect(a.overall.hitRate).toBeNull();
		expect(a.overall.falseAlarmRatio).toBeNull();
		expect(a.overall.frequencyBias).toBeNull();
		expect(a.overall.modelFractionBelow).toBeNull();
		expect(a.byWaterYear).toEqual([]);
		expect(a.firstObservedDate).toBeNull();
		expect(ewrAgreement([], [], [], { startDate: '2021-01-01' }).days).toBe(0);
	});

	it('leaves out calibration exclusions and a window, and counts what was excluded', () => {
		const a = ewrAgreement(sim, obs, ewr, {
			startDate: '2021-01-01',
			exclusions: [{ start: '2021-01-02', end: '2021-01-03' }]
		});
		expect(a.days).toBe(4);
		expect(a.excludedDays).toBe(2);
		expect(a.overall).toMatchObject({ bothBelow: 2, falseAlarm: 1, miss: 0, bothAbove: 1 });
		const w = ewrAgreement(sim, obs, ewr, { startDate: '2021-01-01', windowStart: '2021-01-04', windowEnd: '2021-01-05' });
		expect(w.overall).toMatchObject({ days: 2, bothBelow: 1, bothAbove: 1 });
		// An exclusion reaching outside the run is clamped, not an error.
		const x = ewrAgreement(sim, obs, ewr, { startDate: '2021-01-01', exclusions: [{ start: '2020-01-01', end: '2030-01-01' }] });
		expect(x.days).toBe(0);
		expect(x.excludedDays).toBe(6);
	});

	it('positive control: observed equal to simulated gives bias 1 with no false alarms or misses', () => {
		const flows = [10, 90, 99.999, 100, 100.001, 250, 0, 40, 1e6, 3.3];
		const e = [100, 100, 100, 100, 100, 100, 100, 50, 50, 50];
		const a = ewrAgreement(flows, m3s(flows), e, { startDate: '2020-02-27' });
		expect(a.days).toBe(flows.length);
		expect(a.overall.falseAlarm).toBe(0);
		expect(a.overall.miss).toBe(0);
		expect(a.overall.frequencyBias).toBe(1);
		expect(a.overall.hitRate).toBe(1);
		expect(a.overall.falseAlarmRatio).toBe(0);
		expect(a.overall.bothBelow).toBe(6);
	});

	it('counts "below" the same way as the outlet test (float noise is met)', () => {
		expect(belowEwr(99, 100)).toBe(true);
		expect(belowEwr(100, 100)).toBe(false);
		expect(belowEwr(5e9, 5e9 + 1e-6)).toBe(false);
		expect(belowEwr(5e9, 5e9 + 1)).toBe(true);
	});

	it('scores a table with null ratios where a denominator is 0', () => {
		const s = scoreContingency({ days: 5, bothBelow: 0, falseAlarm: 2, miss: 0, bothAbove: 3 });
		expect(s.hitRate).toBeNull();
		expect(s.frequencyBias).toBeNull();
		expect(s.falseAlarmRatio).toBe(1);
		expect(s.modelFractionBelow).toBeCloseTo(0.4, 12);
		expect(s.observedFractionBelow).toBe(0);
	});
});
