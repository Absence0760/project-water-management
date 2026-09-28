// Printing is always in the light theme, whatever the screen shows. The
// theme follows prefers-color-scheme unless <html data-theme> says otherwise
// (app.css), so a print sets data-theme="light" for its duration and puts the
// previous value back afterwards. Both calls are idempotent: every print-mode
// chart and the report page call them from their own beforeprint /
// afterprint listeners, and whichever runs first does the work.

type Root = Pick<Element, 'getAttribute' | 'setAttribute' | 'removeAttribute'>;

/** The data-theme value before the print (null = none); undefined while not forced. */
let saved: string | null | undefined;

export function forceLightForPrint(root: Root = document.documentElement): void {
	if (saved !== undefined) return;
	saved = root.getAttribute('data-theme');
	root.setAttribute('data-theme', 'light');
}

export function restoreThemeAfterPrint(root: Root = document.documentElement): void {
	if (saved === undefined) return;
	if (saved === null) root.removeAttribute('data-theme');
	else root.setAttribute('data-theme', saved);
	saved = undefined;
}
