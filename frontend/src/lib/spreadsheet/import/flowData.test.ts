import { describe, expect, it } from 'vitest';
import { readFlowData } from './flowData';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

const read = (b = syntheticB023()) => {
	const report = new Report();
	return { ...readFlowData(new B023Workbook(b.build()), report), report };
};

describe('readFlowData', () => {
	it('reads the dates and every column with values; empty columns are skipped', () => {
		const f = read(syntheticB023({ rain: [0, 5, 12.5, 0, 1] }));
		expect(f.dates).toEqual(['2010-01-01', '2010-01-02', '2010-01-03', '2010-01-04', '2010-01-05']);
		expect(f.series.map((s) => s.kind)).toEqual(['flow_observed_m3s', 'rain_catchment_mm', 'rain_chirps_mm']);
		expect(f.series[1]).toEqual({ kind: 'rain_catchment_mm', name: 'Rain (mm)', unit: 'mm', startDate: '2010-01-01', values: [0, 5, 12.5, 0, 1] });
		expect(f.pitmanDays).toBe(0);
	});

	it('counts Pitman days but never imports the column', () => {
		const f = read(syntheticB023({ pitman: [1, null, 2, null, 3] }));
		expect(f.pitmanDays).toBe(3);
		expect(f.series.some((s) => (s.kind as string) === 'flow_pitman_m3s')).toBe(false);
	});

	it('stops at zFlowData_DateE_DateSeries and at the first row without a date', () => {
		const b = syntheticB023().set('Flow data', 'C12', { date: '2010-01-03' });
		expect(read(b).dates.length).toBe(3);
		// A date past the named last date is ignored even if more dated rows follow.
		expect(read(syntheticB023().set('Flow data', 'E26', { date: '2010-01-06' })).dates.length).toBe(5);
		expect(read(syntheticB023().set('Flow data', 'C12', null).set('Flow data', 'E24', 'total')).dates.length).toBe(3);
	});

	it('names a column after its kind when the header is blank', () => {
		expect(read(syntheticB023().set('Flow data', 'J19', null)).series[2]!.name).toBe('rain_chirps_mm');
	});

	it('reads text, errors and booleans in a value column as blank, and lists them', () => {
		const b = syntheticB023().set('Flow data', 'G22', 'n/a').set('Flow data', 'G23', { error: 0x07 }).set('Flow data', 'G24', true);
		const f = read(b);
		expect(f.series[0]!.values).toEqual([0.5, null, null, null, 0.9]);
		expect(f.report.unmapped).toEqual([
			expect.objectContaining({ code: 'non-numeric-series-values', cell: 'G22', message: '[Flow data] column G (Gauge (m³/s)) has 3 cells holding text, an error or a date instead of a number, first at G22; imported as blank' })
		]);
	});

	it('reads a date-formatted value as blank, as openpyxl hands the Python a datetime', () => {
		const f = read(syntheticB023().set('Flow data', 'I22', { date: '2010-01-01' }));
		expect(f.series[1]!.values[1]).toBeNull();
	});
});
