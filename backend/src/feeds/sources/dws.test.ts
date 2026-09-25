import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../errors.js';
import { FIXTURE_DIR } from '../fixtures.js';
import { dwsUrl, parseDwsDaily } from './dws.js';

const sample = readFileSync(`${FIXTURE_DIR}dws-sample.html`, 'utf8');
const page = (table: string) => `<html><body><pre>\nStation : X0H000100.00\n\n${table}\n</pre></body></html>`;

describe('dwsUrl', () => {
	it('asks HyData.aspx for daily flow at the station’s 100.00 series', () => {
		const u = new URL(dwsUrl('X0H000', '2021-01-01', '2021-03-01'));
		expect(u.origin + u.pathname).toBe('https://www.dws.gov.za/Hydrology/Verified/HyData.aspx');
		expect(Object.fromEntries(u.searchParams)).toEqual({ Station: 'X0H000100.00', DataType: 'Daily', StartDT: '2021-01-01', EndDT: '2021-03-01', SiteType: 'RIV' });
	});
});

describe('parseDwsDaily on the fixture page', () => {
	const r = parseDwsDaily(sample);

	it('places each row by its date, from the first to the last', () => {
		expect(r.startDate).toBe('2021-01-01');
		expect(r.values).toHaveLength(60); // 2021-01-01 … 2021-03-01
		expect(r.values[0]).toBe(0.359);
		expect(r.values.at(-1)).toBe(0.421);
	});

	it('keeps missing dates, a row with only a date, and a negative flow as gaps (null), never zero', () => {
		expect(r.values[17]).toBeNull(); // 2021-01-18: no row
		expect(r.values[18]).toBeNull(); // 2021-01-19: no row
		expect(r.values[25]).toBeNull(); // 2021-01-26: only a date
		expect(r.values[50]).toBeNull(); // 2021-02-20: -1.000
		expect(r.rejected).toBe(2);
		expect(r.values.filter((v) => v === null)).toHaveLength(4);
	});

	it('counts the quality codes as given, without interpreting them', () => {
		// 58 rows: 53 × 1, 3 × 2, the negative row's 170, and the date-only row with no code.
		expect(r.quality).toEqual({ '1': 53, '2': 3, '170': 1 });
	});
});

describe('parseDwsDaily on other pages', () => {
	it('reads a "No data for this period" page as no days, not an error', () => {
		expect(parseDwsDaily(page('No data for this period'))).toEqual({ startDate: null, values: [], quality: {}, rejected: 0 });
		expect(parseDwsDaily('<html><body><p>No data for this period</p></body></html>').values).toEqual([]);
	});

	it('reads a plain-text table (no HTML)', () => {
		expect(parseDwsDaily('DATE D_AVG_FR QUAL\n20210101 1.5 1\n20210102 2 1\n').values).toEqual([1.5, 2]);
	});

	it('decodes entities and <br> line breaks inside the <pre>', () => {
		expect(parseDwsDaily('<pre>DATE&nbsp;D_AVG_FR QUAL<br>20210101 1.5 1<br/>20210102 2 1</pre>').values).toEqual([1.5, 2]);
	});

	it('ignores lines that are not dated rows (headings, totals, footers)', () => {
		const r = parseDwsDaily(page('DATE D_AVG_FR QUAL\n20210101 1.5 1\nTotal      1.5\n20210102 2.5 1\n-- end --'));
		expect(r.values).toEqual([1.5, 2.5]);
	});

	describe('fails loudly (FeedFormatError) rather than write garbage', () => {
		const cases: [string, string, RegExp][] = [
			['the server’s ScriptServer error page (HTTP 200)', '<html><body>Client unable to establish connection to ScriptServerODBC</body></html>', /server error page/],
			['an HTML page with no table', '<html><body><h1>Access denied</h1></body></html>', /no data table/],
			['a table without a DATE header', page('20210101 1.5 1'), /no DATE header/],
			['changed columns', page('DATE COR_LEVEL QUAL\n20210101 1.5 1'), /columns changed/],
			['an impossible date', page('DATE D_AVG_FR QUAL\n20210230 1.5 1'), /impossible date/],
			['a date listed twice', page('DATE D_AVG_FR QUAL\n20210101 1.5 1\n20210101 1.6 1'), /twice/]
		];
		it.each(cases)('%s', (_, body, message) => {
			expect(() => parseDwsDaily(body)).toThrow(FeedFormatError);
			expect(() => parseDwsDaily(body)).toThrow(message);
		});
	});

	it('treats non-numeric values as gaps', () => {
		const r = parseDwsDaily(page('DATE D_AVG_FR QUAL\n20210101 abc 1\n20210102 1e400 1\n20210103 NaN 1\n20210104 3 1'));
		expect(r.values).toEqual([null, null, null, 3]);
		expect(r.rejected).toBe(3);
	});
});
