import { describe, expect, it } from 'vitest';
import { csvCells, parseDailyCsv } from './dailyTable';

describe('csvCells', () => {
	it('splits plain and RFC 4180 quoted cells', () => {
		expect(csvCells('date,a,b')).toEqual(['date', 'a', 'b']);
		expect(csvCells('date,"Farm, ""upper"" [I] (m³/day)",Farm 2')).toEqual(['date', 'Farm, "upper" [I] (m³/day)', 'Farm 2']);
		expect(csvCells('a,,')).toEqual(['a', '', '']);
		expect(() => csvCells('"open')).toThrow(/unterminated/);
	});
});

describe('parseDailyCsv', () => {
	it('reads the export back: BOM, CRLF, headers, dates, numbers and empty cells', () => {
		const t = parseDailyCsv('﻿date,"Farm, upper [I] (m³/day)",Farm 2 [I] (m³/day)\r\n2024-02-28,1.5,\r\n2024-02-29,0,2e3\r\n');
		expect(t).toEqual({
			comment: null,
			headers: ['Farm, upper [I] (m³/day)', 'Farm 2 [I] (m³/day)'],
			dates: ['2024-02-28', '2024-02-29'],
			columns: [
				[1.5, 0],
				[null, 2000]
			]
		});
	});

	it('keeps a legacy run’s leading comment apart from the table', () => {
		const t = parseDailyCsv('﻿# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\ndate,A\r\n2024-01-01,3\r\n');
		expect(t.comment).toBe('runoff_model=legacy; workbook comparison only; not evidence (audit H1)');
		expect(t.headers).toEqual(['A']);
		expect(t.columns).toEqual([[3]]);
	});

	it('undoes the CSV-injection guard on a name, and refuses what is not a daily table', () => {
		expect(parseDailyCsv("date,'=Farm [I] (m³/day)\r\n").headers).toEqual(['=Farm [I] (m³/day)']);
		expect(() => parseDailyCsv('')).toThrow(/empty/);
		expect(() => parseDailyCsv('Project,Demo\r\n')).toThrow(/not a daily table/);
	});
});
