// No raw HTML anywhere in the app (roadmap WP-2.16, stored XSS through notes
// or notices; docs/security.md § Input handling). Everything a person types
// (notes, the WUA's notice, farm, series and project names, a share link's
// label) is rendered through Svelte's escaping, which is the XSS defence: a
// `{@html …}` block, or an `innerHTML`-style DOM write, would put that text
// back into the page as markup. Help and guide text uses its own parser
// (lib/help), never HTML. If a real need for raw markup ever comes up, it
// needs a sanitiser and an entry here with its reason, not a quiet exception.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** `{@html expr}`: the block with an expression, not a comment that names it ("never {@html}"). */
const HTML_BLOCK = /\{@html\s+[^}\s]/g;
/** DOM writes that parse a string as markup. */
const DOM_HTML = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\.write(ln)?\s*\(|\bcreateContextualFragment\s*\(/g;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.isDirectory()) return sourceFiles(join(dir, e.name));
		if (e.name.endsWith('.test.ts')) return [];
		return /\.(svelte|ts|js)$/.test(e.name) ? [join(dir, e.name)] : [];
	});
}

describe('raw HTML', () => {
	it('the patterns find the block and the DOM writes, and pass a comment and a comparison', () => {
		expect('{@html note.body}'.match(HTML_BLOCK)).toHaveLength(1);
		expect('// never {@html}'.match(HTML_BLOCK)).toBeNull();
		expect('el.innerHTML = body'.match(DOM_HTML)).toHaveLength(1);
		expect('el.outerHTML += body'.match(DOM_HTML)).toHaveLength(1);
		expect('el.insertAdjacentHTML("beforeend", body)'.match(DOM_HTML)).toHaveLength(1);
		expect('document.write(body)'.match(DOM_HTML)).toHaveLength(1);
		expect('range.createContextualFragment(body)'.match(DOM_HTML)).toHaveLength(1);
		expect('if (el.innerHTML === "") {}'.match(DOM_HTML)).toBeNull();
		expect('el.textContent = body'.match(DOM_HTML)).toBeNull();
	});

	it('no component or module renders a string as HTML', () => {
		const src = fileURLToPath(new URL('../', import.meta.url));
		const files = sourceFiles(src);
		// Positive control: the walk reaches the notes list and the notice card.
		expect(files.length).toBeGreaterThan(100);
		expect(files.some((f) => f.endsWith('notes/NotesList.svelte'))).toBe(true);
		expect(files.some((f) => f.endsWith('farm/NoticeCard.svelte'))).toBe(true);
		const offenders = files.flatMap((f) => {
			const text = readFileSync(f, 'utf8');
			return [...(text.match(HTML_BLOCK) ?? []), ...(text.match(DOM_HTML) ?? [])].map((m) => `${f.slice(src.length)}: ${m}`);
		});
		expect(offenders).toEqual([]);
	});
});
