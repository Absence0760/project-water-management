import { describe, expect, it } from 'vitest';
import { cssString, PAGE_MARGIN, reportPageRule } from './printPage';

describe('reportPageRule', () => {
	it('prints A4 with the report’s margins, and the running footer with page numbers once the page knows it', () => {
		expect(reportPageRule(undefined)).toBe(`@page { size: A4; margin: ${PAGE_MARGIN}; }`);
		const rule = reportPageRule('Dam · Run 1 · Model estimates.');
		expect(rule).toMatch(/^@page \{ size: A4; margin: 14mm 12mm 18mm; @bottom-center \{ content: "Dam · Run 1 · Model estimates\. Page " counter\(page\) " of " counter\(pages\) "\.";/);
		expect(rule.endsWith('} }')).toBe(true);
	});

	it('keeps a quote, backslash, brace or line break in a name inside the CSS string', () => {
		expect(cssString('A "dam" \\ B\nC')).toBe('"A \\22 dam\\22  \\5c  B\\a C"');
		// Braces and a closing style tag are plain characters inside a CSS string (and the rule is set as text, not HTML).
		expect(cssString('} @page { x </style>')).toBe('"} @page { x </style>"');
	});
});
