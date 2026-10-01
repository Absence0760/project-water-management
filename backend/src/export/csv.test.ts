import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSV_DISCLAIMER_COMMENT } from '@water-management/engine';
import { localDate } from '../projects/timeZone.js';
import {
	attachment,
	BOM,
	csvBytes,
	csvChunks,
	csvStream,
	MAX_CSV_EXPORT_BYTES,
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
	withResultComments,
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

describe('result CSV comments: legacy run (audit H1) and disclaimer', () => {
	it('prepends the legacy comment only when legacy, then the disclaimer line always, then the header row', () => {
		const lines = ['date,Flow (m³/day)', '2020-01-01,1'];
		expect([...withResultComments(true, lines)]).toEqual([LEGACY_RUN_CSV_COMMENT, CSV_DISCLAIMER_COMMENT, ...lines]);
		expect([...withResultComments(false, lines)]).toEqual([CSV_DISCLAIMER_COMMENT, ...lines]);
		expect(LEGACY_RUN_CSV_COMMENT).toMatch(/^# runoff_model=legacy;/);
	});

	it('lands as the first line of the CSV body, ahead of the BOM-prefixed header', () => {
		const body = [...csvChunks(withResultComments(true, ['date,x', '2020-01-01,1']))].join('');
		expect(body).toBe(`${BOM}${LEGACY_RUN_CSV_COMMENT}\r\n${CSV_DISCLAIMER_COMMENT}\r\ndate,x\r\n2020-01-01,1\r\n`);
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
		expect([...withRunComments(true, legacy, table)]).toEqual([LEGACY_RUN_CSV_COMMENT, CSV_DISCLAIMER_COMMENT, runProvenanceComment(legacy), ...table]);
		expect([...withRunComments(false, run, table)]).toEqual([CSV_DISCLAIMER_COMMENT, runProvenanceComment(run), ...table]);
	});
});

/** A streamed body, read to the end as UTF-8 text (BOM kept). */
async function read(body: ReadableStream<Uint8Array>): Promise<string> {
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await new Response(body).arrayBuffer());
}

describe('csvBytes', () => {
	it('counts the BOM, each line in UTF-8 bytes and its CRLF', () => {
		expect(csvBytes(['a,b', '1,2'])).toBe(3 + 5 + 5);
		expect(csvBytes(['m³'], 3 + 3 + 2)).toBe(8); // BOM 3 + "m³" 3 + CRLF 2
		expect(csvBytes(['m³'], 7)).toBeNull();
	});

	it('stops as soon as the body would pass the cap, instead of walking everything', () => {
		let pulled = 0;
		function* many() {
			for (;;) {
				pulled++;
				yield 'x'.repeat(100);
			}
		}
		expect(csvBytes(many(), 1000)).toBeNull();
		expect(pulled).toBeLessThan(20);
	});

	it('caps the streamed CSVs at 50 MB: a century of a farm’s daily file fits, and the JSON cap stays 5 MB', () => {
		expect(MAX_CSV_EXPORT_BYTES).toBe(50 * 1024 * 1024);
		// ≈ 400 KB a year for a farm's full-precision daily CSV (docs/api.md § Export).
		expect(100 * 400 * 1024).toBeLessThan(MAX_CSV_EXPORT_BYTES);
	});
});

describe('csvChunks', () => {
	it('joins to the BOM and every line + CRLF, in pieces of about the chunk size', () => {
		const lines = Array.from({ length: 1000 }, (_, i) => `2000-01-01,${i}`);
		const chunks = [...csvChunks(lines, 1024)];
		expect(chunks.join('')).toBe(`${BOM}${lines.map((l) => `${l}\r\n`).join('')}`);
		expect(chunks.length).toBeGreaterThan(10);
		for (const c of chunks.slice(0, -1)) expect(c.length).toBeGreaterThanOrEqual(1024);
	});

	it('is the BOM alone for no lines', () => {
		expect([...csvChunks([])]).toEqual([BOM]);
	});
});

describe('csvStream', () => {
	it('streams the same body the lines make joined, with its measured size', async () => {
		const lines = () => withResultComments(true, ['date,m³', '2020-01-01,1', '2020-01-02,']);
		const csv = csvStream(lines)!;
		const text = await read(csv.body);
		expect(text).toBe(`${BOM}${[...lines()].map((l) => `${l}\r\n`).join('')}`);
		expect(csv.bytes).toBe(Buffer.byteLength(text, 'utf8'));
	});

	it('is null past the cap, before anything is streamed', () => {
		expect(csvStream(() => ['x'.repeat(100)], 50)).toBeNull();
	});

	it('streams a multi-decade node export past 6 MB without building it whole', async () => {
		// 60 years (21 915 days) × 32 full-precision columns: past the old buffered cap, well under the new one.
		const cols = Array.from({ length: 32 }, (_, i) => ({ header: `Series ${i} (m³/day)`, values: Array.from({ length: 21_915 }, (_, d) => d + i / 7) }));
		const csv = csvStream(() => dailyCsvLines('1960-01-01', cols, { offset: 0, days: 21_915 }))!;
		expect(csv.bytes).toBeGreaterThan(6 * 1024 * 1024);
		expect(csv.bytes).toBeLessThan(MAX_CSV_EXPORT_BYTES);
		const reader = csv.body.getReader();
		let total = 0;
		let pieces = 0;
		for (let r = await reader.read(); !r.done; r = await reader.read()) {
			total += r.value.byteLength;
			pieces++;
			expect(r.value.byteLength).toBeLessThan(1024 * 1024); // memory stays flat: no piece is the whole file
		}
		expect(total).toBe(csv.bytes);
		expect(pieces).toBeGreaterThan(50);
	});

	it('errors the stream, never ends it short, when the second walk differs from the measured one', async () => {
		let walk = 0;
		const csv = csvStream(() => (walk++ === 0 ? ['a', 'b'] : ['a']))!;
		await expect(read(csv.body)).rejects.toThrow(/measured/);
	});

	it('refuses a factory that hands back the same, spent, generator', async () => {
		const once = withResultComments(false, ['date,x']);
		const csv = csvStream(() => once)!;
		await expect(read(csv.body)).rejects.toThrow(/fresh iterable/);
	});

	it('stops reading the lines when the client cancels', async () => {
		let pulled = 0;
		function* many() {
			for (let i = 0; i < 100_000; i++) {
				pulled++;
				yield 'x'.repeat(100);
			}
		}
		const csv = csvStream(many)!;
		pulled = 0;
		const reader = csv.body.getReader();
		await reader.read();
		await reader.cancel();
		expect(pulled).toBeLessThan(2000);
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
