// The assistant answer's parser (answerText.ts; issue #610, the 2026-10-30
// production test): the subset the sheet shows, hostile text kept as text,
// unclosed and nested marks, streaming, and long lines in linear time. The
// rendering (escaped text nodes, no {@html}) is AssistantPanel.test.ts's.
import { describe, expect, it } from 'vitest';
import { parseAnswer, parseInline, type Block } from './answerText';

const t = (text: string) => ({ kind: 'text', text }) as const;
const b = (text: string) => ({ kind: 'strong', text }) as const;
/** Every string the tree holds, joined: what reaches the page as text. */
const strings = (blocks: Block[]): string =>
	blocks
		.map((x) => (x.kind === 'p' ? x.lines.flat() : x.kind === 'heading' ? x.parts : x.kind === 'pre' ? [t(x.text)] : x.items.flat()).map((p) => p.text).join(''))
		.join('|');

describe('parseInline', () => {
	it('reads **bold**, *italics* and `code`, the rest as text', () => {
		expect(parseInline('The **calibration site** is *optional*, see `outlet`.')).toEqual([
			t('The '),
			b('calibration site'),
			t(' is '),
			{ kind: 'em', text: 'optional' },
			t(', see '),
			{ kind: 'code', text: 'outlet' },
			t('.')
		]);
	});

	it('leaves unclosed and unpaired marks as written', () => {
		expect(parseInline('**not closed')).toEqual([t('**not closed')]);
		expect(parseInline('a `tick')).toEqual([t('a `tick')]);
		expect(parseInline('5*3*2 and a*b')).toEqual([t('5*3*2 and a*b')]);
		expect(parseInline('** spaced **')).toEqual([b(' spaced ')]);
		expect(parseInline('****')).toEqual([t('****')]);
	});

	it('keeps marks inside bold as text (no nesting)', () => {
		expect(parseInline('**a *b* `c`**')).toEqual([b('a *b* `c`')]);
	});

	it('streaming: an unclosed bold or code on the last line runs to its end, a lone trailing mark is held back', () => {
		expect(parseInline('Runs **without a cal', true)).toEqual([t('Runs '), b('without a cal')]);
		expect(parseInline('Runs **', true)).toEqual([t('Runs ')]);
		expect(parseInline('see `outl', true)).toEqual([t('see '), { kind: 'code', text: 'outl' }]);
	});
});

describe('parseAnswer', () => {
	it('paragraphs, bullet and numbered lists, a heading as a bold line, a rule as a break', () => {
		const text = '### Minimum requirements\n\nThe model needs **two** things:\n- a network\n- a rainfall series\n\n---\n\n1. Draw the network\n2. Upload rain\n\nThen run it.\nNothing else.';
		expect(parseAnswer(text)).toEqual([
			{ kind: 'heading', parts: [t('Minimum requirements')] },
			{ kind: 'p', lines: [[t('The model needs '), b('two'), t(' things:')]] },
			{ kind: 'ul', items: [[t('a network')], [t('a rainfall series')]] },
			{ kind: 'ol', start: 1, items: [[t('Draw the network')], [t('Upload rain')]] },
			{ kind: 'p', lines: [[t('Then run it.')], [t('Nothing else.')]] }
		]);
	});

	it('a list right after a line, * and + bullets, a numbered list starting later, an indented line carrying an item on', () => {
		expect(parseAnswer('Needed:\n* one\n+ two\n  still two\n\n3. third')).toEqual([
			{ kind: 'p', lines: [[t('Needed:')]] },
			{ kind: 'ul', items: [[t('one')], [t('two'), t(' '), t('still two')]] },
			{ kind: 'ol', start: 3, items: [[t('third')]] }
		]);
	});

	it('a loose list (blank lines between items) stays one list', () => {
		expect(parseAnswer('- a\n\n- b\n\nAfter.')).toEqual([
			{ kind: 'ul', items: [[t('a')], [t('b')]] },
			{ kind: 'p', lines: [[t('After.')]] }
		]);
	});

	it('a heading drops its closing #s; a #word is no heading', () => {
		expect(parseAnswer('## Fit ##')).toEqual([{ kind: 'heading', parts: [t('Fit')] }]);
		expect(parseAnswer('#hashtag')).toEqual([{ kind: 'p', lines: [[t('#hashtag')]] }]);
		expect(parseAnswer('## ')).toEqual([]);
	});

	it('a rule ends a list, where a blank line doesn’t', () => {
		expect(parseAnswer('- a\n---\n- b')).toEqual([
			{ kind: 'ul', items: [[t('a')]] },
			{ kind: 'ul', items: [[t('b')]] }
		]);
	});

	it('a fenced block is preformatted text, its marks untouched, closed or not', () => {
		expect(parseAnswer('```\n**x** <b>\n- y\n```\nafter')).toEqual([
			{ kind: 'pre', text: '**x** <b>\n- y' },
			{ kind: 'p', lines: [[t('after')]] }
		]);
		expect(parseAnswer('```\nopen')).toEqual([{ kind: 'pre', text: 'open' }]);
		expect(parseAnswer('```\n```js\n```')).toEqual([{ kind: 'pre', text: '```js' }]);
	});

	it('hostile text stays text: HTML, entities, script, a javascript: link', () => {
		const hostile = [
			'<script>alert(1)</script>',
			'<img src=x onerror="alert(1)">',
			'&lt;b&gt; &amp; &#60;i&#62;',
			'[click](javascript:alert(1)) <a href="https://example.com">x</a>',
			'**<img src=x onerror=alert(1)>**'
		].join('\n');
		const blocks = parseAnswer(hostile);
		// Only text, bold and paragraphs: no other node kind, and every character kept as written.
		expect(blocks).toHaveLength(1);
		expect(strings(blocks)).toBe(hostile.replace(/\n/g, '').replace('**<img src=x onerror=alert(1)>**', '<img src=x onerror=alert(1)>'));
		const kinds = new Set((blocks[0] as Extract<Block, { kind: 'p' }>).lines.flat().map((p) => p.kind));
		expect([...kinds].sort()).toEqual(['strong', 'text']);
	});

	it('CRLF line ends, and a table, kept as its lines', () => {
		expect(parseAnswer('a\r\nb')).toEqual([{ kind: 'p', lines: [[t('a')], [t('b')]] }]);
		expect(parseAnswer('| a | b |\n|---|---|')).toEqual([{ kind: 'p', lines: [[t('| a | b |')], [t('|---|---|')]] }]);
	});

	it('streaming: a last line that is only the start of a marker is held back, finished text is not', () => {
		for (const partial of ['#', '##', '-', '*', '**', '1', '12.', '`', '--'])
			expect(parseAnswer(`Done.\n${partial}`, true), partial).toEqual([{ kind: 'p', lines: [[t('Done.')]] }]);
		expect(parseAnswer('Done.\n-')).toEqual([{ kind: 'p', lines: [[t('Done.')], [t('-')]] }]);
		// As each delta arrives, the bold settles without its marks ever showing.
		expect(parseAnswer('- **Rain', true)).toEqual([{ kind: 'ul', items: [[b('Rain')]] }]);
		expect(parseAnswer('- **Rain** is needed', true)).toEqual([{ kind: 'ul', items: [[b('Rain'), t(' is needed')]] }]);
	});

	it('parses very long lines and many marks in linear time', () => {
		const n = 200_000;
		const cases = ['*'.repeat(n), `**${'a'.repeat(n)}`, `# ${' '.repeat(n)}x`, `${'a*'.repeat(n / 2)}`, `${'`'.repeat(n)}`, `- ${'- '.repeat(n / 2)}`, `${'* '.repeat(n / 2)}`];
		const started = performance.now();
		for (const text of cases) parseAnswer(text);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it('an empty answer has no blocks', () => {
		expect(parseAnswer('')).toEqual([]);
		expect(parseAnswer('\n\n')).toEqual([]);
	});
});
