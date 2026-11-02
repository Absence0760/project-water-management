// A printable report page's print set-up (docs/ui.md § Report): while the
// page is open, an `@page` rule in <head> (A4, the report's margins, and the
// running footer with "Page X of Y" once the page knows its footer,
// report/printPage.ts), kept in step with the footer, and a print in the
// light theme (report/printTheme.ts). The catchment report, the evidence
// report, an evidence pack's page and the applicant's copy all print this
// way, so the browser's Download PDF and the server-side PDF (backend
// reports/render.ts, which adds no footer of its own) carry the same footer.
import { untrack } from 'svelte';
import { reportPageRule } from './printPage';
import { forceLightForPrint, restoreThemeAfterPrint } from './printTheme';

/**
 * Call during a component's set-up. `footer` is read reactively: the rule
 * gains the footer once it is known. `active` false (another component on the
 * page owns the print) adds nothing.
 */
export function printedPage(footer: () => string | undefined, active: () => boolean = () => true): void {
	const rule = $derived(reportPageRule(footer()));
	let style: HTMLStyleElement | null = null;
	$effect(() => {
		// Read the rule first: behind `style &&` a first run (before the style exists) would
		// never subscribe to it, and a footer known only once the page loads would never print.
		const text = rule;
		if (style) style.textContent = text;
	});
	$effect(() => {
		if (!active()) return;
		const own = document.createElement('style');
		own.textContent = untrack(() => rule);
		document.head.append(own);
		style = own;
		const before = () => forceLightForPrint();
		const after = () => restoreThemeAfterPrint();
		addEventListener('beforeprint', before);
		addEventListener('afterprint', after);
		return () => {
			own.remove();
			if (style === own) style = null;
			removeEventListener('beforeprint', before);
			removeEventListener('afterprint', after);
			restoreThemeAfterPrint();
		};
	});
}
