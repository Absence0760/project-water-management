import { describe, expect, it } from 'vitest';
import { blockCommas, numberReader, readPastedBlock, splitCsvRow } from './read';

describe('readPastedBlock', () => {
	it('splits a spreadsheet copy on tabs, keeping a leading blank cell in its column', () => {
		const b = readPastedBlock('Upper farm\t12,5\t3\r\n\t4\t5\r\n');
		expect(b.separator).toBe('tab');
		expect(b.decimalComma).toBe(true);
		expect(b.cells).toEqual([
			['Upper farm', '12,5', '3'],
			['', '4', '5']
		]);
	});

	it('reads a CSV with quoted cells, where the comma separates and is no decimal comma', () => {
		const b = readPastedBlock('﻿Name,"Area (km²)"\n"Smith, J",12\n"Say ""hi""",3\n');
		expect(b.separator).toBe('comma');
		expect(b.decimalComma).toBe(false);
		expect(b.cells).toEqual([
			['Name', 'Area (km²)'],
			['Smith, J', '12'],
			['Say "hi"', '3']
		]);
	});

	it('reads semicolons (a European CSV) with decimal commas', () => {
		const b = readPastedBlock('a;1,5\nb;2');
		expect(b.separator).toBe('semicolon');
		expect(b.decimalComma).toBe(true);
	});

	it('splits on spaces only when asked (a table from a PDF); a grid keeps one cell a line', () => {
		expect(readPastedBlock('  1 2  3 ', { spaces: true }).cells).toEqual([['1', '2', '3']]);
		expect(readPastedBlock('Upper farm\nLower farm').cells).toEqual([['Upper farm'], ['Lower farm']]);
		// With spaces, a comma is a separator only in a CSV of numbers.
		expect(readPastedBlock('1,5 2', { spaces: true }).separator).toBe('space');
		expect(readPastedBlock('1,5,2,5', { spaces: true }).separator).toBe('comma');
	});

	it('drops blank lines', () => {
		expect(readPastedBlock('\n\na\tb\n\n').cells).toEqual([['a', 'b']]);
	});
});

describe('numberReader', () => {
	it('reads decimal commas and grouping spaces, and says when it read a comma', () => {
		const r = numberReader(true);
		expect(r.read('300 000')).toBe(300000);
		expect(r.read('1 500')).toBe(1500);
		expect(r.sawComma).toBe(false);
		expect(r.read('12,5')).toBe(12.5);
		expect(r.sawComma).toBe(true);
		expect(r.read('')).toBeNaN();
		expect(r.read('abc')).toBeNaN();
		// Two commas are no decimal comma.
		expect(r.read('1,500,000')).toBeNaN();
	});

	it('leaves a comma alone in a CSV', () => {
		expect(numberReader(false).read('12,5')).toBeNaN();
	});
});

describe('splitCsvRow', () => {
	it('keeps an empty last cell', () => {
		expect(splitCsvRow('a,b,')).toEqual(['a', 'b', '']);
	});
});

describe('blockCommas', () => {
	it('reads a decimal comma from a cell that can only be one', () => {
		expect(blockCommas(['12,5', '300'])).toBe('decimal');
		expect(blockCommas(['0,750'])).toBe('decimal');
		expect(blockCommas(['1234,567'])).toBe('decimal');
	});
	it('reads thousands separators from a cell that can only have them', () => {
		expect(blockCommas(['1,500,000', '300,000'])).toBe('grouping');
		expect(blockCommas(['1,234.5'])).toBe('grouping');
	});
	it('refuses to guess at a lone three-digit group, and at a block with both', () => {
		expect(blockCommas(['300,000', '12'])).toEqual({ ambiguous: '300,000' });
		expect(blockCommas(['12,5', '1,500,000'])).toEqual({ mixed: ['12,5', '1,500,000'] });
	});
	it('is decimal (nothing to decide) without commas in numbers; names are not numbers', () => {
		expect(blockCommas(['Smith, J', '12'])).toBe('decimal');
	});
	it('reads grouped numbers in grouping mode', () => {
		const r = numberReader('grouping');
		expect(r.read('1,500,000')).toBe(1500000);
		expect(r.read('1,234.5')).toBe(1234.5);
		expect(r.read('12,5')).toBeNaN();
		expect(r.sawComma).toBe(true);
	});
});
