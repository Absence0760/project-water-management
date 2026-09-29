import { describe, expect, it } from 'vitest';
import { FARM_CSV_COLUMNS, farmCsvForReader, withNoteLine } from './csvNote';

describe('withNoteLine', () => {
	it('puts the note first, after the BOM, as one # line, and keeps the file as it was after it', () => {
		const csv = '﻿date,Supplied (m³/day)\r\n2024-01-01,3\r\n';
		expect(withNoteLine(csv, 'Estimates,\nnot measurements.')).toBe('﻿# Estimates, not measurements.\r\ndate,Supplied (m³/day)\r\n2024-01-01,3\r\n');
		// Blob.text() drops the BOM: it is put back.
		expect(withNoteLine('date\r\n', 'x')).toBe('﻿# x\r\ndate\r\n');
	});
});

describe('farmCsvForReader (issue #124)', () => {
	const api = '﻿date,demand,supplied,deficit,dam_storage,spill,transfer,new_key\r\n2024-01-01,250,100,150,12000,0,-50,1.5\r\n2024-01-02,,,,,,,\r\n';
	const english = { note: 'Estimates.', column: (m: string) => m, decimalMark: '.' as const };

	it('names every farm column the API sends in plain words with its unit, and leaves an unknown key as sent', async () => {
		const { FARMER_SERIES_KEYS } = await import('@water-management/engine');
		for (const k of ['date', ...FARMER_SERIES_KEYS]) expect(FARM_CSV_COLUMNS[k], k).toBeTruthy();
		const lines = farmCsvForReader(api, english).split('\r\n');
		expect(lines[0]).toBe('﻿# Estimates.');
		expect(lines[1]).toBe(
			'Date,Water you needed (m³/day),Water you received (m³/day),Water you were short (m³/day),Water in your dam (m³),Water that spilled from your dam (m³/day),Water transferred in (+) or out (−) (m³/day),new_key'
		);
		// No workbook letters, no series keys.
		expect(lines[1]).not.toMatch(/\[[A-Z]+\]|dam_storage|supplied/);
		// English keeps the API's commas and points.
		expect(lines.slice(2)).toEqual(['2024-01-01,250,100,150,12000,0,-50,1.5', '2024-01-02,,,,,,,', '']);
	});

	it('writes a decimal-comma language (af-ZA) with ; between cells and a decimal comma, in that language’s words', () => {
		const out = farmCsvForReader(api, { note: 'Skattings, nie metings nie.', column: (m) => `[af] ${m}`, decimalMark: ',' });
		expect(out.startsWith('﻿# Skattings, nie metings nie.\r\n')).toBe(true);
		const lines = out.split('\r\n');
		expect(lines[1]!.split(';')).toHaveLength(8);
		expect(lines[1]!.split(';')[0]).toBe('[af] Date');
		expect(lines[2]).toBe('2024-01-01;250;100;150;12000;0;-50;1,5');
		expect(lines[3]).toBe('2024-01-02;;;;;;;');
	});

	it('quotes a translated name that holds the separator or a quote', () => {
		const out = farmCsvForReader('date\r\n', { note: 'x', column: () => 'Datum; "dag"', decimalMark: ',' });
		expect(out.split('\r\n')[1]).toBe('"Datum; ""dag"""');
	});
});
