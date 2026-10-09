/**
 * Server-rendered Svelte markup with its hydration markers (`<!--[-->`,
 * `<!--]-->`, …) cut out, so a test reads the text as a person sees it.
 * Split at every opener, each piece keeping what follows its closer: no
 * marker survives, however they sit together (no regex replace, which can
 * leave a marker that two others were split around).
 */
export function withoutComments(html: string): string {
	const [head, ...rest] = html.split('<!--');
	return head + rest.map((piece) => (piece.includes('-->') ? piece.slice(piece.indexOf('-->') + 3) : '')).join('');
}
