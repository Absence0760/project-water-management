// The help diagrams fit the guide's column whole from 1280 px (docs/design/
// ui-playbook.md § 3, "Never cut off, never too small"). Diagram.svelte never
// draws a diagram's smallest text under 9.5 px, so a drawing w units wide
// whose smallest text is 11 px (.m) needs w × 9.5 / 11 px; the guide's column
// is 582 px at 1280 × 800, which holds w ≤ 673. At 720 and wider, five of them
// scrolled sideways at 1280 (and the 920-wide model pipeline at 1440) until
// they were redrawn to 660. e2e/tests/diagram-labels.spec.ts measures the same
// thing on the page.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));
/** The widest a diagram may be drawn in viewBox units (see above). */
const MAX_WIDTH = 660;
const files = readdirSync(DIR).filter((f) => f.endsWith('.svelte'));

describe('help diagrams', () => {
	it('finds the diagrams', () => {
		expect(files.length).toBeGreaterThanOrEqual(8);
	});
	for (const f of files) {
		const text = readFileSync(join(DIR, f), 'utf8');
		it(`${f} is at most ${MAX_WIDTH} wide and sets no text size of its own`, () => {
			// The outer <svg>'s viewBox (markers have their own 10 × 10 ones).
			const viewBox = /<svg\b[^>]*?\sviewBox="0 0 (\d+(?:\.\d+)?) \d+(?:\.\d+)?"/.exec(text);
			expect(viewBox, f).not.toBeNull();
			expect(Number(viewBox![1]), f).toBeLessThanOrEqual(MAX_WIDTH);
			// Text sizes come from Diagram.svelte's classes (the smallest, .m, is 11 px): a smaller inline size would
			// widen the drawing's minimum and bring the sideways scroll back.
			expect(text, f).not.toMatch(/font-size/);
		});
	}
});
