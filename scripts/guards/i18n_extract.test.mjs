import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeOf, extract, messageId, messagesIn, pluralId } from './i18n_extract.mjs';

const IMPORT = "import { msg, plural, t, tn, tRich } from '$lib/i18n/locale.svelte';\n";
const english = (found) => found.map((f) => f.english ?? f.forms);

test('ids are 8 hex digits of the English, and a context makes a different one', () => {
	assert.match(messageId('Your dam'), /^[0-9a-f]{8}$/);
	assert.equal(messageId('Your dam'), messageId('Your dam'));
	assert.notEqual(messageId('Your dam'), messageId('Your dam.'));
	assert.notEqual(messageId('Create account'), messageId('Create account', 'page title'));
	assert.notEqual(pluralId({ one: 'day', other: 'days' }), pluralId({ one: 'day', other: 'dayz' }));
});

test('reads t(), tRich() and msg() literals, each branch of a ?: chain, and not the condition', () => {
	const src = `${IMPORT}// i18n-section: s
const a = t('One {n}', { n });
const b = t(lang === 'en' ? 'English only' : 'Afrikaans only');
const c = t(x ? (y ? 'A' : 'B') : "C \\u2019s");
const d = [...tRich('**Bold** part', {})];
const e = msg(\`Template\`);
const f = obj.t('a method, not ours');
`;
	const { found, problems } = messagesIn(src, 'x.ts');
	assert.deepEqual(problems, []);
	assert.deepEqual(english(found), ['One {n}', 'English only', 'Afrikaans only', 'A', 'B', 'C ’s', '**Bold** part', 'Template']);
	assert.ok(found.every((f) => f.section === 's'));
});

test('skips comments, reads the context, and refuses a template with ${…}', () => {
	const src = `${IMPORT}// i18n-section: s
// t('in a line comment')
/* t('in a block comment') */
const r = /t\\('in a regex'\\)/;
t('Create account', {}, 'page title');
t(\`Hello \${name}\`);
`;
	const { found, problems } = messagesIn(src, 'x.ts');
	assert.deepEqual(english(found), ['Create account']);
	assert.equal(found[0].context, 'page title');
	assert.equal(problems.length, 1);
	assert.match(problems[0], /x\.ts:7: a message can't be a template/);
});

test('reads plural() and tn() forms, and needs "other"', () => {
	const src = `${IMPORT}// i18n-section: s
export const DAYS = plural({ one: 'day', other: 'days' });
tn(DAYS, 3);
tn({ one: '{n}st', two: '{n}nd', other: '{n}th' }, 1, {}, true);
plural({ one: 'lonely' });
`;
	const { found, problems } = messagesIn(src, 'x.ts');
	assert.deepEqual(english(found), [
		{ one: 'day', other: 'days' },
		{ one: '{n}st', two: '{n}nd', other: '{n}th' }
	]);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /needs an "other" form/);
});

test('in a component, reads the script and the markup’s {…} expressions, never its text', () => {
	const src = `<!-- i18n-section: page -->
<script lang="ts">
	${IMPORT}
	const title = t('Title');
</script>

<p>Don't read this: t('text')</p>
<button aria-label={t('Close')}>{cond ? t('Yes') : t('No')}</button>
<!-- i18n-section: other -->
<p>{t('After the marker')}</p>
<style>
	p::after { content: "t('style')"; }
</style>
`;
	const { found, problems } = messagesIn(src, 'x.svelte');
	assert.deepEqual(problems, []);
	assert.deepEqual(english(found), ['Title', 'Close', 'Yes', 'No', 'After the marker']);
	assert.deepEqual(
		found.map((f) => f.section),
		['page', 'page', 'page', 'page', 'other']
	);
	assert.match(codeOf(src, 'x.svelte').code, /t\('Close'\)/);
});

test('extract: one entry per message, "common" when used in two sections, and problems named by file and line', () => {
	const files = {
		'a.ts': `${IMPORT}// i18n-section: one\nt('Shared'); t('Only in a');\n`,
		'b.ts': `${IMPORT}// i18n-section: two\nt('Shared');\nt('Unmarked is fine here');\n`,
		'c.ts': `${IMPORT}t('Before any marker');\n`,
		'd.ts': `// no i18n import\nt('Not ours');\n`,
		'e.ts': `${IMPORT}// i18n-section: nowhere\nt('Unknown section');\n`
	};
	const { messages, problems } = extract({ files: Object.keys(files), read: (f) => files[f], sections: ['one', 'two'] });
	const bySection = Object.fromEntries([...messages.values()].map((m) => [m.english, m.section]));
	assert.deepEqual(bySection, { Shared: 'common', 'Only in a': 'one', 'Unmarked is fine here': 'two', 'Unknown section': 'nowhere' });
	assert.deepEqual(messages.get(messageId('Shared')).uses, ['a.ts:3', 'b.ts:3']);
	assert.equal(problems.length, 2);
	assert.match(problems[0], /^c\.ts:2: no section for "Before any marker"/);
	assert.match(problems[1], /^e\.ts:3: unknown section "nowhere"/);
});

test('the frontend’s own messages extract with no problems', () => {
	const { messages, problems } = extract();
	assert.deepEqual(problems, []);
	assert.ok(messages.size > 400);
});
