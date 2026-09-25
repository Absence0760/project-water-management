// The shared-string reader: only the entries asked for, SheetJS's indexing,
// and the two places it departs from SheetJS on purpose. Plain, rich and
// phonetic entries against SheetJS are compared in ./readerParity.test.ts.
import { describe, expect, it } from 'vitest';
import { UnreadableWorkbookError } from './errors';
import { MAX_STRING_CHARS, SharedStringsReader } from './sharedStrings';
import { MAIN_NS } from './testPackage';
import { scanXml } from './xml';

function read(items: string, needed: number[]): SharedStringsReader {
	const r = new SharedStringsReader(new Set(needed), 'sharedStrings.xml');
	scanXml(new TextEncoder().encode(`<sst xmlns="${MAIN_NS}">${items}</sst>`), 'sharedStrings.xml', r);
	return r;
}

describe('SharedStringsReader', () => {
	it('keeps only the entries the sheets use', () => {
		const r = read('<si><t>zero</t></si><si><t>one</t></si><si><r><t>tw</t></r><r><t>o</t></r></si>', [0, 2]);
		expect(r.count).toBe(3);
		expect([...r.strings]).toEqual([
			[0, 'zero'],
			[2, 'two']
		]);
	});

	it("reads index count as '' (SheetJS's trailing entry) and nothing past it", () => {
		const r = read('<si><t>a</t></si>', [1, 2]);
		expect(r.get(1)).toBe('');
		expect(r.get(2)).toBeUndefined();
		const none = new SharedStringsReader(new Set([0]), 'x');
		scanXml(new TextEncoder().encode('<other/>'), 'x', none);
		expect(none.get(0)).toBeUndefined();
	});

	it("reads a self-closing <si/> and a self-closing first <t/> as '' where SheetJS read markup", () => {
		const r = read('<si/><si><t/><phoneticPr fontId="1"/></si><si><t>after</t></si>', [0, 1, 2]);
		expect([r.get(0), r.get(1), r.get(2)]).toEqual(['', '', 'after']);
	});

	it('refuses markup inside a string it needs, and ignores it in one it skips', () => {
		expect(() => read('<si><t>a<b/>c</t></si>', [0])).toThrow(UnreadableWorkbookError);
		expect(read('<si><t>a<b/>c</t></si>', []).count).toBe(1);
	});

	it('caps the length of a string', () => {
		expect(() => read(`<si><t>${'x'.repeat(MAX_STRING_CHARS + 1)}</t></si>`, [0])).toThrow(UnreadableWorkbookError);
	});
});
