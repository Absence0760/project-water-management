// The A-pan source choice and the S-pan paste (spanEntry.ts).
import { describe, expect, it } from 'vitest';
import { CCWR_APAN_DATASET, evaporationGridName } from './ccwrApan';
import { APAN_SOURCES, parseSpanRow } from './spanEntry';

const ROW = [150, 170, 190, 195, 160, 140, 95, 70, 55, 57, 78, 105];

describe('parseSpanRow', () => {
	it('reads a spreadsheet row (tabs, a decimal comma), a column, or numbers separated by spaces, semicolons or commas', () => {
		expect(parseSpanRow(ROW.join('\t'))).toEqual({ ok: true, values: ROW });
		expect(parseSpanRow(ROW.join('\n'))).toEqual({ ok: true, values: ROW });
		expect(parseSpanRow(['150,5', ...ROW.slice(1)].join('\t'))).toEqual({ ok: true, values: [150.5, ...ROW.slice(1)] });
		expect(parseSpanRow(ROW.join(' '))).toEqual({ ok: true, values: ROW });
		expect(parseSpanRow(ROW.join(';'))).toEqual({ ok: true, values: ROW });
		expect(parseSpanRow(ROW.join(','))).toEqual({ ok: true, values: ROW });
	});

	it('says why it can’t: empty, not 12, not a number, out of range', () => {
		expect(parseSpanRow('  ')).toEqual({ ok: false, reason: 'paste the 12 months, October first' });
		expect(parseSpanRow(ROW.slice(1).join('\t'))).toEqual({ ok: false, reason: 'that is 11 values, not 12 (October to September)' });
		expect(parseSpanRow(['x', ...ROW.slice(1)].join('\t'))).toEqual({ ok: false, reason: 'value 1 is not a number of mm from 0 to 1000' });
		expect(parseSpanRow([...ROW.slice(0, 11), 1200].join('\t'))).toMatchObject({ ok: false, reason: expect.stringMatching(/value 12/) });
	});
});

describe('APAN_SOURCES', () => {
	it('offers the typed rows, WR2012 and the CCWR grid here and links the stations and any other grid to where they live on Calibration', () => {
		expect(APAN_SOURCES.map((s) => s.id)).toEqual(['typed', 'wr2012', 'span', 'station', 'ccwr', 'ccwrUnits', 'grid']);
		expect(APAN_SOURCES.find((s) => s.id === 'ccwr')!.label).toBe('CCWR A-pan (Catchment)');
		expect(APAN_SOURCES.find((s) => s.id === 'ccwrUnits')!.label).toBe('CCWR A-pan (Hydrological Unit)');
		expect(APAN_SOURCES.filter((s) => 'href' in s).map((s) => s.id)).toEqual(['station', 'grid']);
		for (const s of APAN_SOURCES.filter((x) => 'href' in x)) expect(s.href).toMatch(/^\?tab=calibration#set-evaporation/);
	});
});

describe('the CCWR A-pan grid’s name', () => {
	it('is "CCWR A-pan" for Atlas-Apan-2007 wherever a grid is named, and every other grid keeps its label', () => {
		expect(CCWR_APAN_DATASET).toBe('Atlas-Apan-2007');
		expect(evaporationGridName('Atlas-Apan-2007')).toBe('CCWR A-pan');
		for (const d of ['synthetic', 'Atlas-Span-2007', 'dPET-1991-2020', 'penpan-2001-2020']) expect(evaporationGridName(d)).toBe(d);
		// The operator's command names the dataset, as docs/STACK.md has it, and no period (the Atlas states none).
	});
});
