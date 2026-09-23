import { describe, expect, it } from 'vitest';
import {
	attachment,
	BOM,
	collectCsv,
	csvRow,
	dailyCsvLines,
	dayRange,
	exportFilename,
	numCell,
	seriesHeader,
	slugify,
	textCell
} from './csv.js';

describe('csv cells', () => {
	it('quotes per RFC 4180', () => {
		expect(textCell('plain')).toBe('plain');
		expect(textCell('a,b')).toBe('"a,b"');
		expect(textCell('say "hi"')).toBe('"say ""hi"""');
		expect(textCell('two\nlines')).toBe('"two\nlines"');
		expect(textCell('cr\r')).toBe('"cr\r"');
	});

	it('defuses spreadsheet formulas in text cells', () => {
		expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(textCell('+1')).toBe("'+1");
		expect(textCell('-dam')).toBe("'-dam");
		expect(textCell('@sum')).toBe("'@sum");
		expect(textCell('Dam = full')).toBe('Dam = full');
	});

	it('writes numbers as numbers and missing values as empty', () => {
		expect(numCell(-12.5)).toBe('-12.5');
		expect(numCell(0)).toBe('0');
		expect(numCell(null)).toBe('');
		expect(numCell(undefined)).toBe('');
		expect(numCell(NaN)).toBe('');
		expect(numCell(Infinity)).toBe('');
		expect(csvRow(['Farm, north', -3, null, 'x'])).toBe('"Farm, north",-3,,x');
	});

	it('labels series columns with their unit', () => {
		expect(seriesHeader('Dam storage', 'm³')).toBe('Dam storage (m³)');
		expect(seriesHeader('Summer flag', '')).toBe('Summer flag');
	});
});

describe('daily table', () => {
	it('writes ISO dates across month/leap boundaries and honours the window', () => {
		const lines = [
			...dailyCsvLines('2024-02-28', [{ header: 'Flow (m³/day)', values: [1, null, 3, 4] }], { offset: 1, days: 2 })
		];
		expect(lines).toEqual(['date,Flow (m³/day)', '2024-02-29,', '2024-03-01,3']);
	});

	it('is independent of the server timezone', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
		try {
			const lines = [...dailyCsvLines('2000-01-01', [{ header: 'x', values: [1] }], { offset: 0, days: 1 })];
			expect(lines[1]).toBe('2000-01-01,1');
		} finally {
			process.env.TZ = tz;
		}
	});

	it('clamps from/to windows to the series', () => {
		expect(dayRange('2020-01-01', 10)).toEqual({ offset: 0, days: 10 });
		expect(dayRange('2020-01-01', 10, '2020-01-03', '2020-01-04')).toEqual({ offset: 2, days: 2 });
		expect(dayRange('2020-01-01', 10, '2019-01-01', '2030-01-01')).toEqual({ offset: 0, days: 10 });
		expect(dayRange('2020-01-01', 10, '2021-01-01')).toBeNull();
		expect(dayRange('2020-01-01', 10, undefined, '2019-12-31')).toBeNull();
	});
});

describe('collectCsv', () => {
	it('prefixes a UTF-8 BOM and ends every record with CRLF', () => {
		expect(collectCsv(['a,b', '1,2'])).toBe(`${BOM}a,b\r\n1,2\r\n`);
	});

	it('returns null as soon as the body would exceed the cap (counting UTF-8 bytes)', () => {
		expect(collectCsv(['m³'], 3 + 3 + 2)).toBe(`${BOM}m³\r\n`); // BOM 3 + "m³" 3 + CRLF 2
		expect(collectCsv(['m³'], 7)).toBeNull();
		let pulled = 0;
		function* many() {
			for (;;) {
				pulled++;
				yield 'x'.repeat(100);
			}
		}
		expect(collectCsv(many(), 1000)).toBeNull();
		expect(pulled).toBeLessThan(20); // stops early instead of building everything
	});

	it('sizes a full Client Catchment node export well under the cap', () => {
		// 16 161 days × 13 series of 7-digit volumes: the documented worst realistic case.
		const cols = Array.from({ length: 13 }, (_, i) => ({ header: `Series ${i} (m³/day)`, values: new Array(16_161).fill(1234567) }));
		const body = collectCsv(dailyCsvLines('1981-01-01', cols, { offset: 0, days: 16_161 }));
		expect(body).not.toBeNull();
		expect(Buffer.byteLength(body!, 'utf8')).toBeLessThan(2 * 1024 * 1024);
	});
});

describe('file names', () => {
	it('slugifies to safe ASCII', () => {
		expect(slugify('Client Catchment (v2)')).toBe('client-catchment-v2');
		expect(slugify('Élandsbaai — Dam #3')).toBe('elandsbaai-dam-3');
		expect(slugify('***', 'project')).toBe('project');
		expect(slugify('a'.repeat(100)).length).toBe(60);
	});

	it('uses the UTC date, not the server-local one', () => {
		const now = new Date('2026-03-31T23:30:00Z');
		expect(exportFilename('Client Catchment', ['Baseline', 'daily'], 'csv', now)).toBe('client-catchment_baseline_daily_2026-03-31.csv');
		expect(exportFilename('', ['project'], 'json', now)).toBe('project_project_2026-03-31.json');
	});

	it('builds an attachment header without injectable characters', () => {
		expect(attachment('a_b-1.csv')).toBe('attachment; filename="a_b-1.csv"');
		expect(attachment('x"; y\r\n.csv')).toBe('attachment; filename="x___y__.csv"');
	});
});
