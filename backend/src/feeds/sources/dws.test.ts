import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../errors.js';
import { FIXTURE_DIR } from '../fixtures.js';
import { dwsSiteType, dwsUrl, parseDwsDaily } from './dws.js';

const sample = readFileSync(`${FIXTURE_DIR}dws-sample.html`, 'utf8');
const page = (table: string) => `<html><body><pre>\nStation : X0H000100.00\n\n${table}\n</pre></body></html>`;

describe('dwsUrl', () => {
	it('asks HyData.aspx for daily flow at the station’s 100.00 series', () => {
		const u = new URL(dwsUrl('X0H000', '2021-01-01', '2021-03-01'));
		expect(u.origin + u.pathname).toBe('https://www.dws.gov.za/Hydrology/Verified/HyData.aspx');
		expect(Object.fromEntries(u.searchParams)).toEqual({ Station: 'X0H000100.00', DataType: 'Daily', StartDT: '2021-01-01', EndDT: '2021-03-01', SiteType: 'RIV' });
	});

	it('derives SiteType from the station, and refuses a station that isn’t a river gauge', () => {
		expect(dwsSiteType('X0H000')).toBe('RIV');
		// Archived pages ask for a reservoir with SiteType=RES, a weather station with MET:
		// sending RIV for them would ask the wrong question, so it is never sent.
		expect(() => dwsUrl('X0R000', '2021-01-01', '2021-03-01')).toThrow(/river gauge/);
		expect(() => dwsSiteType('X0E000')).toThrow(/river gauge/);
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

	it('keeps missing dates, a gap row with a blank flow, and a negative flow as gaps (null), never zero', () => {
		expect(r.values[17]).toBeNull(); // 2021-01-18: no row
		expect(r.values[18]).toBeNull(); // 2021-01-19: no row
		expect(r.values[25]).toBeNull(); // 2021-01-26: blank flow, code 170
		expect(r.values[50]).toBeNull(); // 2021-02-20: -1.000, code 152
		expect(r.rejected).toBe(2);
		expect(r.values.filter((v) => v === null)).toHaveLength(4);
	});

	it('counts the quality codes as given, without interpreting them', () => {
		// 58 rows: 53 × 1, 3 × 2, the gap row's 170 and the negative row's 152.
		expect(r.quality).toEqual({ '1': 53, '2': 3, '170': 1, '152': 1 });
	});
});

describe('parseDwsDaily on other pages', () => {
	it('reads a "No data for this period" page as no days, not an error', () => {
		expect(parseDwsDaily(page('No data for this period'))).toEqual({ startDate: null, values: [], quality: {}, rejected: 0, outside: 0 });
		expect(parseDwsDaily('<html><body><p>No data for this period</p></body></html>').values).toEqual([]);
	});

	it('reads a plain-text table (no HTML)', () => {
		expect(parseDwsDaily('DATE D_AVG_FR QUAL\n20210101 1.5 1\n20210102 2 1\n').values).toEqual([1.5, 2]);
	});

	it('decodes entities and <br> line breaks inside the <pre>', () => {
		expect(parseDwsDaily('<pre>DATE&nbsp;D_AVG_FR QUAL<br>20210101 1.5 1<br/>20210102 2 1</pre>').values).toEqual([1.5, 2]);
	});

	it('with a window, drops (and counts) rows dated outside it, before any span or duplicate check', () => {
		const r = parseDwsDaily(page('DATE D_AVG_FR QUAL\n18000101 5 1\n20210101 1.5 1\n20210103 2 60\n20210201 9 1\n20210201 8 1'), { start: '2021-01-01', end: '2021-01-31' });
		expect(r).toEqual({ startDate: '2021-01-01', values: [1.5, null, 2], quality: { '1': 1, '60': 1 }, rejected: 0, outside: 3 });
	});

	it('ignores an HTML comment that mentions a <pre>', () => {
		expect(parseDwsDaily(`<!-- an old <pre>DATE COR_LEVEL QUAL</pre> -->\n${page('DATE D_AVG_FR QUAL\n20210101 1.5 1')}`).values).toEqual([1.5]);
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
			['no QUAL column', page('DATE D_AVG_FR\n20210101 1.5'), /columns changed/],
			['an impossible date', page('DATE D_AVG_FR QUAL\n20210230 1.5 1'), /impossible date/],
			['a date listed twice', page('DATE D_AVG_FR QUAL\n20210101 1.5 1\n20210101 1.6 1'), /twice/],
			['two rows centuries apart', page('DATE D_AVG_FR QUAL\n18000101 1.5 1\n20210101 1.6 1'), /spans more days/]
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

// A row in the fixed-width layout the DWS page declares in its own format block:
// "POS. 1-8 = Date … POS. 10-18 = Daily avg flow rate in cubic metres/sec 99999.999
// POS. 20-24 = Quality code". A gap row leaves columns 10-18 blank.
const row = (date: string, value: string, qual: string) => `${date} ${value.padStart(9)} ${qual.padStart(5)}`.trimEnd();

// The page as the site serves it (layout from an archived HyData.aspx daily page,
// web.archive.org, 2024-05; station and values invented): the <pre> with its
// format block comes before the ASP.NET document, the header is "D AVG F/R",
// and a row of Z's ends the table.
const recorded = (rows: string[], unit = 'Daily avg flow rate in cubic metres/sec 99999.999') =>
	[
		'<p><pre>Data are continuously updated and reviewed.',
		'The format of this file is as follows:',
		'POS.  1-8   = Date of daily flow  CCYYMMDD',
		`POS. 10-18  = ${unit}`,
		'POS. 20-24  = Quality code',
		'',
		'X0H000 (SYNTHETIC WEIR)',
		'Variable 100.00 Surface Water Level',
		'',
		'DATE     D AVG F/R  QUAL',
		...rows,
		'ZZZZZZZZZZZZ',
		'</pre></p>\r',
		'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\r',
		'<html xmlns="http://www.w3.org/1999/xhtml" >\r',
		'<head><title>\r\n\tX0H000100.00\r\n</title></head>\r',
		'<body><form method="post" action="./HyData.aspx?Station=X0H000100.00&amp;DataType=Daily" id="form1"></form></body>\r',
		'</html>\r'
	].join('\n');

describe('parseDwsDaily: a gap row with only a quality code', () => {
	it('reads the code as the quality, not as the flow', () => {
		const r = parseDwsDaily(page(['DATE       D_AVG_FR  QUAL', row('20210101', '1.897', '1'), row('20210102', '', '170'), row('20210103', '2.092', '1')].join('\n')));
		expect(r.values).toEqual([1.897, null, 2.092]);
		expect(r.quality).toEqual({ '1': 2, '170': 1 });
		expect(r.rejected).toBe(1);
	});

	it('reads the recorded layout: blank-flow gap rows under the "D AVG F/R" header', () => {
		const r = parseDwsDaily(recorded([row('19971001', '1.897', '1'), row('19971002', '', '170'), row('19971003', '', '171'), row('19971004', '282.027', '7')]));
		expect(r.values).toEqual([1.897, null, null, 282.027]);
		expect(r.quality).toEqual({ '1': 1, '170': 1, '171': 1, '7': 1 });
	});

	it('keeps a row whose code says the data is missing as a gap, even with a number in the flow column', () => {
		const codes = ['151', '165', '170', '172', '246', '247', '255'];
		const r = parseDwsDaily(recorded([row('20210101', '1.5', '1'), ...codes.map((c, i) => row(`2021010${i + 2}`, '0.000', c))]));
		expect(r.values).toEqual([1.5, ...codes.map(() => null)]);
		expect(r.rejected).toBe(codes.length);
		expect(Object.keys(r.quality).sort()).toEqual(['1', ...codes].sort());
	});

	it('keeps a flagged but real flow (above rating, estimated, extrapolated) as the flow', () => {
		const r = parseDwsDaily(recorded([row('20210101', '9.5', '60'), row('20210102', '8.5', '65'), row('20210103', '7.5', '150'), row('20210104', '0.000', '2')]));
		expect(r.values).toEqual([9.5, 8.5, 7.5, 0]);
		expect(r.rejected).toBe(0);
	});

	it('refuses a page whose format block puts the flow in another unit, or the column to another quantity', () => {
		for (const unit of ['Daily avg flow rate in megalitres/day 99999.999', 'Daily avg flow volume in cubic metres 99999.999', 'Daily avg water level in metres 99999.999']) {
			expect(() => parseDwsDaily(recorded([row('20210101', '1.5', '1')], unit))).toThrow(/not a daily mean flow in m³\/s/);
		}
		expect(parseDwsDaily(recorded([row('20210101', '1.5', '1')], 'Daily avg flow rate in m3/s')).values).toEqual([1.5]);
	});

	it('places rows by date whatever their order, and reads columns against an indented header', () => {
		const table = ['DATE     D AVG F/R  QUAL', row('20210103', '3.000', '1'), row('20210101', '1.000', '1'), row('20210102', '', '255')].map((l) => `   ${l}`).join('\n');
		const r = parseDwsDaily(`<pre>${table}</pre>`);
		expect(r.startDate).toBe('2021-01-01');
		expect(r.values).toEqual([1, null, 3]);
		expect(r.quality).toEqual({ '1': 2, '255': 1 });
	});

	it('still reads a lone number in the flow column as the flow', () => {
		const r = parseDwsDaily(page(['DATE       D_AVG_FR  QUAL', row('20210101', '12', ''), row('20210102', '0.5', '')].join('\n')));
		expect(r.values).toEqual([12, 0.5]);
		expect(r.quality).toEqual({});
	});
});

// The synthetic export the manual series import is tested with too
// (frontend/src/lib/series/dws.test.ts): both read rows through the engine's
// parseDwsRow, so the feed and a hand upload of the same table agree day by day.
describe('parseDwsDaily on the shared DWS export fixture', () => {
	const shared = readFileSync(new URL('../../../../packages/engine/fixtures/dws-daily-export.txt', import.meta.url), 'utf8');

	it('reads the same days as the manual import: coded-missing, -999 and absent days are gaps', () => {
		const r = parseDwsDaily(shared);
		expect(r.startDate).toBe('2021-01-01');
		expect(r.values).toEqual([0.412, 0.398, 1.897, null, null, null, 12.5, 0.371, null, 0.355, 0.349]);
		expect(r.rejected).toBe(3);
		expect(r.quality).toEqual({ '1': 6, '2': 1, '60': 1, '170': 1, '255': 1 });
	});
});
