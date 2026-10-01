// The message code loads only on the translated surfaces (WP-2.5): the root
// layout imports it dynamically, and the modules the workspace shares with the
// farm view (and /share) import none of it. They may mark their English with
// msg() from $lib/i18n/msg, which imports nothing and holds no words. A static
// import of the message code here would put it in every page's download again.
// /share is translated too, but stays off the workspace's code: it imports
// only its own modules, the farm view's catalogue-free ones and the i18n (the
// engine too: pure, no workspace code, and the page's formatting already
// reads its constants; the notice picks its language with the engine's
// pickNotice and names it from the engine's language table, issue #58), and
// the two pure formatting modules $lib/format/number and $lib/format/age (no
// words, no workspace code: the one staleness limit and age count, issue #162).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** Static (non-type) imports of the catalogue or the message functions. */
const staticCatalogueImports = (code: string) =>
	[...code.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+['"]([^'"]+)['"]/gm)]
		.map((m) => m[1]!)
		.filter((p) => /i18n\/(locale\.svelte|messages\/|LanguageSwitch|apiError)|components\/farm\/(format|cards|chart|why|dam|notesWords)$|auth-extras\/VerifyEmailBanner/.test(p));

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
		// The workspace's alert panel and rule editor (WP-2.13); the translated alert pages use alerts/words.ts.
		'lib/components/alerts/alerts.ts',
		'lib/components/alerts/AlertsPanel.svelte',
		'lib/components/alerts/AlertRulesEditor.svelte',
		// The notes list the workspace shares with the farm card: it takes the farm card's words as a prop (WP-2.5).
		'lib/components/notes/NotesList.svelte',
		'lib/components/notes/notes.ts',
		'lib/components/notes/words.ts'
	]) {
		it(`${file} imports no catalogue module`, () => {
			expect(staticCatalogueImports(src(file))).toEqual([]);
		});
	}
});

it('msg() imports nothing, so marking a message costs a shared module nothing', () => {
	expect(src('lib/i18n/msg.ts')).not.toMatch(/^\s*import\s/m);
});

describe('/share stays off the workspace’s code', () => {
	/** Static (non-type) imports of any module. */
	const imports = (code: string) => [...code.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
	const allowed = /^(svelte|\$app\/(navigation|paths|state)|\$lib\/api(\/types|\/client)?|@water-management\/engine|\$lib\/i18n\/(locale\.svelte|state\.svelte|msg|LanguageSwitch\.svelte|apiError)|\$lib\/components\/share\/[\w.]+|\$lib\/components\/farm\/(notice|numbers|format|chartGeometry|NoticeCard\.svelte)|\$lib\/components\/layout\/BrandMark\.svelte|\$lib\/format\/(age|number)|\.\/[\w.]+)$/;
	for (const file of [
		'routes/share/+page.svelte',
		'lib/components/share/share.ts',
		'lib/components/share/chart.ts',
		'lib/components/share/load.ts',
		'lib/components/share/FlowChart.svelte',
		'lib/components/share/summary.ts',
		'lib/components/share/MemberSummary.svelte',
		'lib/components/share/SummaryControls.svelte',
		'lib/components/share/scenario.ts',
		'lib/components/share/ScenarioView.svelte',
		'lib/components/farm/format.ts',
		'lib/components/farm/notice.ts',
		'lib/components/farm/NoticeCard.svelte'
	]) {
		it(`${file} imports only /share's own, the farm view's shared and the i18n modules`, () => {
			expect(imports(src(file)).filter((p) => !allowed.test(p))).toEqual([]);
		});
	}
});
