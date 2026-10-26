import { describe, expect, it } from 'vitest';
import { defaultDataQualitySettings, defaultProjectSettings } from '@water-management/engine';
import { calibrationSummaries, changedLimits, dateSpan, settingsSummaries, type SummaryInput } from './summaries';

const base = (patch: Partial<SummaryInput['s']> = {}): SummaryInput => ({
	s: { ...defaultProjectSettings(), ...patch } as SummaryInput['s'],
	unitAreaKm2: 70,
	peAnnualMm: 1200,
	ewrAnnualMm3: 12.598,
	ewrSource: 'Pragmatic EWR at the outflow gauge',
	fit: 'GR4J · no fit record: the parameters were set by hand or imported'
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
		expect(s['set-share']).toBe('Fragmentation · flow share: by catchment area');
		expect(s['set-restrict']).toBe('Off');
		expect(s['set-record']).toBe('The whole flow record · at the outlet');
		expect(s['set-fit']).toBe('GR4J · no fit record: the parameters were set by hand or imported');
		expect(s['set-wr2012']).toBe('Off: runs aren’t compared with WR2012');
		expect(s['set-reserve']).toBe('');
		expect(s['set-evidence']).toBe('No uncertainty rule declared');
		expect(s['set-auto']).toBe('Off: runs only when someone runs the model');
		expect(s['set-ewr']).toBe('Pragmatic EWR at the outflow gauge · 12.598 Mm³ a year');
		expect(s['set-reporting']).toBe('Reporting over the whole run · a water year is met at 90 % of demand');
	});

	it('reads the values that are set', () => {
		const s = settingsSummaries({
			...base({
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
			}),
			siteName: 'Melkhout Gauge'
		});
		expect(s['set-period']).toBe('1 Oct 2015 – 30 Sep 2020');
		expect(s['set-rain']).toBe('Raw CHIRPS fills gaps · zero runs treated as missing');
		expect(s['set-demand']).toMatch(/^A-pan 1\s?230 mm a year · effective rain/);
		// The rain threshold for demand lives in Demand (issue #521), so its line names it.
		expect(s['set-demand']).toMatch(/ · rain threshold \d+(\.\d)? mm · /);
		expect(s['set-share']).toBe('Fragmentation · flow share: high/low MAP split, 60% / 40%');
		expect(s['set-record']).toBe('from 1 Oct 2001 · at Melkhout Gauge · 1 period left out · low flows only in 1 period · river stops Feb, Mar, Apr');
		expect(s['set-auto']).toBe('On: 30 minutes after new data, never publishes');
	});

	it('names the flow generation method in the Flow generation summary, with the units on a station (issues #482, #553)', () => {
		expect(settingsSummaries(base())['set-share']).toBe('Fragmentation · flow share: by catchment area');
		expect(settingsSummaries(base({ unitRain: { mode: 'catchment' } }))['set-share']).toMatch(/^Fragmentation · /);
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' } }))['set-share']).toBe('Per unit · no unit on a rainfall station · EWR flow share: by catchment area');
		const units = { a: { stationId: 's' }, b: { stationId: 's' } };
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' }, rainStations: { units } }))['set-share']).toBe('Per unit · 2 units on a rainfall station · EWR flow share: by catchment area');
		// Stations kept from an earlier Per unit don't count under Fragmentation.
		expect(settingsSummaries(base({ rainStations: { units } }))['set-share']).toBe('Fragmentation · flow share: by catchment area');
		// No longer said in Flow calibration's line.
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' } }))['set-flow']).not.toContain('rain for each unit');
		// Round 4: an EWR split other than the flow share.
		expect(settingsSummaries(base({ ewrSplit: 'flowShare' }))['set-share']).toBe('Fragmentation · flow share: by catchment area');
		expect(settingsSummaries(base({ ewrSplit: 'naturalMar', unitRain: { mode: 'perUnit' } }))['set-share']).toBe('Per unit · no unit on a rainfall station · the EWR split by each unit’s natural MAR');
		expect(settingsSummaries(base({ ewrSplit: 'naturalMar' }))['set-share']).toBe('Fragmentation · flow share: by catchment area · the EWR split by natural MAR (the flow share under Fragmentation)');
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
	// The calibration panels' lines (CalibrationSettings.svelte, issue #586) are the page's lines for those panels, so
	// the two halves of the page can't drift apart while they share it.
	const CAL = ['set-flow', 'set-record', 'set-fit', 'set-wr2012'] as const;
	it('gives the four calibration panels exactly the lines settingsSummaries gives them', () => {
		for (const input of [
			base(),
			{ ...base({ calibrationStart: '2001-10-01', calibrationExclusions: [{ start: '2003-01-01', end: '2003-02-01', reason: 'Gauge rebuilt' }] }), siteName: 'Gauge B' }
		]) {
			const own = calibrationSummaries(input);
			const page = settingsSummaries(input);
			expect(Object.keys(own).sort()).toEqual([...CAL].sort());
			for (const id of CAL) expect(own[id]).toBe(page[id]);
		}
	});

	it('reads only what the calibration panels have (no EWR figures)', () => {
		const { s, unitAreaKm2, peAnnualMm, fit } = base();
		expect(calibrationSummaries({ s, unitAreaKm2, peAnnualMm, fit })['set-flow']).toContain('· 70 km² · PE ');
	});
});
