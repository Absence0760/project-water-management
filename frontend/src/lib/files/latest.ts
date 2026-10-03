// Reading a picked or dropped file is async, and a picker stays live while
// it runs: pick a large file, then a small one, and the large read can land
// last, over the small one (its text shown, or uploaded, under the second
// file's name; issue #384). A guard for a whole read-then-request step lives
// beside its caller (packs/pack.ts latestOnly, share/load.ts latestOnly).

/**
 * Reads a picked file's text, the latest pick only: a read that a later pick
 * (or a cleared one, null) started after resolves to null, so a large file
 * still being read can't land over a smaller one picked after it. A
 * superseded read's failure resolves to null too (no longer news); the
 * latest read's failure is thrown. One reader per file box.
 */
export function latestFileText(): (f: Pick<Blob, 'text'> | null) => Promise<string | null> {
	let latest = 0;
	return async (f) => {
		const mine = ++latest;
		if (!f) return null;
		let text: string;
		try {
			text = await f.text();
		} catch (err) {
			if (mine !== latest) return null;
			throw err;
		}
		return mine === latest ? text : null;
	};
}
