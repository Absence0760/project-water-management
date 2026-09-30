// The methodology statement (roadmap WP-3.13): docs/methodology/v<N>.md,
// versioned and never edited once published. `pnpm gen:liability` writes
// methodology.generated.ts (every version's id and the SHA-256 of its bytes)
// and methodology-text.generated.ts (the current version's text), and
// methodology.test.ts recomputes the hashes. A sign-off and an evidence pack
// cite the current version and its hash, so anyone holding one can hash the
// file at the engine's tag and compare.

export interface MethodologyVersion {
	/** methodology-1, methodology-2 … */
	version: string;
	/** The file under docs/methodology/. */
	file: string;
	/** SHA-256 (hex) of the file's UTF-8 bytes. */
	sha256: string;
}

/** The version id of docs/methodology/v<N>.md, or null for any other file name. */
export function methodologyVersionOf(file: string): string | null {
	const m = /^v([1-9]\d*)\.md$/.exec(file);
	return m ? `methodology-${m[1]}` : null;
}

/** Versions in order, oldest first; the last is current. */
export function sortMethodologyVersions<T extends { version: string }>(list: readonly T[]): T[] {
	const n = (v: string) => Number(v.slice('methodology-'.length));
	return [...list].sort((a, b) => n(a.version) - n(b.version));
}
