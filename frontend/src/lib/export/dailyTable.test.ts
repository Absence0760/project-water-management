import { CSV_DISCLAIMER_COMMENT } from '@water-management/engine';
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
			comments: [],
			provenance: null,
			legacy: false,
			headers: ['Farm, upper [I] (m³/day)', 'Farm 2 [I] (m³/day)'],
			dates: ['2024-02-28', '2024-02-29'],
			columns: [
				[1.5, 0],
				[null, 2000]
			]
		});
	});

	const PROVENANCE = '# run=Baseline v2; engine=1.4.0; runoff_model=gr4j; created=2026-09-27T08:15:00.000Z; period=2021-10-01..2022-01-28';

	it('reads the run’s provenance line apart from the table', () => {
		const t = parseDailyCsv(`﻿${PROVENANCE}; dam_capacity_m3=50000\r\ndate,A\r\n2024-01-01,3\r\n`);
		expect(t.comments).toEqual([PROVENANCE.slice(2) + '; dam_capacity_m3=50000']);
		expect(t.provenance).toEqual({
			run: 'Baseline v2',
			engine: '1.4.0',
			runoff_model: 'gr4j',
			created: '2026-09-27T08:15:00.000Z',
			period: '2021-10-01..2022-01-28',
			dam_capacity_m3: '50000'
		});
		expect(t.legacy).toBe(false);
		expect(t.headers).toEqual(['A']);
		expect(t.dates).toEqual(['2024-01-01']);
	});

	it('reads past the disclaimer line that leads every result CSV to the provenance and the table', () => {
		const t = parseDailyCsv(`﻿${CSV_DISCLAIMER_COMMENT}\r\n${PROVENANCE}\r\ndate,A\r\n2024-01-01,3\r\n`);
		expect(t.provenance?.run).toBe('Baseline v2');
		expect(t.legacy).toBe(false);
		expect(t.headers).toEqual(['A']);
		expect(t.columns).toEqual([[3]]);
	});

	it('decodes a percent-encoded label with the separators, a quote and a line break in it', () => {
		const t = parseDailyCsv('# run=%3DSUM(A1)%3B x%3Dy%2C %22q%22%0D%0Anext 100%25; engine=1.4.0\r\ndate,A\r\n');
		expect(t.provenance).toEqual({ run: '=SUM(A1); x=y, "q"\r\nnext 100%', engine: '1.4.0' });
		expect(parseDailyCsv('# run=50%; engine=1\r\ndate\r\n').provenance!.run).toBe('50%'); // a stray % is kept as written
	});

	it('takes both lines of a legacy run: the warning first, then the provenance line', () => {
		const t = parseDailyCsv(
			'﻿# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\n# run=Old; engine=0.9.0; runoff_model=legacy; created=2024-01-01T00:00:00.000Z; period=2024-01-01..2024-12-31\r\ndate,A\r\n2024-01-01,3\r\n'
		);
		expect(t.comments).toHaveLength(2);
		expect(t.comments[0]).toBe('runoff_model=legacy; workbook comparison only; not evidence (audit H1)');
		expect(t.provenance).toMatchObject({ run: 'Old', runoff_model: 'legacy' });
		expect(t.legacy).toBe(true);
		expect(t.headers).toEqual(['A']);
		expect(t.columns).toEqual([[3]]);
	});

	it('still reads a file saved before the provenance line (the legacy warning alone, or no # line)', () => {
		const old = parseDailyCsv('﻿# runoff_model=legacy; workbook comparison only; not evidence (audit H1)\r\ndate,A\r\n2024-01-01,3\r\n');
		expect(old).toMatchObject({ provenance: null, legacy: true, headers: ['A'] });
		expect(parseDailyCsv(`${PROVENANCE}\r\ndate,A\r\n`).legacy).toBe(false); // positive control: a GR4J run is not legacy
	});

	it('undoes the CSV-injection guard on a name, and refuses what is not a daily table', () => {
		expect(parseDailyCsv("date,'=Farm [I] (m³/day)\r\n").headers).toEqual(['=Farm [I] (m³/day)']);
		expect(() => parseDailyCsv('')).toThrow(/empty/);
		expect(() => parseDailyCsv('Project,Demo\r\n')).toThrow(/not a daily table/);
	});
});
