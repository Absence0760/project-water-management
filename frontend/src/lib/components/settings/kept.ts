// A switch in the Settings form that turns a value off keeps what it turned
// off until the form is saved or discarded (the page's draft holds it,
// settingsDraft.svelte.ts `kept`), so switching back on brings it back
// instead of a fresh default: a mis-click never throws typed values away.

/** The value for a switch: off is `off`; on is a copy of what was switched off, else `fresh()`. */
export function keptOr<T, Off>(on: boolean, last: T | null | undefined, fresh: () => T, off: Off): T | Off {
	if (!on) return off;
	return last != null ? (JSON.parse(JSON.stringify(last)) as T) : fresh();
}
