// A sentence with emphasised parts, so the wording modules own every word
// (and the tests read the whole sentence) while the component only decides
// that `{ b }` renders as <strong>. Rendered by Rich.svelte.
export type RichPart = string | { b: string };
export type Rich = RichPart[];

/** The sentence as plain text (tests, visually hidden summaries). */
export function plainText(r: Rich): string {
	return r.map((p) => (typeof p === 'string' ? p : p.b)).join('');
}
