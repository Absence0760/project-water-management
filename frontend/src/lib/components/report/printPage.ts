// The report's printed page (docs/ui.md § Report): A4, its margins, and a
// running footer on every page, drawn by the browser in the bottom margin
// from CSS page-margin boxes (Chromium 131+). The footer is the page's
// data-report-footer (engine REPORT_FOOTER: project · run · the disclaimer's
// key point) and "Page X of Y". The browser's Download PDF and the
// server-side PDF (backend reports/render.ts, the same page in headless
// Chromium) both print it, so there is one footer, not two. A browser without
// margin boxes (Firefox) prints the pages without it.

/** The page margins; the bottom one holds the footer. backend reports/render.ts PDF_MARGIN is the same. */
export const PAGE_MARGIN = '14mm 12mm 18mm';

/**
 * A CSS string literal of `text`: a quote, a backslash or a control
 * character in a project or run name can't end the string or the rule.
 */
export function cssString(text: string): string {
	return `"${text.replace(/["\\\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

/** The @page rule the report adds while it is open: with the footer once the page knows it. */
export function reportPageRule(footer: string | undefined): string {
	const box = footer
		? ` @bottom-center { content: ${cssString(`${footer} Page `)} counter(page) " of " counter(pages) "."; width: 100%; text-align: left; vertical-align: middle; font: 7pt/1.3 sans-serif; color: #444; }`
		: '';
	return `@page { size: A4; margin: ${PAGE_MARGIN};${box} }`;
}
