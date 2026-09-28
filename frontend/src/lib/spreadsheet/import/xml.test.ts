// The streaming XML tokenizer on well-formed, malformed and hostile parts:
// the same events whatever the chunking, and every refusal a typed
// UnreadableWorkbookError ('corrupt'), never a hang, an entity expansion or an
// unbounded buffer.
import { describe, expect, it } from 'vitest';
import { UnreadableWorkbookError } from './errors';
import { type XmlHandler, XmlScanner, binary, decodeXmlText, parseXmlBool, scanXml, unescapeXml, utf8read } from './xml';

const enc = new TextEncoder();

/** Every event as a line, text pieces merged, for comparing runs. */
function events(xml: string | Uint8Array, chunk = Infinity, limits = {}): string[] {
	const out: string[] = [];
	const push = (line: string) => {
		const last = out[out.length - 1];
		if (line.startsWith('text:') && last?.startsWith('text:')) out[out.length - 1] = last + line.slice(5);
		else out.push(line);
	};
	const h: XmlHandler = {
		open: (local, tag, self) => push(`open:${local}${self ? '/' : ''}:${JSON.stringify(tag.attributes())}`),
		close: (local) => push(`close:${local}`),
		text: (b, s, e) => push(`text:${binary(b, s, e)}`),
		cdata: (b, s, e) => push(`cdata:${binary(b, s, e)}`),
		markup: (b, s, e) => push(`markup:${binary(b, s, e)}`)
	};
	const bytes = typeof xml === 'string' ? enc.encode(xml) : xml;
	const scanner = new XmlScanner(h, 'test.xml', limits);
	for (let i = 0; i < bytes.length; i += chunk === Infinity ? bytes.length : chunk) scanner.push(bytes.subarray(i, chunk === Infinity ? bytes.length : i + chunk));
	scanner.end();
	return out;
}

const refusal = (xml: string | Uint8Array, limits = {}) => {
	try {
		events(xml, Infinity, limits);
	} catch (e) {
		if (e instanceof UnreadableWorkbookError) return `${e.reason}: ${e.detail}`;
		throw e;
	}
	return 'ok';
};

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<x:worksheet xmlns:x="urn:x" a='1' b = "two > three">
  <!-- comment -->
  <x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r='B1'/></x:row></x:sheetData>
  <t>a &amp; b &unknown; <![CDATA[<raw> & ]]]]></t><?pi data?>
</x:worksheet>`;

describe('XmlScanner', () => {
	it('reports tags, attributes, text, CDATA and markup', () => {
		expect(events(SAMPLE)).toEqual([
			`open:worksheet:[["xmlns:x","urn:x"],["a","1"],["b","two > three"]]`,
			'text:\n  ',
			'markup:<!-- comment -->',
			'text:\n  ',
			'open:sheetData:[]',
			'open:row:[["r","1"]]',
			'open:c:[["r","A1"],["t","s"]]',
			'open:v:[]',
			'text:0',
			'close:v',
			'close:c',
			'open:c/:[["r","B1"]]',
			'close:c',
			'close:row',
			'close:sheetData',
			'text:\n  ',
			'open:t:[]',
			'text:a &amp; b &unknown; ',
			'cdata:<raw> & ]]',
			'close:t',
			'markup:<?pi data?>',
			'text:\n',
			'close:worksheet'
		]);
	});

	it('gives the same events whatever the chunk boundaries', () => {
		const whole = events(SAMPLE);
		for (const size of [1, 2, 3, 5, 7, 16, 64]) expect(events(SAMPLE, size), `chunks of ${size}`).toEqual(whole);
	});

	it('resumes a long token split over many small chunks where its scan stopped', () => {
		const value = '>x'.repeat(450_000); // 900 KB, full of '>' inside the quotes
		const xml = enc.encode(`<a b="${value}"><!--${'-'.repeat(1000)}x--><![CDATA[${']'.repeat(1000)}]]></a>`);
		let got = 0;
		const scanner = new XmlScanner(
			{
				open: (_l, t) => (got = t.attributes()[0]![1].length),
				close() {},
				text() {},
				cdata() {}
			},
			'test.xml'
		);
		for (let i = 0; i < xml.length; i += 512) scanner.push(xml.subarray(i, i + 512));
		scanner.end();
		expect(got).toBe(value.length);
	});

	it('skips a UTF-8 byte-order mark, and refuses UTF-16', () => {
		expect(events(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('<a/>')]))).toEqual(['open:a/:[]', 'close:a']);
		expect(refusal(new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00]))).toMatch(/^corrupt: .*UTF-16/);
	});

	it('refuses unclosed, mismatched and stray tags', () => {
		expect(refusal('<a><b></a>')).toMatch(/^corrupt: .*<b> is closed by <\/a>/);
		expect(refusal('<a><b>')).toMatch(/^corrupt: .*<b> is never closed/);
		expect(refusal('<a></a></b>')).toMatch(/^corrupt: .*closes nothing/);
		expect(refusal('<a></a><b/>')).toMatch(/^corrupt: .*after the root element/);
		expect(refusal('<a>text')).toMatch(/^corrupt: .*never closed/);
		expect(refusal('<a b="1"')).toMatch(/^corrupt: .*ends inside a tag/);
		expect(refusal('<a><!-- never ends</a>')).toMatch(/^corrupt: .*ends inside a tag/);
		expect(refusal('<a><![CDATA[ never ends</a>')).toMatch(/^corrupt: .*ends inside a tag/);
		expect(refusal('<a b="<"/>')).toMatch(/^corrupt/);
		expect(refusal('<a <b/>')).toMatch(/^corrupt/);
		expect(refusal('')).toMatch(/^corrupt: .*no root element/);
		expect(refusal('   ')).toMatch(/^corrupt: .*no root element/);
		expect(refusal('text<a/>')).toMatch(/^corrupt: .*text outside the root/);
		expect(refusal('<![CDATA[x]]><a/>')).toMatch(/^corrupt: .*CDATA section outside/);
		expect(refusal('< a/>')).toMatch(/^corrupt: .*no name/);
	});

	it('refuses any DTD, so no entity is ever defined or expanded', () => {
		const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`;
		expect(refusal(laughs)).toMatch(/^corrupt: .*DTD/);
		expect(refusal('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a>&xxe;</a>')).toMatch(/^corrupt: .*DTD/);
		expect(refusal('<a><!ENTITY x "y"></a>')).toMatch(/^corrupt: .*DTD/);
		// Without a DTD, an entity reference stays as written: never expanded.
		expect(events('<a>&lol9;&amp;</a>')).toContain('text:&lol9;&amp;');
		expect(unescapeXml('&lol9;&amp;')).toBe('&lol9;&');
		expect(decodeXmlText('&lol9;&amp;')).toBe('&lol9;&');
	});

	it('caps the length of a tag, comment or CDATA section and the nesting depth', () => {
		const huge = `<a b="${'x'.repeat(2000)}"/>`;
		expect(refusal(huge, { maxTokenBytes: 1000 })).toMatch(/^corrupt: .*longer than any workbook writes/);
		expect(refusal(`<a><!--${'x'.repeat(2000)}--></a>`, { maxTokenBytes: 1000 })).toMatch(/longer than any workbook writes/);
		expect(refusal(`<a><![CDATA[${'x'.repeat(2000)}]]></a>`, { maxTokenBytes: 1000 })).toMatch(/longer than any workbook writes/);
		expect(refusal('<a>'.repeat(20) + '</a>'.repeat(20), { maxDepth: 10 })).toMatch(/nest deeper/);
		// An unterminated huge attribute fails as soon as it passes the cap, without waiting for the end.
		const scanner = new XmlScanner({ open() {}, close() {}, text() {}, cdata() {} }, 'test.xml', { maxTokenBytes: 1000 });
		scanner.push(enc.encode('<a b="'));
		expect(() => {
			for (let i = 0; i < 10; i++) scanner.push(enc.encode('x'.repeat(500)));
		}).toThrow(UnreadableWorkbookError);
	});

	it('reads the tag names and attributes it is given, strictly', () => {
		const attrs = (tag: string) => {
			let out: [string, string][] = [];
			scanXml(enc.encode(tag), 'test.xml', { open: (_l, t) => (out = t.attributes()), close() {}, text() {}, cdata() {} });
			return out;
		};
		expect(attrs('<a x:r="1" r=\'2\' empty=""/>')).toEqual([
			['x:r', '1'],
			['r', '2'],
			['empty', '']
		]);
		expect(() => attrs('<a b/>')).toThrow(UnreadableWorkbookError);
		expect(() => attrs('<a b=1/>')).toThrow(UnreadableWorkbookError);
	});
});

describe('cell text decoding (as openpyxl reads it, issue #22)', () => {
	it('expands the five entities and numeric references once, and leaves _xHHHH_ escapes as written', () => {
		expect(decodeXmlText('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;_x0043_ &nbsp; &amp;amp;')).toBe('<>&"\'AB_x0043_ &nbsp; &amp;');
		expect(decodeXmlText('Flow_x000D__x000A_(m3/day)')).toBe('Flow_x000D__x000A_(m3/day)');
		expect(decodeXmlText('a &amp;lt;b&amp;gt;')).toBe('a &lt;b&gt;');
	});

	it('decodes a reference beyond the BMP as one character', () => {
		expect(decodeXmlText('&#128167;&#x1F4A7;')).toBe('\u{1F4A7}\u{1F4A7}');
	});

	it('leaves a reference XML does not define as written (an XML parser would refuse the file)', () => {
		const odd = '&AMP; &#X41; &#0; &#xD800; &#1114112; &#; &#x;';
		expect(decodeXmlText(odd)).toBe(odd);
	});

	it('turns literal line breaks into LF, as an XML parser does, but keeps a CR written as a reference', () => {
		expect(decodeXmlText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
		expect(decodeXmlText('a&#13;&#10;b&#xD;c')).toBe('a\r\nb\rc');
	});

	it('keeps CDATA literally, line breaks normalised, and decodes around it', () => {
		expect(decodeXmlText('a<![CDATA[&amp; _x000D_\r\n]]>&amp;<![CDATA[x]]>')).toBe('a&amp; _x000D_\n&x');
		const long = '<![CDATA[' + 'x'.repeat(200_000) + '&amp;';
		expect(decodeXmlText(long)).toBe('<![CDATA[' + 'x'.repeat(200_000) + '&');
	});
});

describe('value decoding (SheetJS-compatible, for the workbook part)', () => {
	it('decodes the five entities, numeric references and _xHHHH_ escapes, nothing else', () => {
		expect(unescapeXml('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;_x0043_ &nbsp; &amp;amp;')).toBe('<>&"\'ABC &nbsp; &amp;');
		// SheetJS's quirk, kept: only a lowercase x makes a reference hexadecimal (&#X43; is decimal 43, '+').
		expect(unescapeXml('&#X43;')).toBe('+');
		// A reference beyond the BMP is truncated to 16 bits, as SheetJS's String.fromCharCode did.
		expect(unescapeXml('&#128512;')).toBe(String.fromCharCode(128512 & 0xffff));
	});

	it('keeps CDATA and line breaks literally', () => {
		expect(unescapeXml('a<![CDATA[&amp;]]>&amp;<![CDATA[x]]>')).toBe('a&amp;&x');
		expect(unescapeXml('a\r\nb')).toBe('a\r\nb');
	});

	it('decodes an unterminated or misordered CDATA marker as plain text (SheetJS went quadratic there)', () => {
		const long = '<![CDATA[' + 'x'.repeat(200_000);
		expect(unescapeXml(long)).toBe(long);
		expect(unescapeXml(']]>' + long)).toBe(']]>' + long);
	});

	it('decodes UTF-8 held in a binary string as SheetJS did', () => {
		const bytes = enc.encode('Ünïcödé 水 😀');
		expect(utf8read(binary(bytes, 0, bytes.length))).toBe('Ünïcödé 水 😀');
		expect(utf8read('plain ascii')).toBe('plain ascii');
	});

	it('parses xsd:boolean', () => {
		expect([parseXmlBool('1'), parseXmlBool('true'), parseXmlBool('0'), parseXmlBool('TRUE'), parseXmlBool(undefined)]).toEqual([true, true, false, false, false]);
	});
});
