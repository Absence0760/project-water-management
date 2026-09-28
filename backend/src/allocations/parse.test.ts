import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ImportRefused,
	matchRow,
	parseAllocationTable,
	parseAuthorisation,
	parseDate,
	parseMonths,
	parseNumber,
	parsePurpose,
	parseWaterSource,
	splitCsv,
	TEMPLATE_HEADERS
} from './parse.js';

const FIXTURE = readFileSync(new URL('./fixtures/warms-synthetic.csv', import.meta.url), 'utf8');
const TEMPLATE = TEMPLATE_HEADERS.join(',');

describe('splitCsv', () => {
	it('reads quoted fields with delimiters, doubled quotes and line breaks, and skips blank lines', () => {
		const rows = splitCsv('a,b\r\n"1,5","say ""hi""\nthere"\n\n3,4', ',');
		expect(rows).toEqual([
			{ line: 1, cells: ['a', 'b'] },
			{ line: 2, cells: ['1,5', 'say "hi"\nthere'] },
			{ line: 5, cells: ['3', '4'] }
		]);
	});

	it('refuses an unterminated quote', () => {
		expect(() => splitCsv('a\n"open', ',')).toThrow(ImportRefused);
	});
});

describe('cell parsers', () => {
	it('reads numbers with thousands separators, and decimal commas in ; files', () => {
		expect(parseNumber('120,000', ',')).toBe(120000);
		expect(parseNumber('12 000.5', ',')).toBe(12000.5);
		expect(parseNumber('12.000,5', ';')).toBe(12000.5);
		expect(parseNumber('', ',')).toBeNull();
		expect(parseNumber('about 5', ',')).toBeNaN();
	});

	it('reads ISO dates only, and only real ones', () => {
		expect(parseDate('2005-06-01')).toBe('2005-06-01');
		expect(parseDate('2005/6/1')).toBe('2005-06-01');
		expect(parseDate('')).toBeNull();
		expect(parseDate('2005-02-30')).toBeUndefined();
		expect(parseDate('01/06/2005')).toBeUndefined();
	});

	it('maps authorisation, purpose and source words', () => {
		expect(parseAuthorisation('Existing lawful use')).toBe('existing_lawful_use');
		expect(parseAuthorisation('WUL')).toBe('licence');
		expect(parseAuthorisation('General Authorisation')).toBe('general_authorisation');
		expect(parseAuthorisation('maybe')).toBeUndefined();
		expect(parsePurpose('Stock watering')).toBe('livestock');
		expect(parsePurpose('Agriculture: irrigation')).toBe('irrigation');
		expect(parsePurpose('Recreation')).toBe('other');
		expect(parseWaterSource('Borehole')).toBe('groundwater');
		expect(parseWaterSource('SW')).toBe('surface');
		expect(parseWaterSource('sea')).toBeUndefined();
	});
});

describe('parseAllocationTable', () => {
	it('reads the synthetic WARMS extract by its headers', () => {
		const t = parseAllocationTable(FIXTURE, 'warms_extract');
		expect(t.delimiter).toBe(',');
		expect(t.ignoredColumns).toEqual([]);
		expect(t.rows).toHaveLength(10);
		expect(t.rows.every((r) => r.errors.length === 0)).toBe(true);
		expect(t.rows[0]).toMatchObject({
			line: 2,
			registrationNo: 'SYN-0001',
			farm: 'Farm A',
			holder: 'Invented Holdings A',
			authorisation: 'registration',
			waterSource: 'surface',
			volumeM3PerYear: 120000,
			storageM3: 150000,
			validFrom: '2000-01-01',
			validTo: null
		});
		expect(t.rows[2]).toMatchObject({ authorisation: 'licence', validTo: '2045-05-31' });
		expect(t.rows[3]).toMatchObject({ purpose: 'livestock', authorisation: 'existing_lawful_use' });
	});

	it('reads a semicolon file with decimal commas', () => {
		const t = parseAllocationTable('registration_no;farm;authorisation;water_source;volume_m3_year\nR1;Farm A;licence;surface;1.500,5\n', 'csv');
		expect(t.delimiter).toBe(';');
		expect(t.rows[0]!.volumeM3PerYear).toBe(1500.5);
	});

	it('refuses personal-information columns (POPIA minimisation)', () => {
		for (const h of ['ID Number', 'Identity No', 'Cell phone', 'Telephone', 'E-mail', 'Tel'])
			expect(() => parseAllocationTable(`${TEMPLATE},${h}\n`, 'csv'), h).toThrow(/personal-information/);
	});

	it('refuses a file with no volume column, or an empty one', () => {
		expect(() => parseAllocationTable('registration_no,farm\nR1,A\n', 'csv')).toThrow(/no volume column/);
		expect(() => parseAllocationTable('', 'csv')).toThrow(/empty/);
	});

	it('lists row problems and keeps the rest', () => {
		const text = [
			TEMPLATE,
			'R1,,Farm A,,licence,irrigation,surface,100,,,,',
			'R2,,Farm A,,,irrigation,surface,100,,,,',
			'R3,,Farm A,,licence,irrigation,lake,-5,,2020-01-01,2019-01-01,',
			',,,,licence,irrigation,surface,100,,,,',
			'R5,,Farm A,8001015009087,licence,irrigation,surface,100,,,,'
		].join('\n');
		const [ok, noAuth, bad, noKey, idNumber] = parseAllocationTable(text, 'csv').rows;
		expect(ok!.errors).toEqual([]);
		expect(noAuth!.errors).toEqual(['authorisation is missing']);
		expect(bad!.errors.join('; ')).toMatch(/unknown water source “lake”.*volume “-5”.*valid from is after valid to/);
		expect(noKey!.errors).toEqual(['the row has no registration number, property or farm to match it by']);
		expect(idNumber!.errors[0]).toMatch(/looks like an ID number/);
	});

	it('keeps a formula-looking cell as text (the export quotes it)', () => {
		const t = parseAllocationTable(`${TEMPLATE}\nR1,,Farm A,=HYPERLINK("x"),licence,irrigation,surface,100,,,,@cmd`, 'csv');
		expect(t.rows[0]).toMatchObject({ holder: '=HYPERLINK("x")', reference: '@cmd', errors: [] });
	});

	it('lists columns it does not read', () => {
		expect(parseAllocationTable(`${TEMPLATE},Catchment\n`, 'csv').ignoredColumns).toEqual(['Catchment']);
	});
});

describe('licence conditions (100, issue #72)', () => {
	it('reads months as numbers, names and ranges over the new year', () => {
		expect(parseMonths('')).toBeNull();
		expect(parseMonths('10 11 12 1 2 3')).toEqual([1, 2, 3, 10, 11, 12]);
		expect(parseMonths('Oct-Mar')).toEqual([1, 2, 3, 10, 11, 12]);
		expect(parseMonths('june; July / Sept')).toEqual([6, 7, 9]);
		expect(parseMonths('3-3|3')).toEqual([3]);
		expect(parseMonths('Jan–Dec')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		for (const bad of ['13', '0', 'Octo', 'summer', 'Oct-', '1-2-3']) expect(parseMonths(bad), bad).toBeUndefined();
	});

	it('imports months, the maximum rate and conditions separated by “|”, and lists what doesn’t read', () => {
		const head = 'registration_no,farm,authorisation,water_source,volume_m3_year,months,max_rate_m3s,conditions';
		const t = parseAllocationTable(
			[head, 'L-1,Farm A,licence,surface,1000,Oct-Mar,0.05,No abstraction below 0.2 m3/s | Meter monthly', 'L-2,Farm A,licence,surface,1000,Smarch,-1,', 'L-3,Farm A,licence,surface,1000,,,'].join('\n'),
			'csv'
		);
		expect(t.columns).toMatchObject({ months: 'months', maxRateM3s: 'max_rate_m3s', conditions: 'conditions' });
		const [ok, bad, none] = t.rows;
		expect(ok!.errors).toEqual([]);
		expect(ok!.months).toEqual([1, 2, 3, 10, 11, 12]);
		expect(ok!.maxRateM3s).toBe(0.05);
		expect(ok!.conditions).toEqual(['No abstraction below 0.2 m3/s', 'Meter monthly']);
		expect(bad!.errors).toEqual(['months “Smarch” are not months (e.g. “Oct-Mar” or “10 11 12 1 2 3”)', 'maximum rate “-1” is not a number of m³/s ≥ 0']);
		expect([none!.months, none!.maxRateM3s, none!.conditions]).toEqual([null, null, []]);
	});

	it('refuses more than 20 conditions and a condition that looks like an ID number', () => {
		const head = 'registration_no,authorisation,water_source,volume_m3_year,conditions';
		const many = new Array(21).fill('c').join('|');
		const t = parseAllocationTable([head, `L-1,licence,surface,1,${many}`, 'L-2,licence,surface,1,8001015009087'].join('\n'), 'csv');
		expect(t.rows[0]!.errors).toContain('more than 20 conditions (separate them with “|”)');
		expect(t.rows[1]!.errors).toContain("conditions looks like an ID number; the app doesn't keep those");
	});

	it('the template ends with the three condition columns', () => {
		expect(TEMPLATE_HEADERS.slice(-3)).toEqual(['months', 'max_rate_m3s', 'conditions']);
	});
});

describe('matchRow', () => {
	const nodes = [
		{ id: 'a', name: 'Farm A' },
		{ id: 'b', name: 'Farm B' },
		{ id: 'b2', name: 'farm  b' }
	];

	it('matches by a known registration number, then property, then name', () => {
		const known = [
			{ registrationNo: 'R-9', propertyRef: '', nodeId: 'b' },
			{ registrationNo: '', propertyRef: 'Portion 3', nodeId: 'a' }
		];
		expect(matchRow({ registrationNo: 'r-9', propertyRef: '', farm: 'Farm A' }, nodes, known)).toEqual({ nodeId: 'b', matchedBy: 'registration' });
		expect(matchRow({ registrationNo: 'R-1', propertyRef: 'portion 3', farm: '' }, nodes, known)).toEqual({ nodeId: 'a', matchedBy: 'property' });
		expect(matchRow({ registrationNo: '', propertyRef: '', farm: ' farm a ' }, nodes, known)).toEqual({ nodeId: 'a', matchedBy: 'name' });
	});

	it('leaves an ambiguous or unknown name unmatched', () => {
		expect(matchRow({ registrationNo: '', propertyRef: '', farm: 'Farm B' }, nodes, [])).toEqual({ nodeId: null, matchedBy: null });
		expect(matchRow({ registrationNo: '', propertyRef: '', farm: 'Farm Z' }, nodes, [])).toEqual({ nodeId: null, matchedBy: null });
	});

	it('ignores a known match to a node that is gone', () => {
		expect(matchRow({ registrationNo: 'R-9', propertyRef: '', farm: '' }, nodes, [{ registrationNo: 'R-9', propertyRef: '', nodeId: 'gone' }])).toEqual({
			nodeId: null,
			matchedBy: null
		});
	});

	it('matches at least 90 % of the synthetic extract by name (WP-3.10 acceptance)', () => {
		const farms = ['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E'].map((name, i) => ({ id: `n${i}`, name }));
		const rows = parseAllocationTable(FIXTURE, 'warms_extract').rows;
		const matched = rows.filter((r) => matchRow(r, farms, []).nodeId !== null).length;
		expect(matched / rows.length).toBeGreaterThanOrEqual(0.9);
	});
});
