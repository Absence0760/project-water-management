import { describe, expect, it } from 'vitest';
import { defaultDataQualitySettings, defaultProjectSettings } from '@water-management/engine';
import { changedLimits, dateSpan, settingsSummaries, type SummaryInput } from './summaries';

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
		expect(s['set-share']).toBe('By catchment area');
		expect(s['set-restrict']).toBe('Off');
		expect(s['set-record']).toBe('The whole flow record · at the outlet');
		expect(s['set-fit']).toBe('GR4J · no fit record: the parameters were set by hand or imported');
		expect(s['set-wr2012']).toBe('Off: runs aren’t compared with WR2012');
		expect(s['set-reserve']).toBe('');
		expect(s['set-evidence']).toBe('No uncertainty rule declared');
		expect(s['set-auto']).toBe('Off: runs only when someone runs the model');
		expect(s['set-ewr']).toBe('Pragmatic EWR at the outflow gauge · 12.598 Mm³ a year · registered volumes: compare only');
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
				autoRun: { enabled: true, debounceMinutes: 30, publish: 'never' }
			}),
			siteName: 'Melkhout Gauge'
		});
		expect(s['set-period']).toBe('1 Oct 2015 – 30 Sep 2020');
		expect(s['set-rain']).toBe('Raw CHIRPS fills gaps · zero runs treated as missing');
		expect(s['set-demand']).toMatch(/^A-pan 1\s?230 mm a year · effective rain/);
		expect(s['set-share']).toBe('High/low MAP split, 60% / 40%');
		expect(s['set-record']).toBe('from 1 Oct 2001 · at Melkhout Gauge · 1 period left out');
		expect(s['set-auto']).toBe('On: 30 minutes after new data, never publishes');
	});

	it('names rain for each unit in Flow generation only while it is on (issue #482)', () => {
		expect(settingsSummaries(base())['set-flow']).not.toContain('rain for each unit');
		expect(settingsSummaries(base({ unitRain: { mode: 'catchment' } }))['set-flow']).not.toContain('rain for each unit');
		expect(settingsSummaries(base({ unitRain: { mode: 'perUnit' } }))['set-flow']).toMatch(/ · rain for each unit$/);
	});
});
