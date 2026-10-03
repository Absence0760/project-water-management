import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ImportRefused,
	matchRow,
	parseAllocationTable,
	parseAuthorisation,
	parseDate,
	parseMonths,
	parseFrequency,
	parseNumber,
	separatorHint,
	parsePurpose,
	parseUnit,
	parseWaterUse,
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
		expect(separatorHint('about 5', ',')).toBe('');
	});

	it('refuses the other locale\'s decimal rather than read it as a thousands separator (a 10× volume)', () => {
		// Positive controls: grouped in threes, in either locale, with spaces, signs, decimals and exponents.
		expect(parseNumber('1,234,567', ',')).toBe(1234567);
		expect(parseNumber('1.234.567,25', ';')).toBe(1234567.25);
		expect(parseNumber(' 5\u00a0000 ', ',')).toBe(5000);
		expect(parseNumber('5\u202f000,5', ';')).toBe(5000.5);
		expect(parseNumber('-1,234.5', ',')).toBe(-1234.5);
		expect(parseNumber('12.5', ',')).toBe(12.5);
		expect(parseNumber('12,5', ';')).toBe(12.5);
		expect(parseNumber('1.5e3', ',')).toBe(1500);
		expect(parseNumber('.5', ',')).toBe(0.5);
		// A decimal comma in a , file and a decimal point in a ; file: not 125 or 15.
		expect(parseNumber('12,5', ',')).toBeNaN();
		expect(parseNumber('0,75', ',')).toBeNaN();
		expect(parseNumber('1.5', ';')).toBeNaN();
		// Groups that aren't threes, or a separator with nothing before it.
		expect(parseNumber('1,2345', ',')).toBeNaN();
		expect(parseNumber('1234,567', ',')).toBeNaN();
		expect(parseNumber('1 2', ',')).toBeNaN();
		expect(parseNumber(',123', ',')).toBeNaN();
		expect(parseNumber('1,2,3', ';')).toBeNaN();
	});

	it('flags a row whose volume has a decimal comma in a , file, instead of importing it ten times larger', () => {
		const t = parseAllocationTable('registration_no,volume_m3_year\nR1,"12,5"\nR2,"12,500"\n', 'csv');
		expect(t.rows[0]!.errors).toContain(
			'volume “12,5” is not a number ≥ 0: in a comma-separated file a comma only groups thousands in threes (1,500); write a decimal with a point (1.5)'
		);
		expect(t.rows[0]!.volumeM3PerYear).toBeNull();
		expect(t.rows[1]!.errors.filter((e) => e.startsWith('volume'))).toEqual([]);
		expect(t.rows[1]!.volumeM3PerYear).toBe(12500);
	});

	it('reads ISO dates only, and only real ones', () => {
		expect(parseDate('2005-06-01')).toBe('2005-06-01');
		expect(parseDate('2005/6/1')).toBe('2005-06-01');
		expect(parseDate('')).toBeNull();
		expect(parseDate('2005-02-30')).toBeUndefined();
		expect(parseDate('01/06/2005')).toBeUndefined();
	});

	it('maps authorisation, purpose and source words', () => {
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

// Issue #281: a registration is not an entitlement, existing lawful use is
// verified only under s35, and Schedule 1 is permissible use, not a s39 GA.
describe('parseAuthorisation', () => {
	const cases: [string, string | null | undefined][] = [
		['', null],
		['Registration', 'registration'],
		['Registered use', 'registration'],
		['WARMS', 'registration'],
		['Licence', 'licence'],
		['Water use license', 'licence'],
		['s40', 'licence'],
		['GA', 'general_authorisation'],
		['General Authorization', 'general_authorisation'],
		['s39', 'general_authorisation'],
		['Section 39', 'general_authorisation'],
		// Schedule 1 is its own value, never a general authorisation.
		['Schedule 1', 'schedule_1'],
		['Sch 1', 'schedule_1'],
		['Sch. 1', 'schedule_1'],
		['Schedule1', 'schedule_1'],
		['Permissible use', 'schedule_1'],
		['s22(1)(a)(i)', 'schedule_1'],
		// Unqualified existing lawful use is a claim, not a verified use.
		['Existing lawful use', 'existing_lawful_use_claimed'],
		['Existing', 'existing_lawful_use_claimed'],
		['ELU', 'existing_lawful_use_claimed'],
		['s32', 'existing_lawful_use_claimed'],
		['Section 32', 'existing_lawful_use_claimed'],
		['Claimed ELU', 'existing_lawful_use_claimed'],
		['Unverified ELU', 'existing_lawful_use_claimed'],
		['Existing lawful use (unverified)', 'existing_lawful_use_claimed'],
		// Only an explicit verification reads as verified.
		['Verified', 'existing_lawful_use'],
		['Verified ELU', 'existing_lawful_use'],
		['ELU (verified)', 'existing_lawful_use'],
		['Existing lawful use - verified', 'existing_lawful_use'],
		['Verified existing lawful use', 'existing_lawful_use'],
		['s35', 'existing_lawful_use'],
		['Section 35', 'existing_lawful_use'],
		['S35 verified', 'existing_lawful_use'],
		['Schedule 2', undefined],
		['maybe', undefined]
	];
	for (const [cell, want] of cases) it(`maps “${cell}” to ${String(want)}`, () => expect(parseAuthorisation(cell)).toBe(want));

	it('names every value an unknown authorisation could be', () => {
		const t = parseAllocationTable('registration_no,authorisation,water_source,volume_m3_year\nR1,Schedule 2,surface,5\n', 'csv');
		expect(t.rows[0]!.authorisation).toBeNull();
		expect(t.rows[0]!.errors).toEqual([
			'unknown authorisation “Schedule 2” (registration, licence, general authorisation, Schedule 1, existing lawful use (a claim) or verified existing lawful use (s35))'
		]);
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
			waterUse: '21a',
			volumeM3PerYear: 120000,
			storageM3: 150000,
			validFrom: '2000-01-01',
			validTo: null
		});
		expect(t.rows[2]).toMatchObject({ authorisation: 'licence', validTo: '2045-05-31' });
		// The extract says "Existing lawful use" with no verification: a claim (#281).
		expect(t.rows[3]).toMatchObject({ purpose: 'livestock', authorisation: 'existing_lawful_use_claimed' });
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

describe('licence conditions (103, issue #72)', () => {
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

	it('the template has the three condition columns, then the s21 water use (issue #72)', () => {
		expect(TEMPLATE_HEADERS.slice(-4)).toEqual(['months', 'max_rate_m3s', 'conditions', 'water_use']);
	});
});

// Issue #72: WARMS registers per s21 water use, per property. A 21(b) row's
// volume is a dam's storage, so it must never import as a take per year.
describe('the s21 water use, unit and frequency (issue #72)', () => {
	it('reads the water-use code however it is written, and refuses one that names two uses', () => {
		for (const c of ['21(a)', '21a', 'S21(a)', 'Section 21(a)', 'a', 'Taking water', 'abstraction']) expect(parseWaterUse(c), c).toBe('21a');
		for (const c of ['21(b)', '21 b', 's21b', 'NWA Section 21(b)', 'B', 'Storing water', 'storage']) expect(parseWaterUse(c), c).toBe('21b');
		expect(parseWaterUse('21(c)')).toEqual({ other: '21(c)' });
		expect(parseWaterUse('s21 j')).toEqual({ other: '21(j)' });
		expect(parseWaterUse('')).toBeNull();
		for (const c of ['21(a)(b)', '21(a) and (b)', '21a/21b', '22', 'z', 'irrigation']) expect(parseWaterUse(c), c).toBeUndefined();
	});

	it('reads a unit with or without its frequency, megalitres only as Ml or ML', () => {
		expect(parseUnit('m3/a')).toEqual({ m3: 1, frequency: 'year' });
		expect(parseUnit('m³ per annum')).toEqual({ m3: 1, frequency: 'year' });
		expect(parseUnit('Ml/a')).toEqual({ m3: 1000, frequency: 'year' });
		expect(parseUnit('ML / year')).toEqual({ m3: 1000, frequency: 'year' });
		expect(parseUnit('megalitres')).toEqual({ m3: 1000, frequency: null });
		expect(parseUnit('kl/month')).toEqual({ m3: 1, frequency: 'month' });
		expect(parseUnit('l/s')).toEqual({ m3: 0.001, frequency: 'second' });
		expect(parseUnit('')).toBeNull();
		// A lower-case "ml" is a millilitre as written: refused, not read as a megalitre.
		for (const c of ['ml/a', 'mL', 'ha', 'm3/fortnight', 'm3/a/a']) expect(parseUnit(c), c).toBeUndefined();
		expect(parseFrequency('Per annum')).toBe('year');
		expect(parseFrequency('p.a.')).toBe('year');
		expect(parseFrequency('monthly')).toBe('month');
		expect(parseFrequency('')).toBeNull();
		expect(parseFrequency('seasonal')).toBeUndefined();
	});

	const HEAD = 'Registration Number,Farm Name,Resource Type,Water Use,Registered Volume,Unit,Registered Storage (m3)';
	const warms = (...rows: string[]) => parseAllocationTable([HEAD, ...rows].join('\n'), 'warms_extract').rows;

	it('reads a 21(a) row as a take per year and a 21(b) row as the dam’s storage, never a take', () => {
		const [take, dam, damMl, damStorageCol] = warms('R1,Farm A,Surface,21(a),"120,000",m3/a,', 'R1,Farm A,Surface,21(b),"150,000",m3/a,', 'R2,Farm B,,21(b),250,Ml,', 'R3,Farm C,Surface,21(b),,m3,80000');
		expect(take).toMatchObject({ waterUse: '21a', volumeM3PerYear: 120000, storageM3: null, errors: [] });
		expect(dam).toMatchObject({ waterUse: '21b', waterSource: 'surface', volumeM3PerYear: 0, storageM3: 150000, errors: [] });
		// Ml is 1 000 m³; a dam with no source is surface water.
		expect(damMl).toMatchObject({ waterUse: '21b', waterSource: 'surface', volumeM3PerYear: 0, storageM3: 250000, errors: [] });
		expect(damStorageCol).toMatchObject({ waterUse: '21b', volumeM3PerYear: 0, storageM3: 80000, errors: [] });
	});

	it('converts a take in megalitres a year to m³', () => {
		expect(warms('R1,Farm A,Surface,21(a),1.5,Ml/a,')[0]).toMatchObject({ volumeM3PerYear: 1500, errors: [] });
		// A decimal comma in a , file is 1.5 Ml or 15 Ml, never knowable: refused, not read as 15 000 m³.
		expect(warms('R1,Farm A,Surface,21(a),"1,5",Ml/a,')[0]).toMatchObject({ volumeM3PerYear: null, errors: [expect.stringMatching(/^volume “1,5” is not a number ≥ 0: in a comma-separated file/)] });
		// And a decimal point in a ; file.
		const semi = parseAllocationTable('registration_no;authorisation;water_source;volume_m3_year\nR1;licence;surface;1.5\n', 'csv').rows[0]!;
		expect(semi.errors).toEqual(['volume “1.5” is not a number ≥ 0: in a semicolon-separated file a point only groups thousands in threes (1.500); write a decimal with a comma (1,5)']);
		expect(warms('R1,Farm A,Surface,21(a),12.5,ML per annum,')[0]).toMatchObject({ volumeM3PerYear: 12500, errors: [] });
	});

	it('refuses an ambiguous row rather than guess', () => {
		const rows = warms(
			'R1,Farm A,Surface,,100,m3/a,',
			'R2,Farm A,Surface,21(a)(b),100,m3/a,',
			'R3,Farm A,Surface,21(c),100,m3/a,',
			'R4,Farm A,Surface,21(a),100,,',
			'R5,Farm A,Surface,21(a),100,ml/a,',
			'R6,Farm A,Surface,21(a),100,m3/month,',
			'R7,Farm A,Surface,21(a),100,l/s,',
			'R8,Farm A,Surface,21(b),100,m3/a,90',
			'R9,Farm A,Groundwater,21(b),100,m3/a,',
			'R10,Farm A,Surface,21(b),,m3/a,'
		);
		const first = rows.map((r) => r.errors[0] ?? '');
		expect(first[0]).toBe('water use is missing (21(a) taking or 21(b) storing)');
		expect(first[1]).toMatch(/water use “21\(a\)\(b\)” doesn’t read as one s21 use/);
		expect(first[2]).toBe('water use 21(c) is not a take or a storage the app compares; not imported');
		expect(first[3]).toBe('unit is missing (e.g. “m3/a” or “Ml/a”)');
		expect(first[4]).toMatch(/unit “ml\/a” doesn’t read/);
		expect(first[5]).toMatch(/the volume is per month: the app compares a volume per year/);
		expect(first[6]).toMatch(/the volume is per second/);
		expect(first[7]).toBe('a 21(b) storage row gives two storages (volume 100, storage 90)');
		expect(first[8]).toMatch(/a 21\(b\) storage row is a dam, so surface water/);
		expect(first[9]).toBe('a 21(b) storage row has no storage (in the volume or the storage column)');
		// None of them carries a volume a run would read as a take.
		expect(rows.every((r) => r.errors.length > 0)).toBe(true);
	});

	it('reads a separate frequency column, and refuses one that contradicts the unit', () => {
		const head = 'Registration Number,Farm Name,Resource Type,Water Use,Registered Volume,Unit,Frequency';
		const [ok, noFreq, clash, storage] = parseAllocationTable(
			[head, 'R1,Farm A,Surface,21(a),100,m3,per annum', 'R2,Farm A,Surface,21(a),100,m3,', 'R3,Farm A,Surface,21(a),100,m3/a,monthly', 'R4,Farm A,Surface,21(b),100,m3,'].join('\n'),
			'warms_extract'
		).rows;
		expect(ok).toMatchObject({ volumeM3PerYear: 100, errors: [] });
		expect(noFreq!.errors).toEqual(['frequency is missing (per annum)']);
		expect(clash!.errors).toEqual(['the unit says per year but the frequency says per month']);
		// A storage needs no frequency to be read either: blank is refused the same way, not guessed.
		expect(storage!.errors).toEqual(['frequency is missing (per annum)']);
	});

	it('refuses a WARMS extract with no water-use column; the template (no column) reads takes', () => {
		expect(() => parseAllocationTable('Registration Number,Farm Name,Resource Type,Registered Volume (m3/a)\nR1,Farm A,Surface,100\n', 'warms_extract')).toThrow(/no water-use column found/);
		const [row] = parseAllocationTable('registration_no,farm,authorisation,water_source,volume_m3_year,storage_m3\nR1,Farm A,licence,surface,100,50\n', 'csv').rows;
		expect(row).toMatchObject({ waterUse: '21a', volumeM3PerYear: 100, storageM3: 50, errors: [] });
	});

	it('reads the export’s own storage rows back (volume 0, the storage, water_use 21b)', () => {
		const [row] = parseAllocationTable(`${TEMPLATE}\nR1,,Farm A,,registration,irrigation,surface,0,150000,,,,,,,21b`, 'csv').rows;
		expect(row).toMatchObject({ waterUse: '21b', volumeM3PerYear: 0, storageM3: 150000, errors: [] });
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
