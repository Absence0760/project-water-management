// Which of several series of one kind a run reads (issue #523): the first by
// name, in the byte order of the name's UTF-8, which is code point order. The
// backend's queries sort with `name COLLATE "C"` (runs/execute.ts
// loadLiveInput, feeds/fromUnits.ts), the scripts that read a project document
// (backend/scripts/fit-project.ts inputSeriesOf) and the Data tab's marks
// (frontend lib/series/pick.ts) with this, so all of them pick the same series
// whatever the database's collation or the browser's locale. Not localeCompare
// or an Intl.Collator: a linguistic order puts "average gauge" before
// "RAIN-B logger" where byte order puts it after, and glibc and musl Postgres
// disagree on it for the same collation name.

/**
 * Byte order of the UTF-8 of two series names: −1, 0 or 1, as Postgres sorts
 * `COLLATE "C"`. Compares code points, not UTF-16 code units, which order a
 * character above U+FFFF before U+E000–U+FFFF where UTF-8 puts it after.
 */
export function compareSeriesNames(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; ) {
		const ca = a.codePointAt(i)!;
		const cb = b.codePointAt(i)!;
		if (ca !== cb) return ca < cb ? -1 : 1;
		i += ca > 0xffff ? 2 : 1;
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
