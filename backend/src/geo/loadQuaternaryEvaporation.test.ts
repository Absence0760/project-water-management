// WR2012's monthly evaporation per quaternary: the CSV the WRSM2000 extractor
// writes (loadQuaternaryEvaporation.ts), the committed synthetic rows and the
// import's arguments. Invented numbers only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_EVAPORATION_FILE, SYNTHETIC_EVAPORATION_SOURCE } from '../../scripts/import-quaternary-evaporation.js';
import { QUATERNARY_EVAPORATION_SOURCE, quaternaryEvaporationRecords } from './loadQuaternaryEvaporation.js';
import { SYNTHETIC_DATASET } from './quaternary.js';

const MONTHS = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const HEAD = ['code', ...MONTHS.map((m) => `span_${m}`), ...MONTHS.map((m) => `apan_${m}`), 'span_modules', 'span_agree', 'span_other_totals', 'span_files', 'apan_modules', 'apan_agree', 'apan_other_totals', 'apan_files'].join(',');
const S = [150, 180, 205, 210, 170, 150, 100, 70, 55, 55, 75, 110];
const A = S.map((v) => Math.round(v * 1.27));
const line = (code: string, span: (number | string)[] | null, apan: (number | string)[] | null, rest = ',,,,,,,') =>
	[code, ...(span ?? new Array(12).fill('')), ...(apan ?? new Array(12).fill('')), rest].join(',');

describe('quaternaryEvaporationRecords', () => {
	it('reads the S-pan and A-pan rows with their module provenance, either row missing', () => {
		const csv = [HEAD, line('z01a', S, A, '3,2,1620,Z1RU1.DAT Z1RU2.DAT,1,1,,Z1RR4.DAT'), line('Z02C', S, null, '1,1,,Z2RU3.DAT,,,,')].join('\n');
		const { records, problems } = quaternaryEvaporationRecords(csv);
		expect(problems).toEqual([]);
		expect(records[0]).toEqual({
			code: 'Z01A',
			spanMm: S,
			apanMm: A,
			spanModules: 3,
			spanAgree: 2,
			spanOthersMm: [1620],
			spanFiles: ['Z1RU1.DAT', 'Z1RU2.DAT'],
			apanModules: 1,
			apanAgree: 1,
			apanOthersMm: [],
			apanFiles: ['Z1RR4.DAT']
		});
		expect(records[1]).toMatchObject({ code: 'Z02C', apanMm: null, apanModules: 0, apanAgree: 0, apanFiles: [] });
	});

	it('counts a row without its module columns as one module, agreeing', () => {
		const csv = [['code', ...MONTHS.map((m) => `span_${m}`), ...MONTHS.map((m) => `apan_${m}`)].join(','), [`Z01A`, ...S, ...A].join(',')].join('\n');
		expect(quaternaryEvaporationRecords(csv).records[0]).toMatchObject({ spanModules: 1, spanAgree: 1, apanModules: 1, apanAgree: 1 });
	});

	it('refuses a row with a bad code, a repeated code, a month missing or out of range, or no row at all, naming it', () => {
		const csv = [
			HEAD,
			line('ZZ1A', S, A),
			line('Z01A', S, A),
			line('Z01A', S, A),
			line('Z01B', [...S.slice(0, 11), ''], A),
			line('Z01C', S, [...A.slice(0, 11), 1200]),
			line('Z02A', null, null)
		].join('\n');
		const { records, problems } = quaternaryEvaporationRecords(csv);
		expect(records.map((r) => r.code)).toEqual(['Z01A']);
		expect(problems).toEqual([
			'row 2: "ZZ1A" is not a quaternary code',
			'row 4 (Z01A): Z01A appears twice; the second refused',
			'row 5 (Z01B): its S-pan sep is missing, not a depth from 0 to 1000 mm; refused',
			'row 6 (Z01C): its A-pan sep is "1200", not a depth from 0 to 1000 mm; refused',
			'row 7 (Z02A): it has neither an S-pan nor an A-pan row; refused'
		]);
		expect(quaternaryEvaporationRecords('code,span_oct\nZ01A,1').problems[0]).toMatch(/no "span_nov", "span_dec", "span_jan" \(and 20 more\) columns/);
		expect(quaternaryEvaporationRecords('').problems).toEqual(['the evaporation file is empty']);
	});
});

describe('the committed synthetic rows', () => {
	it('are invented region Z rows, one quaternary with no A-pan and one with disagreeing modules', () => {
		const text = readFileSync(SYNTHETIC_EVAPORATION_FILE, 'utf8');
		expect(text).toMatch(/invented/);
		const { records, problems } = quaternaryEvaporationRecords(text);
		expect(problems).toEqual([]);
		expect(records.map((r) => r.code)).toEqual(['Z01A', 'Z01B', 'Z01C', 'Z02A', 'Z02B', 'Z02C']);
		expect(records.find((r) => r.code === 'Z02C')!.apanMm).toBeNull();
		expect(records.find((r) => r.code === 'Z01B')).toMatchObject({ spanModules: 3, spanAgree: 2 });
		for (const r of records.filter((x) => x.apanMm)) {
			const ratio = r.apanMm!.reduce((a, b) => a + b, 0) / r.spanMm!.reduce((a, b) => a + b, 0);
			expect(ratio).toBeGreaterThan(1.1);
			expect(ratio).toBeLessThan(1.5);
		}
	});
});

describe('import-quaternary-evaporation arguments', () => {
	it('loads the synthetic rows with no argument, else needs a dataset label (not "synthetic"); the source defaults to the recorded credit', () => {
		expect(parseArgs([])).toEqual({ file: SYNTHETIC_EVAPORATION_FILE, dataset: SYNTHETIC_DATASET, source: SYNTHETIC_EVAPORATION_SOURCE });
		expect(parseArgs(['e.csv'])).toMatch(/--dataset/);
		expect(parseArgs(['e.csv', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseArgs(['e.csv', '--dataset', 'WR2012-WRSM2000'], { INIT_CWD: '/data' })).toEqual({ file: '/data/e.csv', dataset: 'WR2012-WRSM2000', source: QUATERNARY_EVAPORATION_SOURCE });
		expect(parseArgs(['e.csv', '--dataset', 'X', '--source', 'My study'])).toMatchObject({ source: 'My study' });
	});
});
