import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDate } from '../projects/timeZone.js';
import {
	attachment,
	BOM,
	collectCsv,
	csvRow,
	dailyCsvLines,
	dayRange,
	exportFilename,
	LEGACY_RUN_CSV_COMMENT,
	numCell,
	provenanceValue,
	runProvenanceComment,
	seriesHeader,
	slugify,
	textCell,
	withLegacyComment,
	withRunComments,
	type RunProvenance
} from './csv.js';

describe('csv cells', () => {
	it('quotes per RFC 4180', () => {
		expect(textCell('plain')).toBe('plain');
		expect(textCell('a,b')).toBe('"a,b"');
		expect(textCell('say "hi"')).toBe('"say ""hi"""');
		expect(textCell('two\nlines')).toBe('"two\nlines"');
		expect(textCell('cr\r')).toBe('"cr\r"');
	});

	it('defuses spreadsheet formulas in text cells', () => {
		expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(textCell('+1')).toBe("'+1");
		expect(textCell('-dam')).toBe("'-dam");
		expect(textCell('@sum')).toBe("'@sum");
		expect(textCell('Dam = full')).toBe('Dam = full');
	});

	it('writes numbers as numbers and missing values as empty', () => {
		expect(numCell(-12.5)).toBe('-12.5');
		expect(numCell(0)).toBe('0');
		expect(numCell(null)).toBe('');
		expect(numCell(undefined)).toBe('');
		expect(numCell(NaN)).toBe('');
		expect(numCell(Infinity)).toBe('');
		expect(csvRow(['Farm, north', -3, null, 'x'])).toBe('"Farm, north",-3,,x');
	});

	it('labels series columns with their unit', () => {
		expect(seriesHeader('Dam storage', 'm³')).toBe('Dam storage (m³)');
		expect(seriesHeader('Summer flag', '')).toBe('Summer flag');
	});
});

describe('daily table', () => {
	it('writes ISO dates across month/leap boundaries and honours the window', () => {
		const lines = [
			...dailyCsvLines('2024-02-28', [{ header: 'Flow (m³/day)', values: [1, null, 3, 4] }], { offset: 1, days: 2 })
		];
		expect(lines).toEqual(['date,Flow (m³/day)', '2024-02-29,', '2024-03-01,3']);
	});

	it('is independent of the server timezone', () => {
		const tz = process.env.TZ;
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
		try {
			const lines = [...dailyCsvLines('2000-01-01', [{ header: 'x', values: [1] }], { offset: 0, days: 1 })];
			expect(lines[1]).toBe('2000-01-01,1');
		} finally {
			process.env.TZ = tz;
		}
	});

	it('clamps from/to windows to the series', () => {
		expect(dayRange('2020-01-01', 10)).toEqual({ offset: 0, days: 10 });
		expect(dayRange('2020-01-01', 10, '2020-01-03', '2020-01-04')).toEqual({ offset: 2, days: 2 });
		expect(dayRange('2020-01-01', 10, '2019-01-01', '2030-01-01')).toEqual({ offset: 0, days: 10 });
		expect(dayRange('2020-01-01', 10, '2021-01-01')).toBeNull();
		expect(dayRange('2020-01-01', 10, undefined, '2019-12-31')).toBeNull();
	});
});

describe('legacy-run CSV comment (audit H1)', () => {
	it('prepends the comment only when legacy, leaving the header row first otherwise', () => {
		const lines = ['date,Flow (m³/day)', '2020-01-01,1'];
		expect([...withLegacyComment(true, lines)]).toEqual([LEGACY_RUN_CSV_COMMENT, ...lines]);
		expect([...withLegacyComment(false, lines)]).toEqual(lines);
		expect(LEGACY_RUN_CSV_COMMENT).toMatch(/^# runoff_model=legacy;/);
	});

	it('lands as the first line of the collected CSV body, ahead of the BOM-prefixed header', () => {
		const body = collectCsv(withLegacyComment(true, ['date,x', '2020-01-01,1']));
		expect(body).toBe(`${BOM}${LEGACY_RUN_CSV_COMMENT}\r\ndate,x\r\n2020-01-01,1\r\n`);
	});
});

describe('run provenance line on the daily CSVs', () => {
	const run: RunProvenance = {
		label: 'Baseline v2',
		engineVersion: '1.4.0',
		runoffModel: 'gr4j',
		createdAt: '2026-09-27T08:15:00.000Z',
		startDate: '2021-10-01',
		endDate: '2022-01-28'
	};
	/** The line's key/value pairs, decoded the way a reader would. */
	const pairs = (line: string) =>
		Object.fromEntries(
			line
				.replace(/^# /, '')
				.split('; ')
				.map((p) => {
					const [k, v] = p.split('=');
					return [k!, decodeURIComponent(v!)];
				})
		);

	it('names the run, engine, runoff model, creation time and period, in that order', () => {
		expect(runProvenanceComment(run)).toBe(
			'# run=Baseline v2; engine=1.4.0; runoff_model=gr4j; created=2026-09-27T08:15:00.000Z; period=2021-10-01..2022-01-28'
		);
	});

	it('adds the dam capacity on a farm file only, empty when the run stored none', () => {
		expect(runProvenanceComment({ ...run, damCapacityM3: 50000 })).toMatch(/; dam_capacity_m3=50000$/);
		expect(runProvenanceComment({ ...run, damCapacityM3: 0 })).toMatch(/; dam_capacity_m3=0$/);
		expect(runProvenanceComment({ ...run, damCapacityM3: null })).toMatch(/; dam_capacity_m3=$/);
		expect(runProvenanceComment(run)).not.toContain('dam_capacity_m3');
	});

	it('percent-encodes the separators, CSV metacharacters and line breaks, and nothing else', () => {
		expect(provenanceValue('Plain – label (m³)')).toBe('Plain – label (m³)');
		expect(provenanceValue('a;b=c,d"e%f')).toBe('a%3Bb%3Dc%2Cd%22e%25f');
		expect(provenanceValue('one\r\ntwo\tthree\u0085four\u2028five')).toBe('one%0D%0Atwo%09three%C2%85four%E2%80%A8five');
	});

	it('keeps a hostile label to one inert line that decodes back exactly', () => {
		for (const label of ['=HYPERLINK("http://x","y")', '+1', '-2', '@SUM(A1)', 'a; engine=0.0.0', 'line\r\n2021-01-01,999', '"quoted", comma', '100%25']) {
			const line = runProvenanceComment({ ...run, label });
			expect(line.startsWith('# run=')).toBe(true);
			expect(line).not.toMatch(/[,"\r\n\t]/); // one cell to any CSV reader, one line to a comment-skipping one
			// Split on `;` (Excel's delimiter in a comma-decimal locale): no cell starts like a formula.
			for (const cell of line.split(';')) expect(cell).not.toMatch(/^[=+\-@]/);
			expect(pairs(line)).toEqual({
				run: label,
				engine: '1.4.0',
				runoff_model: 'gr4j',
				created: '2026-09-27T08:15:00.000Z',
				period: '2021-10-01..2022-01-28'
			});
		}
	});

	it('puts the legacy warning first when the run is legacy, then the provenance line, then the table', () => {
		const table = ['date,x', '2020-01-01,1'];
		const legacy = { ...run, runoffModel: 'legacy' };
		expect([...withRunComments(true, legacy, table)]).toEqual([LEGACY_RUN_CSV_COMMENT, runProvenanceComment(legacy), ...table]);
		expect([...withRunComments(false, run, table)]).toEqual([runProvenanceComment(run), ...table]);
	});
});

describe('collectCsv', () => {
	it('prefixes a UTF-8 BOM and ends every record with CRLF', () => {
		expect(collectCsv(['a,b', '1,2'])).toBe(`${BOM}a,b\r\n1,2\r\n`);
	});

	it('returns null as soon as the body would exceed the cap (counting UTF-8 bytes)', () => {
		expect(collectCsv(['m³'], 3 + 3 + 2)).toBe(`${BOM}m³\r\n`); // BOM 3 + "m³" 3 + CRLF 2
		expect(collectCsv(['m³'], 7)).toBeNull();
		let pulled = 0;
		function* many() {
			for (;;) {
				pulled++;
				yield 'x'.repeat(100);
			}
		}
		expect(collectCsv(many(), 1000)).toBeNull();
		expect(pulled).toBeLessThan(20); // stops early instead of building everything
	});

	it('sizes a full node export over a long record well under the cap', () => {
		// 45 years (16 437 days) × 13 series of 7-digit volumes: the documented worst realistic case.
		const cols = Array.from({ length: 13 }, (_, i) => ({ header: `Series ${i} (m³/day)`, values: new Array(16_437).fill(1234567) }));
		const body = collectCsv(dailyCsvLines('1980-01-01', cols, { offset: 0, days: 16_437 }));
		expect(body).not.toBeNull();
		expect(Buffer.byteLength(body!, 'utf8')).toBeLessThan(2 * 1024 * 1024);
	});
});

describe('file names', () => {
	it('slugifies to safe ASCII', () => {
		expect(slugify('Client Catchment (v2)')).toBe('client-catchment-v2');
		expect(slugify('Élandsbaai — Dam #3')).toBe('elandsbaai-dam-3');
		expect(slugify('***', 'project')).toBe('project');
		expect(slugify('a'.repeat(100)).length).toBe(60);
	});

	// Whatever zone the server runs in (a skewed TZ on either side of UTC), the date is the project's (issue #45).
	describe.each(['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])('under TZ=%s', (serverTz) => {
		const saved = process.env.TZ;
		beforeEach(() => {
			process.env.TZ = serverTz;
		});
		afterEach(() => {
			process.env.TZ = saved;
		});

		it('dates the file by the project’s calendar day: 23:30 UTC is already tomorrow in South Africa', () => {
			const now = new Date('2026-03-31T23:30:00Z'); // 01:30 SAST on 1 April
			expect(exportFilename('Client Catchment', ['Baseline', 'daily'], 'csv', 'Africa/Johannesburg', now)).toBe('client-catchment_baseline_daily_2026-04-01.csv');
			expect(exportFilename('', ['project'], 'json', 'Africa/Johannesburg', now)).toBe('project_project_2026-04-01.json');
			// A project kept in UTC, or west of it, still has 31 March.
			expect(exportFilename('P', ['x'], 'csv', 'UTC', now)).toBe('p_x_2026-03-31.csv');
			expect(exportFilename('P', ['x'], 'csv', 'America/Sao_Paulo', now)).toBe('p_x_2026-03-31.csv');
		});

		it('turns the date at local midnight, not UTC’s', () => {
			expect(exportFilename('P', ['x'], 'csv', 'Africa/Johannesburg', new Date('2026-03-31T21:59:59Z'))).toBe('p_x_2026-03-31.csv');
			expect(exportFilename('P', ['x'], 'csv', 'Africa/Johannesburg', new Date('2026-03-31T22:00:00Z'))).toBe('p_x_2026-04-01.csv');
		});
	});

	it('falls back to the default zone for a zone the runtime doesn’t know', () => {
		expect(localDate(new Date('2026-03-31T23:30:00Z'), 'Mars/Olympus_Mons')).toBe('2026-04-01');
	});

	it('builds an attachment header without injectable characters', () => {
		expect(attachment('a_b-1.csv')).toBe('attachment; filename="a_b-1.csv"');
		expect(attachment('x"; y\r\n.csv')).toBe('attachment; filename="x___y__.csv"');
	});
});
