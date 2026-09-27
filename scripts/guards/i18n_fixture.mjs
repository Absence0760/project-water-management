// A throwaway repo, just enough of one for i18n_sheet.mjs / i18n_apply.mjs /
// i18n_stamp.mjs to run against: used by their *.test.mjs to prove the
// tooling really is language-agnostic, with a stand-in language ('xx') that
// is never committed as a real catalogue (issue #58). Node's type stripping
// erases `import type`, so the fixture never needs the types these files
// point at (../locale.svelte, ./en.js, ./content.af): they're never resolved
// at runtime.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A fresh fixture root with 'en' and one stand-in language ('xx'), and one
 * untranslated message, email string and glossary entry. `extra` (relative
 * path → content) adds more files on top — e.g. a language's catalogues, to
 * test the "already translated" side without ever re-importing a path this
 * process wrote to (each call gets its own, never-before-imported root, so
 * there's no stale-module-cache risk). Returns the root and a cleanup
 * function.
 */
export function makeFixture(extra = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'i18n-fixture-'));
	const write = (rel, content) => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), content);
	};

	write(
		'packages/engine/src/languages.ts',
		`export const LANGUAGES = [
	{ code: 'en', name: 'English', intl: 'en-ZA', decimalMark: '.' },
	{ code: 'xx', name: 'Xx (stand-in, never shipped)', intl: 'en-ZA', decimalMark: '.' }
];
export const LOCALES = LANGUAGES.map((l) => l.code);
export const DEFAULT_LOCALE = 'en';
`
	);
	write(
		'frontend/src/lib/i18n/sheet.ts',
		`export const SECTIONS = { common: 'Words used on several pages.' };
export const NOTES = {};
`
	);
	write(
		'frontend/src/routes/fake.ts',
		`import { t } from '../lib/i18n/locale.svelte';
// i18n-section: common
t('Stand-in message');
`
	);
	write(
		'backend/src/mail/i18n/en.ts',
		`export const en = { 'mail.hello': 'Hello {name}' };
export const sections = { 'mail.hello': 'The stand-in email.' };
export const notes = {};
`
	);
	write('frontend/src/lib/help/farmer.ts', `export const FARMER_HELP = [{ id: 'stand-in-word', term: 'Stand-in', short: 'A short one.', long: 'A long one.', category: 'farmer' }];\n`);
	for (const [rel, content] of Object.entries(extra)) write(rel, content);

	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
