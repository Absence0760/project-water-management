// Whether the app is drawn dark, for the map and its key (#326 E8). app.css
// follows prefers-color-scheme unless <html data-theme> says otherwise (the
// app's own switch, and printTheme.ts while printing), so reading only the OS
// preference draws a light map in a dark app. Same rule as LineChart's.

/** The app's theme now: `data-theme` on <html> when set, else the OS preference. */
export function appIsDark(root: Pick<Element, 'getAttribute'> = document.documentElement, prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches): boolean {
	const theme = root.getAttribute('data-theme');
	if (theme === 'dark') return true;
	if (theme === 'light') return false;
	return prefersDark();
}

/** Call `on` whenever the app's theme may have changed (the OS preference or `data-theme`); returns the unsubscribe. */
export function watchAppTheme(on: () => void): () => void {
	const mq = matchMedia('(prefers-color-scheme: dark)');
	mq.addEventListener('change', on);
	const mo = new MutationObserver(on);
	mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
	return () => {
		mq.removeEventListener('change', on);
		mo.disconnect();
	};
}
