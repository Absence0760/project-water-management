import { describe, expect, it } from 'vitest';
import { defaultDataQualitySettings, defaultProjectSettings } from '@water-management/engine';
import { calibrationSummaries, changedLimits, dateSpan, settingsSummaries, type CalibrationSummaryInput, type SummaryInput } from './summaries';

const base = (patch: Partial<SummaryInput['s']> = {}): SummaryInput => ({
	s: { ...defaultProjectSettings(), ...patch } as SummaryInput['s'],
	ewrAnnualMm3: 12.598,
	ewrSource: 'Pragmatic EWR at the outflow gauge'
});
const cal = (patch: Partial<SummaryInput['s']> = {}, siteName?: string): CalibrationSummaryInput => ({
	s: { ...defaultProjectSettings(), ...patch } as SummaryInput['s'],
	unitAreaKm2: 70,
	peAnnualMm: 1200,
	siteName
});

describe('dateSpan', () => {
	it('names both ends, one end, or none', () => {
		expect(dateSpan('2015-10-01', '2020-09-30')).toBe('1 Oct 2015 – 30 Sep 2020');
		expect(dateSpan('2015-10-01', null)).toBe('from 1 Oct 2015');
		expect(dateSpan(null, '2020-09-30')).toBe('to 30 Sep 2020');
		expect(dateSpan(null, undefined)).toBeNull();
	});
});

describe('changedLimits', () => {
	it('counts the data-quality limits that differ from the defaults', () => {
		const d = defaultDataQualitySettings() as unknown as Record<string, unknown>;
		expect(changedLimits(undefined)).toBe(0);
		expect(changedLimits(d)).toBe(0);
		const key = Object.keys(d).find((k) => typeof d[k] === 'number')!;
		expect(changedLimits({ ...d, [key]: (d[key] as number) + 1 })).toBe(1);
	});
});

describe('settingsSummaries', () => {
	it('says a new project is on its defaults, in words', () => {
		const s = settingsSummaries(base());
		expect(s['set-period']).toBe('The whole rain record');
		expect(s['set-rain']).toBe('CHIRPS bias-corrected per month fills gaps · fitted on the whole record · zero runs treated as missing');
		expect(s['set-quality']).toBe('The default limits');
		expect(s['set-share']).toBe('Fragmentation · flow share: by catchment area · EWR by each unit’s natural MAR');
		expect(s['set-restrict']).toBe('Off');
		expect(s['set-reserve']).toBe('');
		expect(s['set-evidence']).toBe('No uncertainty rule declared');
		expect(s['set-auto']).toBe('Off: runs only when someone runs the model');
		expect(s['set-ewr']).toBe('Pragmatic EWR at the outflow gauge · 12.598 Mm³ a year');
		expect(s['set-reporting']).toBe('Reporting over the whole run · a water year is met at 90 % of demand');
	});

	it('reads the values that are set', () => {
		const set = {
			simulationStart: '2015-10-01',
			simulationEnd: '2020-09-30',
			chirpsBiasCorrection: 'none',
			apanMm: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 130],
			flowShareMethod: 'hiLo',
			hiLoSplit: { hi: 0.6, lo: 0.4 },
			calibrationStart: '2001-10-01',
			calibrationEnd: null,
			calibrationExclusions: [{ waterYear: 2004, reason: 'Gauge washed away' }] as never,
			qualityFlags: { ratings: {}, aboveRating: 'censor', belowRating: 'exclude', suspect: 'exclude', infilled: 'exclude', zeroFlowMonths: [2, 3, 4], lowFlowPeriods: [{ kind: 'flow_logger_m3s', start: '2003-01-01', end: '2003-06-30', maxM3s: 1, reason: 'r', source: 's' }] },
			autoRun: { enabled: true, debounceMinutes: 30, publish: 'never' }
		} as Partial<SummaryInput['s']>;
		const s = settingsSummaries(base(set));
		const c = calibrationSummaries(cal(set, 'Melkhout Gauge'));
		expect(s['set-period']).toBe('1 Oct 2015 – 30 Sep 2020');
		expect(s['set-rain']).toBe('Raw CHIRPS fills gaps · zero runs treated as missing');
		expect(s['set-demand']).toMatch(/^A-pan 1\s?230 mm a year · effective rain/);
		// The rain threshold for demand lives in Demand (issue #521), so its line names it.
		expect(s['set-demand']).toMatch(/ · rain threshold \d+(\.\d)? mm · /);
		expect(s['set-share']).toBe('Fragmentation · flow share: high/low MAP split, 60% / 40% · EWR by each unit’s natural MAR');
		expect(c['set-record']).toBe('from 1 Oct 2001 · at Melkhout Gauge · 1 period left out · low flows only in 1 period · river stops Feb, Mar, Apr');
		expect(s['set-auto']).toBe('On: 30 minutes after new data, never publishes');
	});

	it('names the flow generation method in the Model selection for flow generation summary, with the units on a station (issues #482, #553)', () => {
		expect(settingsSummaries(base())['set-share']).toBe('Fragmentation · flow share: by catchment area · EWR by each unit’s natural MAR');
		expect(settingsSummaries(base({ unitRain: { mode: 'catchment' } }))['set-share']).toMatch(/^Fragmentation · /);
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' } }))['set-share']).toBe('Per unit · no unit on a rainfall station · EWR by each unit’s natural MAR');
		const units = { a: { stationId: 's' }, b: { stationId: 's' } };
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' }, rainStations: { units } }))['set-share']).toBe('Per unit · 2 units on a rainfall station · EWR by each unit’s natural MAR');
		// Under Fragmentation the stations set the units' EWR shares (issue #615), so they count there too.
		expect(settingsSummaries(base({ rainStations: { units } }))['set-share']).toBe('Fragmentation · flow share: by catchment area · 2 units on a rainfall station · EWR by each unit’s natural MAR');
		expect(settingsSummaries(base({ rainStations: { catchment: { stationId: 's' }, units } }))['set-share']).toBe(
			'Fragmentation · flow share: by catchment area · catchment rain from a station · 2 units on a rainfall station · EWR by each unit’s natural MAR'
		);
		// No longer said in Flow calibration's line.
		expect(calibrationSummaries(cal({ unitRain: { mode: 'perUnit' } }))['set-flow']).not.toContain('rain for each unit');
		// The retired EWR split (issue #615) changes nothing: the EWR is always split by each unit's natural MAR.
		expect(settingsSummaries(base({ ewrSplit: 'flowShare' } as never))['set-share']).toBe('Fragmentation · flow share: by catchment area · EWR by each unit’s natural MAR');
	});
});

describe('the Reporting panel’s line (issue #521)', () => {
	it('names the window and the threshold that are set', () => {
		const s = settingsSummaries(base({ reportStart: '2019-06-01', reportEnd: '2019-09-30', assuranceAnnualThreshold: 0.85 }));
		expect(s['set-reporting']).toMatch(/^Reporting .+ · a water year is met at 85 % of demand$/);
		expect(s['set-reporting']).not.toContain('whole run');
		expect(s['set-ewr']).not.toContain('reporting');
	});
});

describe('calibrationSummaries', () => {
	// The Calibration page's settings panels (CalibrationSettings.svelte, issue #586 round 3): their lines are theirs
	// alone, and Model settings gives none for them.
	const CAL = ['set-flow', 'set-record', 'set-fit', 'set-wr2012'] as const;
	it('gives the four panels on Calibration their lines, and Model settings none of them', () => {
		const own = calibrationSummaries(cal());
		expect(Object.keys(own).sort()).toEqual([...CAL].sort());
		expect(own['set-record']).toBe('The whole flow record · at the outlet');
		// The rules' state, not the header's fit line again (issue #586, C19).
		expect(own['set-fit']).toBe('Calibration rules revision 1 · draft, not signed off');
		expect(calibrationSummaries(cal({ calibrationRules: { ...defaultProjectSettings().calibrationRules!, revision: 3, signedOff: { by: 'A. Hydrologist', on: '2026-09-29' } } }))['set-fit']).toBe(
			'Calibration rules revision 3 · signed off by A. Hydrologist'
		);
		expect(calibrationSummaries(cal({ calibrationRules: undefined }))['set-fit']).toBe('No calibration rules');
		expect(own['set-wr2012']).toBe('Off: runs aren’t compared with WR2012');
		const page = settingsSummaries(base());
		for (const id of CAL) expect(page[id], id).toBeUndefined();
	});

	it('reads only what the calibration panels have (no EWR figures)', () => {
		expect(calibrationSummaries(cal())['set-flow']).toContain('· 70 km² · PE ');
	});
});
