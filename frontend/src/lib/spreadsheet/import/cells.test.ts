import { describe, expect, it } from 'vitest';
import { hasNameControlChars } from '@water-management/engine';
import { XlDateTime, XlDuration, XlTime, clean, columnIndex, columnLetter, isName, isNumeric, num, pyFloat, pyFloatRepr, pyFormatG, pyRepr, pyStr } from './cells';

// Expected strings are what CPython 3.12 prints for the same values.
describe('Python formatting', () => {
	it("format(x, 'g')", () => {
		const cases: [number, string][] = [
			[0.3, '0.3'],
			[1234567, '1.23457e+06'],
			[0.0001, '0.0001'],
			[0.00001234, '1.234e-05'],
			[100000, '100000'],
			[1e16, '1e+16'],
			[0.8, '0.8'],
			[2, '2'],
			[1234565, '1.23456e+06'], // an exact tie rounds half to even
			[-0, '-0'],
			[999999.5, '1e+06'],
			[0.30000000000000004, '0.3'],
			[123456.7, '123457'],
			[NaN, 'nan'],
			[-Infinity, '-inf']
		];
		for (const [x, s] of cases) expect(pyFormatG(x), String(x)).toBe(s);
	});

	it('repr(float)', () => {
		const cases: [number, string][] = [
			[1e16, '1e+16'],
			[1e-5, '1e-05'],
			[0.0001, '0.0001'],
			[123, '123.0'],
			[1.5e300, '1.5e+300'],
			[9999999999999998, '9999999999999998.0'],
			[0.1 + 0.2, '0.30000000000000004'],
			[-2.5e-7, '-2.5e-07']
		];
		for (const [x, s] of cases) expect(pyFloatRepr(x), String(x)).toBe(s);
	});

	it('str() and repr() of cell values', () => {
		expect(pyStr(11)).toBe('11'); // openpyxl reads "11" as an int
		expect(pyStr(0.5)).toBe('0.5');
		expect(pyStr(true)).toBe('True');
		expect(pyStr(null)).toBe('None');
		expect(pyRepr("it's")).toBe('"it\'s"');
		expect(pyRepr('a b​c\n')).toBe("'a\\xa0b\\u200bc\\n'");
		expect(pyRepr('both\'"')).toBe("'both\\'\"'");
		expect(pyRepr('tab\there')).toBe("'tab\\there'");
		expect(pyRepr('\\back')).toBe("'\\\\back'");
		expect(pyRepr('café 😀')).toBe("'café 😀'");
		expect(pyRepr('\x7f\x85')).toBe("'\\x7f\\x85'");
		expect(pyRepr([1, 2])).toBe('[1, 2]');
		expect(pyRepr(['a', 'b'])).toBe("['a', 'b']");
		expect(pyRepr(new XlDateTime('2010-01-10', 0))).toBe('datetime.datetime(2010, 1, 10, 0, 0)');
		expect(pyStr(new XlDateTime('2010-01-10', 3 * 3600_000 + 4 * 60_000 + 5120))).toBe('2010-01-10 03:04:05.120000');
		expect(pyRepr(new XlTime(0))).toBe('datetime.time(0, 0)');
		expect(pyStr(new XlDuration(-1 + 5 / 86400))).toBe('-1 day, 0:00:05');
		expect(pyStr(new XlDuration(2 + 1 / 24))).toBe('2 days, 1:00:00');
		expect(pyRepr(new XlDuration(1 + 1 / 24))).toBe('datetime.timedelta(days=1, seconds=3600)');
	});
});

describe('the importer coercions', () => {
	it('float() accepts what Python accepts', () => {
		expect(pyFloat(' 4320 ')).toBe(4320);
		expect(pyFloat('1_000.5')).toBe(1000.5);
		expect(pyFloat('.5')).toBe(0.5);
		expect(pyFloat('5.')).toBe(5);
		expect(pyFloat('-1e3')).toBe(-1000);
		expect(pyFloat('inf')).toBe(Infinity);
		expect(pyFloat('-Infinity')).toBe(-Infinity);
		expect(pyFloat('nan')).toBeNaN();
		for (const bad of ['', ' ', 'n/a', '0x10', '1,5', '1e', '#N/A', '1__0', '_1']) expect(pyFloat(bad), bad).toBeNull();
	});

	it('num(): blanks are 0, text that is a number reads, anything else is the fallback', () => {
		expect(num(null)).toBe(0);
		expect(num('')).toBe(0);
		expect(num(null, 0.65)).toBe(0.65);
		expect(num(true)).toBe(1);
		expect(num('4320')).toBe(4320);
		expect(num('#DIV/0!')).toBe(0);
		expect(num(new XlDateTime('2010-01-01', 0), 7)).toBe(7);
		expect(isNumeric('4320')).toBe(true);
		expect(isNumeric('n/a')).toBe(false);
		expect(isNumeric(null)).toBe(false);
	});

	it('clean() collapses whitespace like Python, and treats 0 and False as blank', () => {
		expect(clean('  Echo \t\n  Farm ')).toBe('Echo Farm');
		expect(clean('a  b')).toBe('a b');
		expect(clean('a﻿b')).toBe('a﻿b'); // not whitespace to Python
		expect(clean(0)).toBe('');
		expect(clean(false)).toBe('');
		expect(clean(NaN)).toBe('nan');
		expect(clean(12)).toBe('12');
	});

	// The same cases as scripts/wbt-import/test_clean.py (issue #385): a name is one line, as the app requires.
	it.each([
		['Golf\nFarm', 'Golf Farm'],
		['Golf\r\nFarm\n', 'Golf Farm'],
		['Echo\t\tFarm', 'Echo Farm'],
		['\x01Alpha\x07 Farm\x1b', 'Alpha Farm'],
		['Vines\x9fD', 'Vines D'],
		['a\x7fb', 'a b'],
		['a\x85b', 'a b'],
		['a\u2028b\u2029c', 'a b c'],
		['Caf\u00e9\u00a0Farm', 'Caf\u00e9 Farm'],
		['a\ufeffb', 'a\ufeffb']
	])('clean() makes %j one line: %j', (raw, want) => {
		expect(clean(raw)).toBe(want);
		expect(hasNameControlChars(clean(raw))).toBe(false);
	});

	it('clean() reads a cell of only control characters as blank', () => {
		expect(clean('\n\x01\x9f')).toBe('');
		expect(isName('\r\n\x1b')).toBe(false);
	});

	it('isName(): not blank, not a | separator, not a -- sentinel', () => {
		expect(isName('Farm A')).toBe(true);
		expect(isName(' | ')).toBe(false);
		expect(isName('-- do NOT delete')).toBe(false);
		expect(isName(null)).toBe(false);
		expect(isName('#N/A')).toBe(true); // as in the Python: an error value reads as a name
	});

	it('column letters', () => {
		expect([1, 26, 27, 52, 703].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'AAA']);
		expect(['A', 'Z', 'AA', 'AZ', 'AAA'].map(columnIndex)).toEqual([1, 26, 27, 52, 703]);
	});
});
