// The message catalogue loads only on the translated surfaces (WP-2.5): the
// root layout imports it dynamically, and the modules the workspace and
// /share share with the farm view import no catalogue module at all. A static
// import here would put messages/en.ts in every page's download again.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** Static (non-type) imports of the catalogue or the message functions. */
const staticCatalogueImports = (code: string) =>
	[...code.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+['"]([^'"]+)['"]/gm)]
		.map((m) => m[1]!)
		.filter((p) => /i18n\/(locale\.svelte|messages\/|LanguageSwitch)|components\/farm\/(format|cards|chart|why|dam)$|auth-extras\/VerifyEmailBanner/.test(p));

describe('the catalogue stays off untranslated routes', () => {
	it('the root layout imports it only dynamically', () => {
		const layout = src('routes/+layout.svelte');
		expect(staticCatalogueImports(layout)).toEqual([]);
		expect(layout).toContain("import('$lib/i18n/locale.svelte')");
	});

	for (const file of [
		'lib/api/emailAuth.ts',
		'lib/i18n/state.svelte.ts',
		'lib/components/farm/numbers.ts',
		'lib/components/farm/notice.ts',
		'lib/components/farm/chartGeometry.ts',
		'lib/components/farm/NoticeCard.svelte',
		'lib/components/share/share.ts',
		'lib/components/share/chart.ts',
		'lib/components/share/FlowChart.svelte',
		'routes/share/+page.svelte'
	]) {
		it(`${file} imports no catalogue module`, () => {
			expect(staticCatalogueImports(src(file))).toEqual([]);
		});
	}
});
