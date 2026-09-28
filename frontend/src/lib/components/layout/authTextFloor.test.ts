// The sign-in pages' small-text floor (issue #51, the accessibility persona):
// no text on the sign-in, sign-up, reset and emailed-link pages is set below
// 14 px (1rem of the 14 px root). Their labels, hints and links were 11–12 px
// on the first screen a reduced-vision farmer meets. This scans the styles of
// the files that draw those pages; e2e/tests/auth-pages.spec.ts measures the
// rendered text, the app-wide rules (app.css) included.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../..', import.meta.url));
const FILES = [
	'lib/components/layout/AuthCard.svelte',
	'lib/components/common/PasswordInput.svelte',
	'lib/components/legal/TermsSummary.svelte',
	'lib/components/auth-extras/TermsUpdate.svelte',
	'routes/login/+page.svelte',
	'routes/register/+page.svelte',
	'routes/forgot-password/+page.svelte',
	'routes/reset-password/+page.svelte',
	'routes/verify-email/+page.svelte',
	'routes/alerts/unsubscribe/+page.svelte'
];

/** Each `font-size` under 14 px in a file's <style> (rem at the 14 px root, px as given; em and clamp() skipped). */
function smallSizes(css: string): string[] {
	const small: string[] = [];
	for (const m of css.matchAll(/font-size:\s*([\d.]+)(rem|px)\b/g)) {
		const px = m[2] === 'rem' ? Number(m[1]) * 14 : Number(m[1]);
		if (px < 14) small.push(m[0]);
	}
	return small;
}

describe('the sign-in pages’ text floor', () => {
	it('finds a size under the floor and passes one at it', () => {
		expect(smallSizes('a { font-size: 0.85rem; } b { font-size: 1rem; } c { font-size: 13px; } d { font-size: 14px; }')).toEqual(['font-size: 0.85rem', 'font-size: 13px']);
	});

	it.each(FILES)('%s sets no text under 14 px', (file) => {
		const style = /<style>([\s\S]*?)<\/style>/.exec(readFileSync(SRC + file, 'utf8'))?.[1] ?? '';
		expect(smallSizes(style)).toEqual([]);
	});
});
