// The register-of-dams loader (geo/loadDamRegister.ts, scripts/import-dam-register.ts)
// and the committed synthetic list it loads by default. The CSV and KML
// samples copy the DWS Dam Safety Office files' layout (column names,
// SimpleData names) with invented rows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDamArgs, readDamFiles, SYNTHETIC_DAM_FILE } from '../../scripts/import-dam-register.js';
import { SYNTHETIC_DAM_DATASET } from './damProposals.js';
import { completionYear, csvCells, damPartsFromCsv, damPartsFromJson, damPartsFromKml, joinDamParts } from './loadDamRegister.js';

const LIST_CSV = [
	'No of dam,WMA,Name of dam,Dam Status,Town nearest,Province,Region,Completion date,River or Watercourse,Dam type,Wall height (m),Crest Length (m),Spillway Type,Capacity (1000 cub m),Purpose,Registration date',
	'Z900/01,1,TESTKLOOF DAM,REG,NOWHERE,WC,WC,1986,TESTRIVIER,EMBANKMENT,12.5,300,OGEE,1250,"IRRIGATION, DOMESTIC AND INDUSTRIAL USE",31783',
	'Z900/02,1,"NAAMLOOS ""B"" DAM",REG,NOWHERE,WC,WC,0,SPRUIT,EMBANKMENT,6,100,,75.5,IRRIGATION,42747',
	'Z900/03,1,NO PLACE DAM,REG,NOWHERE,WC,WC,2001,SPRUIT,EMBANKMENT,7,100,,90,IRRIGATION,42747'
].join('\r\n');

const KML = `<?xml version="1.0"?><kml><Document>
<Placemark><name>TESTKLOOF DAM</name><ExtendedData><SchemaData schemaUrl="#S">
	<SimpleData name="No_of_dam">Z900/01</SimpleData><SimpleData name="Name_of_dam">TESTKLOOF DAM</SimpleData>
	<SimpleData name="Lat_Decimal">-33.7</SimpleData><SimpleData name="Longitude_Decimal">21.3</SimpleData>
	<SimpleData name="Wall_height__m_">12</SimpleData><SimpleData name="Name_of_farm">TESTPLAAS 1 &amp; 2</SimpleData>
</SchemaData></ExtendedData><Point><coordinates>21.3000001,-33.7000001,0</coordinates></Point></Placemark>
<Placemark><name>NAAMLOOS B DAM</name><ExtendedData><SchemaData schemaUrl="#S">
	<SimpleData name="No_of_dam">Z900/02</SimpleData>
</SchemaData></ExtendedData><Point><coordinates>21.4,-33.8,0</coordinates></Point></Placemark>
<Placemark><name>NO NUMBER</name></Placemark>
</Document></kml>`;

describe('the committed synthetic register', () => {
	const { records, problems } = readDamFiles({ files: [SYNTHETIC_DAM_FILE], dataset: SYNTHETIC_DAM_DATASET, source: '' });

	it('is invented: register numbers in region Z (no DWS region), every source says SYNTHETIC', () => {
		expect(problems).toEqual([]);
		expect(records.length).toBe(8);
		for (const r of records) {
			expect(r.registerNo).toMatch(/^Z\d{3}\/\d{2}$/);
			expect(r.source).toMatch(/^SYNTHETIC /);
		}
		expect(JSON.parse(readFileSync(SYNTHETIC_DAM_FILE, 'utf8')).dataset).toBe(SYNTHETIC_DAM_DATASET);
	});

	it('is plausible: registrable dams (over 50 000 m³ and 5 m), capacities in m³', () => {
		for (const r of records) {
			expect(r.capacityM3!).toBeGreaterThan(50_000);
			expect(r.wallHeightM!).toBeGreaterThan(5);
			expect(r.completionYear!).toBeGreaterThan(1900);
		}
	});
});

describe('csvCells', () => {
	it('splits on commas outside quotes and undoubles quotes', () => {
		expect(csvCells('a,"b, c","d ""e""",')).toEqual(['a', 'b, c', 'd "e"', '']);
	});
});

describe('the DSO list as CSV', () => {
	it('reads the list’s columns, converts thousands of m³ to m³, a 0 completion date to none', () => {
		const { parts, problems } = damPartsFromCsv(LIST_CSV);
		expect(problems).toEqual([]);
		expect(parts[0]).toMatchObject({ registerNo: 'Z900/01', name: 'TESTKLOOF DAM', river: 'TESTRIVIER', capacityM3: 1_250_000, wallHeightM: 12.5, completionYear: 1986 });
		expect(parts[1]).toMatchObject({ registerNo: 'Z900/02', name: 'NAAMLOOS "B" DAM', capacityM3: 75_500, completionYear: null });
		expect(parts[0]!.lon).toBeUndefined();
	});

	it('refuses a file without the register number column', () => {
		expect(damPartsFromCsv('Name of dam\nX').problems).toEqual(['the CSV file has no "No of dam" column']);
	});
});

describe('the DSO overlay as KML', () => {
	it('reads each placemark’s number, position, wall height and farm, else the Point', () => {
		const { parts, problems } = damPartsFromKml(KML);
		expect(problems).toEqual(['placemark 3: no No_of_dam']);
		expect(parts[0]).toMatchObject({ registerNo: 'Z900/01', lon: 21.3, lat: -33.7, wallHeightM: 12, farm: 'TESTPLAAS 1 & 2' });
		expect(parts[1]).toMatchObject({ registerNo: 'Z900/02', lon: 21.4, lat: -33.8, name: 'NAAMLOOS B DAM' });
	});
});

describe('joinDamParts', () => {
	it('joins the list and the overlay by number, the list first; skips a dam with no position; appends the number to --source', () => {
		const { records, problems } = joinDamParts([...damPartsFromCsv(LIST_CSV).parts, ...damPartsFromKml(KML).parts], 'DSO List of Registered Dams, July 2025');
		expect(records.map((r) => r.registerNo)).toEqual(['Z900/01', 'Z900/02']);
		expect(records[0]).toMatchObject({ name: 'TESTKLOOF DAM', capacityM3: 1_250_000, wallHeightM: 12.5, farm: 'TESTPLAAS 1 & 2', lon: 21.3, lat: -33.7, source: 'DSO List of Registered Dams, July 2025: Z900/01' });
		expect(records[1]!.name).toBe('NAAMLOOS "B" DAM');
		expect(problems).toEqual(['Z900/03 (NO PLACE DAM): no position (the list has none; give the overlay\'s KML too)']);
	});

	it('needs a source from the file or --source', () => {
		const { records, problems } = joinDamParts(damPartsFromKml(KML).parts, '');
		expect(records).toEqual([]);
		expect(problems[0]).toMatch(/no source/);
	});

	it('reads the JSON form, refusing an entry with no number', () => {
		const { parts, problems } = damPartsFromJson({ dams: [{ name: 'X' }, { registerNo: ' z1/1 ', name: 'Y', lon: 1, lat: 2, capacityM3: -5 }] });
		expect(problems).toEqual(['dam 1: no register number']);
		expect(parts[0]).toMatchObject({ registerNo: 'Z1/1', capacityM3: null });
		expect(damPartsFromJson({}).problems).toEqual(['the JSON file has no "dams" array']);
	});
});

describe('completionYear', () => {
	it('takes a year from a year, a date or nothing', () => {
		expect(completionYear('1986')).toBe(1986);
		expect(completionYear('2017/01/12')).toBe(2017);
		expect(completionYear('0')).toBeNull();
		expect(completionYear(null)).toBeNull();
	});
});

describe('parseDamArgs', () => {
	it('loads the synthetic list with no argument, else needs a label that isn’t the fixture’s and a known file type', () => {
		expect(parseDamArgs([])).toEqual({ files: [SYNTHETIC_DAM_FILE], dataset: 'synthetic', source: '' });
		expect(parseDamArgs(['list.csv', 'doc.kml', '--dataset', 'DSO-2025-07', '--source', 'DSO list'], { INIT_CWD: '/work' })).toEqual({
			files: ['/work/list.csv', '/work/doc.kml'],
			dataset: 'DSO-2025-07',
			source: 'DSO list'
		});
		expect(parseDamArgs(['list.csv'])).toMatch(/--dataset/);
		expect(parseDamArgs(['list.csv', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseDamArgs(['list.xlsx', '--dataset', 'x'])).toMatch(/give a \.csv/);
	});
});
