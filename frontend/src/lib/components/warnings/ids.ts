// Stable ids for the Warnings page's kept run warnings and problems (settings.warningsKept, issue #611): the same
// warning in the next run gets the same id, so keeping it holds; a different one gets another.

/** 8 hex digits of FNV-1a over the text: short, stable, not a security hash. */
export function stableHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * A run warning's id: its code and the names in its params (a station, a unit, a product), not its counts, which
 * change with every run (`run:rain.station.unreliable:1a2b3c4d`); an uncoded one by its words with the numbers
 * taken out (`run:text:…`).
 */
export function runWarningId(code: string | null, params: Record<string, string | number> | null | undefined, text: string): string {
	if (code) {
		const names = Object.entries(params ?? {})
			.filter(([, v]) => typeof v === 'string')
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([k, v]) => `${k}=${v}`)
			.join('&');
		return `run:${code}:${stableHash(`${code}|${names}`)}`;
	}
	return `run:text:${stableHash(text.toLowerCase().replace(/[−-]?\d[\d.,\s]*/g, '#'))}`;
}
