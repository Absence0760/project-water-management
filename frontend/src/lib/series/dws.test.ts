import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSeriesCsv } from './csv';
import { isDwsExport, parseDwsExport } from './dws';
import { parseSeriesFile } from './file';

// Synthetic (invented station and values), shared with the engine's and the DWS feed's
// tests (backend/src/feeds/sources/dws.test.ts), which read the same days from it.
const fixture = readFileSync(new URL('../../../../packages/engine/fixtures/dws-daily-export.txt', import.meta.url), 'utf8');
const EXPECTED = [0.412, 0.398, 1.897, null, null, null, 12.5, 0.371, null, 0.355, 0.349];

describe('a DWS export with bare CR line endings', () => {
	it('is recognised and read day for day like the LF file', () => {
		const cr = fixture.replace(/\r?\n/g, '\r');
		expect(isDwsExport(cr)).toBe(true);
		expect(parseSeriesFile(cr).values).toEqual(EXPECTED);
	});
});

describe('parseDwsExport on the shared fixture', () => {
	const r = parseDwsExport(fixture);

	it('reads the fixed-width YYYYMMDD table the feed reads, day for day', () => {
		expect(r.startDate).toBe('2021-01-01');
		expect(r.endDate).toBe('2021-01-11');
		expect(r.values).toEqual(EXPECTED);
		expect([r.rowCount, r.missingCount, r.dateOrder, r.dateOrderAssumed]).toEqual([7, 4, 'iso', false]);
	});

	it('never imports a missing-data code or a -999: they are gaps, counted by why', () => {
		expect(r.dws).toEqual({
			rows: 10,
			quality: { '1': 6, '2': 1, '60': 1, '170': 1, '255': 1 },
			gaps: { code: 2, blank: 0, negative: 1 },
			gapCodes: { '170': 1, '255': 1 },
			column: 'Daily avg flow rate in cubic metres/sec 99999.999'
		});
		expect(r.values).not.toContain(-999);
		// 20210105 carries 0.000 under code 255: a gap, not a dry day.
		expect(r.values[4]).toBeNull();
	});

	it('reads the same table saved as the web page (its <pre>)', () => {
		const page = `<p><pre>${fixture.replace(/&/g, '&amp;')}</pre></p>\n<!DOCTYPE html><html><head><title>X0H000100.00</title></head><body></body></html>`;
		expect(isDwsExport(page)).toBe(true);
		expect(parseSeriesFile(page).values).toEqual(EXPECTED);
	});
});

describe('parseDwsExport on other exports', () => {
	it('reads headerless whitespace rows (date, value, quality), a tab-separated one too', () => {
		const r = parseSeriesFile('20210101  1.5  1\n20210102  -999  1\n20210103\t2.25\t60\n');
		expect(r.values).toEqual([1.5, null, 2.25]);
		expect(r.dws!.gaps).toEqual({ code: 0, blank: 0, negative: 1 });
	});

	it('reads NA as a blank, and counts a blank-value gap row', () => {
		const r = parseDwsExport('DATE     D AVG F/R  QUAL\n20210101        NA     1\n20210102               172\n20210103     0.500     1\n');
		expect(r.values).toEqual([null, null, 0.5]);
		expect(r.dws!.gaps).toEqual({ code: 1, blank: 1, negative: 0 });
		expect(r.dws!.gapCodes).toEqual({ '172': 1 });
	});

	it('refuses what it can’t read, with the real reason', () => {
		const table = (rows: string) => `DATE     D AVG F/R  QUAL\n${rows}\n`;
		expect(() => parseDwsExport(table('20210230     1.000     1'))).toThrow('Line 2: "20210230" is not a date (a DWS date is YYYYMMDD)');
		expect(() => parseDwsExport(table('20210101       abc     1'))).toThrow('Line 2: "abc" on 2021-01-01 is not a number');
		expect(() => parseDwsExport(table('20210101     1.000     1\n20210101     2.000     1'))).toThrow('Line 3: duplicate date 2021-01-01');
		expect(() => parseDwsExport('DATE       TIME   COR_LEVEL QUAL\n20210101 0800 1.2 1\n')).toThrow(/has a TIME column/);
		expect(() => parseDwsExport('DATE D_AVG_FR QUAL\nNo data for this period\n')).toThrow(/No data for this period/);
	});
});

describe('isDwsExport / parseSeriesFile', () => {
	it('sends a DWS table to the DWS reader and anything else to the CSV reader', () => {
		expect(isDwsExport(fixture)).toBe(true);
		expect(isDwsExport('20210101 1.5 1\n')).toBe(true);
		// Commas or semicolons make it a CSV, compact dates and all.
		expect(isDwsExport('20210101,1.5\n')).toBe(false);
		expect(isDwsExport('20210101;1,5\n')).toBe(false);
		expect(isDwsExport('date\tvalue\n2021-01-01\t1.5\n')).toBe(false);
		expect(isDwsExport('Date Value\n2021-01-01 1.5\n')).toBe(false);
	});

	it('positive control: an ordinary CSV reads exactly as parseSeriesCsv reads it, with no DWS summary', () => {
		const csv = 'date,value\n2021-10-01,1.5\n2021-10-03,\n2021-10-04,2\n';
		expect(parseSeriesFile(csv)).toEqual(parseSeriesCsv(csv));
		expect(parseSeriesFile(csv).dws).toBeUndefined();
		const hourly = 'time,rain\n2020-01-05 09:00,1\n2020-01-05 10:00,2\n';
		expect(parseSeriesFile(hourly, { dayBoundary: '08:00' })).toEqual(parseSeriesCsv(hourly, { dayBoundary: '08:00' }));
	});
});
