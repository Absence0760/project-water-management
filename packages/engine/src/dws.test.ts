import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DWS_GAP_CODES, DWS_HEADER, DWS_ROW, dwsColumns, dwsTableText, parseDwsRow, stripHtmlComments } from './dws';

// Synthetic (invented station and values), shared with the feed's and the manual import's tests.
const fixture = readFileSync(new URL('../fixtures/dws-daily-export.txt', import.meta.url), 'utf8');
const HEADER = 'DATE     D AVG F/R  QUAL';
const cols = dwsColumns(HEADER);

describe('dwsColumns', () => {
	it('places the value and QUAL columns by where their labels end', () => {
		expect(cols).toEqual({ valueEnd: 18, qualEnd: 24 });
		expect(dwsColumns('date d_avg_fr qual')).toEqual({ valueEnd: 13, qualEnd: 18 });
		expect(dwsColumns('DATE D_AVG_FR')).toBeNull();
	});
});

describe('parseDwsRow', () => {
	it('reads a date, a value and a quality code', () => {
		expect(parseDwsRow('20210101     0.412     1', cols)).toEqual({ date: '20210101', iso: '2021-01-01', value: 0.412, rawValue: '0.412', quality: '1', gap: null });
	});

	it('reads a lone number ending under QUAL as the code (a blank-value gap row), and one under the value column as the value', () => {
		expect(parseDwsRow('20210104             170', cols)).toMatchObject({ value: null, quality: '170', gap: 'code' });
		expect(parseDwsRow('20210104             999', cols)).toMatchObject({ value: null, quality: '999', gap: 'blank' });
		expect(parseDwsRow('20210104     0.412', cols)).toMatchObject({ value: 0.412, gap: null });
		// Without a header nothing says where QUAL is: a lone field is the value.
		expect(parseDwsRow('20210104 170', null)).toMatchObject({ value: 170, gap: null });
	});

	it('makes every missing-data code a gap, whatever the value column holds', () => {
		for (const q of DWS_GAP_CODES) expect(parseDwsRow(`20210105     0.000 ${q.padStart(5)}`, cols)).toMatchObject({ value: null, gap: 'code', quality: q });
	});

	it('makes -999 and any other negative a gap, and keeps a flagged but real value', () => {
		expect(parseDwsRow('20210106  -999.000     1', cols)).toMatchObject({ value: null, gap: 'negative', rawValue: '-999.000' });
		expect(parseDwsRow('20210106    -1.000   152', cols)).toMatchObject({ value: null, gap: 'negative' });
		expect(parseDwsRow('20210107    12.500    60', cols)).toMatchObject({ value: 12.5, gap: null });
		expect(parseDwsRow('20210107     0.000     2', cols)).toMatchObject({ value: 0, gap: null });
	});

	it('makes text a gap, and says an impossible date is one', () => {
		expect(parseDwsRow('20210101       abc     1', cols)).toMatchObject({ value: null, gap: 'text' });
		expect(parseDwsRow('20210101     1e400     1', cols)).toMatchObject({ value: null, gap: 'text' });
		expect(parseDwsRow('20210230     1.000     1', cols)).toMatchObject({ iso: null });
		expect(parseDwsRow('20210101', cols)).toMatchObject({ value: null, gap: 'blank' });
	});
});

describe('dwsTableText', () => {
	it('takes a saved page’s <pre>, decoded, and ignores a commented-out one', () => {
		expect(dwsTableText(`<!-- <pre>old</pre> --><html><body><pre>DATE&nbsp;D_AVG_FR QUAL<br>20210101 1 1</pre></body></html>`)).toBe('DATE D_AVG_FR QUAL\n20210101 1 1');
	});

	it('takes a plain table as it is, and gives null for an HTML page with no table', () => {
		expect(dwsTableText(fixture)).toBe(fixture);
		expect(dwsTableText('<html><body>Access denied</body></html>')).toBeNull();
	});
});

describe('the shared fixture', () => {
	it('has one header, ten dated rows and the gaps the feed and the import both expect', () => {
		const lines = fixture.split('\n');
		expect(lines.filter((l) => DWS_HEADER.test(l))).toEqual([HEADER]);
		const rows = lines.filter((l) => DWS_ROW.test(l.trim())).map((l) => parseDwsRow(l, cols));
		expect(rows.map((r) => r.value)).toEqual([0.412, 0.398, 1.897, null, null, null, 12.5, 0.371, 0.355, 0.349]);
		expect(rows.map((r) => r.gap).filter(Boolean)).toEqual(['code', 'code', 'negative']);
	});
});

describe('stripHtmlComments', () => {
	it('removes each comment, keeps the text around it, and leaves an unclosed one in place', () => {
		expect(stripHtmlComments('a<!-- x -->b<!--y-->c')).toBe('abc');
		expect(stripHtmlComments('<!-- mentions <pre> -->DATE')).toBe('DATE');
		expect(stripHtmlComments('a<!-->b-->c')).toBe('ac');
		expect(stripHtmlComments('a<!-- open')).toBe('a<!-- open');
		expect(stripHtmlComments('a<!-- x -->b<!-- open')).toBe('ab<!-- open');
	});
	// The regex it replaced retried from every unclosed "<!--" (CodeQL js/polynomial-redos): a page of
	// them hung the parser. The scan returns at once.
	// The timeout is a hang guard, not a budget: the engine's default is 120 s, which the old pattern fit inside.
	it('returns a page of unclosed comment openers unchanged', { timeout: 5_000 }, () => {
		const hostile = '<!--'.repeat(200_000);
		expect(stripHtmlComments(hostile)).toBe(hostile);
	});
});

describe('dwsTableText on hostile pages', () => {
	it('reads the first <pre> whatever its case and attributes, and never takes <prefix> for one', () => {
		expect(dwsTableText('<html><PRE class="t">DATE X QUAL</PRE><pre>second</pre></html>')).toBe('DATE X QUAL');
		expect(dwsTableText('<html><prefix>no</prefix><pre>\nDATE X</pre></html>')).toBe('\nDATE X');
		expect(dwsTableText('<html><pre>never closed</html>')).toBeNull();
		expect(dwsTableText('\n\n  DATE X QUAL\n20210101 1 1')).toBe('\n\n  DATE X QUAL\n20210101 1 1');
	});
	// The regexes these replaced retried from every open "<pre" and every blank line (CodeQL
	// js/polynomial-redos). The timeout is a hang guard, not a budget: the engine's default is 120 s.
	it('returns at once on runs of open <pre tags and of blank lines', { timeout: 5_000 }, () => {
		expect(dwsTableText('<pre'.repeat(200_000))).toBeNull();
		expect(dwsTableText('<pre>a'.repeat(200_000))).toBeNull();
		expect(dwsTableText(`${'\n'.repeat(200_000)}x`)).toBeNull();
	});
});
