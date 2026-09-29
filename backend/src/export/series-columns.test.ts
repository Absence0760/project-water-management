import { RAIN_SOURCE_CODE, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../projects/settings.js';
import { dailyCsvLines } from './csv.js';
import { seriesExportColumns, type ExportSeries, type ReadingRun } from './series-columns.js';

const settings = (patch: Partial<ProjectSettings> = {}): ProjectSettings => ({ ...mergeSettings({}), ...patch });
const csv = (s: ExportSeries, st: ProjectSettings, run: ReadingRun | null) =>
	[...dailyCsvLines(s.startDate, seriesExportColumns(s, st, run), { offset: 0, days: s.values.length })];

const rain: ExportSeries = { kind: 'rain_catchment_mm', label: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: [12, 0, null, 1.5], siteNodeId: null };
const flow: ExportSeries = { kind: 'flow_observed_m3s', label: 'flow_observed_m3s – Weir', unit: 'm³/s', startDate: '2024-01-01', values: [0.5, null, 2], siteNodeId: null };

/** A run one day longer at the front: its index 1 is the series' first day. */
const run = (inputKey: string, catchment: ReadingRun['catchment'], extra: Partial<ReadingRun> = {}): ReadingRun => ({
	name: 'Baseline',
	startDate: '2023-12-31',
	inputKey,
	rainThresholdMm: 2,
	catchment,
	gaugeFlow: null,
	...extra
});

describe('seriesExportColumns', () => {
	it('without a run: the value as before, then its flags; nothing from a model', () => {
		const lines = csv(rain, settings(), null);
		expect(lines).toEqual(['date,rain_catchment_mm (mm),Flags', '2024-01-01,12,', '2024-01-02,0,', '2024-01-03,,missing', '2024-01-04,1.5,']);
	});

	it('flags a negative day by the engine rules', () => {
		const lines = csv({ ...rain, values: [1, -3, 2] }, settings(), null);
		expect(lines[2]).toBe('2024-01-02,-3,negative');
		expect(lines[1]).toBe('2024-01-01,1,'); // positive control
	});

	it('a flow record: m³/day and the calibration exclusion with its reason', () => {
		const st = settings({ calibrationExclusions: [{ start: '2024-01-02', end: '2024-01-03', reason: 'weir, rebuilt' }] });
		const lines = csv(flow, st, null);
		expect(lines).toEqual([
			'date,flow_observed_m3s – Weir (m³/s),Flags,flow_observed_m3s – Weir (m³/day),Excluded from calibration (reason)',
			'2024-01-01,0.5,,43200,',
			'2024-01-02,,missing,,"weir, rebuilt"',
			'2024-01-03,2,,172800,"weir, rebuilt"'
		]);
	});

	it('a gauge node’s record or the reference gauge: m³/day, never the outlet’s calibration exclusions', () => {
		const st = settings({ calibrationExclusions: [{ start: '2024-01-01', end: '2024-01-03', reason: 'x' }] });
		expect(csv({ ...flow, siteNodeId: 'n1' }, st, null)[0]).toBe('date,flow_observed_m3s – Weir (m³/s),Flags,flow_observed_m3s – Weir (m³/day)');
		expect(csv({ ...flow, kind: 'flow_reference_m3s' }, st, null)[0]).not.toContain('Excluded');
	});

	it('catchment rain a run read: rain used, its source and the rain above the run’s threshold, aligned by date and naming the run', () => {
		const r = run('rain_catchment_mm', {
			rain_final: { label: 'Final catchment rainfall', unit: 'mm', values: [99, 12, 0, 4, 1.5] },
			rain_source: { label: 'Rain source', unit: null, values: [0, RAIN_SOURCE_CODE.catchment, RAIN_SOURCE_CODE.catchment, RAIN_SOURCE_CODE.chirps, RAIN_SOURCE_CODE.catchment] }
		});
		expect(csv(rain, settings(), r)).toEqual([
			'date,rain_catchment_mm (mm),Flags,Rain used [run Baseline] (mm),Rain source [run Baseline],Rain above the 2 mm threshold [run Baseline] (mm)',
			'2024-01-01,12,,12,catchment,12',
			'2024-01-02,0,,0,catchment,0',
			'2024-01-03,,missing,4,CHIRPS,4',
			'2024-01-04,1.5,,1.5,catchment,0'
		]);
	});

	it('a day no source filled is blank in every run column; days past the run are blank', () => {
		const r = run('rain_catchment_mm', {
			rain_final: { label: 'x', unit: 'mm', values: [0, 12, NaN] },
			rain_source: { label: 'x', unit: null, values: [0, 0, NaN] }
		});
		const lines = csv(rain, settings(), r);
		expect(lines[3]).toBe('2024-01-03,,missing,,,');
		expect(lines[4]).toBe('2024-01-04,1.5,,,,');
	});

	it('an older run without a rain_source column or a stored threshold leaves those columns out', () => {
		const r = run('rain_catchment_mm', { rain_final: { label: 'x', unit: 'mm', values: [0, 12, 0, 4, 1.5] } }, { rainThresholdMm: null });
		expect(csv(rain, settings(), r)[0]).toBe('date,rain_catchment_mm (mm),Flags,Rain used [run Baseline] (mm)');
	});

	it('the run’s set-aside and accumulation columns ride along when it has them', () => {
		const r = run('rain_catchment_mm', {
			rain_final: { label: 'x', unit: 'mm', values: [0, 12, 0, 4, 1.5] },
			rain_catchment_missing: { label: 'Set aside', unit: null, values: [0, 0, 1, 1, 0] }
		});
		const lines = csv(rain, settings(), r);
		expect(lines[0]!.endsWith(',Set aside [run Baseline]')).toBe(true);
		expect(lines[2]!.endsWith(',1')).toBe(true);
	});

	it('CHIRPS a run read: the day’s bias factor and the corrected rain', () => {
		const chirps: ExportSeries = { ...rain, kind: 'rain_chirps_mm', label: 'rain_chirps_mm', values: [10, 5] };
		const r = run('rain_chirps_mm', {
			chirps_factor: { label: 'CHIRPS bias factor for the month', unit: '×', values: [1, 1.2, 1.2] },
			rain_chirps_corrected: { label: 'CHIRPS rain bias-corrected (× monthly factor)', unit: 'mm', values: [1, 12, 6] }
		});
		expect(csv(chirps, settings(), r)).toEqual([
			'date,rain_chirps_mm (mm),Flags,CHIRPS bias factor for the month [run Baseline] (×),CHIRPS rain bias-corrected (× monthly factor) [run Baseline] (mm)',
			'2024-01-01,10,,1.2,12',
			'2024-01-02,5,,1.2,6'
		]);
	});

	it('the outlet’s calibration record a run read: the simulated outflow; a gauge’s record: the flow simulated at the gauge', () => {
		const outlet = run('flow_observed_m3s', { simulated_outflow: { label: 'Simulated outflow', unit: 'm³/day', values: [0, 40_000, 50_000, 60_000] } });
		expect(csv(flow, settings(), outlet)[0]!.endsWith(',Simulated outflow [run Baseline] (m³/day)')).toBe(true);
		expect(csv(flow, settings(), outlet)[1]).toBe('2024-01-01,0.5,,43200,,40000');

		const gauge = run('flow_observed_m3s@n1', {}, { gaugeFlow: { label: 'Outflow', unit: 'm³/day', values: [0, 7, 8, 9], gaugeName: 'Upper weir' } });
		const lines = csv({ ...flow, siteNodeId: 'n1' }, settings(), gauge);
		expect(lines[0]!.endsWith(',Simulated flow at Upper weir [run Baseline] (m³/day)')).toBe(true);
		expect(lines[3]).toBe('2024-01-03,2,,172800,9');
	});

	it('a series kind the model doesn’t use from the run gets no run columns', () => {
		const apan: ExportSeries = { ...rain, kind: 'evap_apan_mm', label: 'evap_apan_mm' };
		const r = run('evap_apan_mm', { rain_final: { label: 'x', unit: 'mm', values: [1, 1, 1, 1, 1] } });
		expect(csv(apan, settings(), r)[0]).toBe('date,evap_apan_mm (mm),Flags');
	});

	it('dates stay calendar dates in time zones either side of UTC (rule 7): run alignment and exclusions across a year end', () => {
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone; // UTC+14, UTC-11
				const s: ExportSeries = { ...flow, startDate: '2023-12-31', values: [1, 2] };
				const st = settings({ calibrationExclusions: [{ start: '2024-01-01', end: '2024-01-01', reason: 'new year' }] });
				const r = run('flow_observed_m3s', { simulated_outflow: { label: 'Simulated outflow', unit: 'm³/day', values: [10, 20, 30] } }, { startDate: '2023-12-30' });
				expect(csv(s, st, r).slice(1), zone).toEqual(['2023-12-31,1,,86400,,20', '2024-01-01,2,,172800,new year,30']);
			}
		} finally {
			process.env.TZ = tz;
		}
	});
});
