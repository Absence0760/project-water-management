import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { addedLines, compileTerms, isReleasedMigration, parseTerms, scanText, termsFileCandidates } from './check_client_terms.mjs';

// Synthetic terms only: the real list lives outside the repo.
const patterns = compileTerms(parseTerms('# invented client\nMadeup River\nFakefarm  # a farm\n\n'));

test('parseTerms drops comments and blank lines', () => {
	assert.deepEqual(parseTerms('# c\nMadeup River\n  Fakefarm  # farm\n\n'), ['Madeup River', 'Fakefarm']);
});

test('a spaced term matches every spelling a rename produces', () => {
	for (const s of ['Madeup River', 'madeup river', 'MadeupRiver', 'madeup-river', 'madeup_river', 'data/madeupriver/x.json', "MadeupRiver's"]) {
		assert.equal(scanText(s, patterns).length, 1, s);
	}
});

test('a term split across a comment line break still matches', () => {
	assert.deepEqual(scanText('// plus the Madeup\n// River workbook', patterns), [{ line: 1, term: 1 }]);
	assert.deepEqual(scanText('# the Madeup\n# River', patterns), [{ line: 1, term: 1 }]);
});

test('whole words only, with the line and term number of each hit', () => {
	assert.deepEqual(scanText('Fakefarms and unFakefarm and Fakefarm2', patterns), []);
	assert.deepEqual(scanText('ok\nFakefarm!Z17 = 1\nMadeup River, Fakefarm', patterns), [
		{ line: 2, term: 2 },
		{ line: 3, term: 1 },
		{ line: 3, term: 2 },
	]);
});

test('addedLines keeps only added lines, with new-file line numbers', () => {
	const diff = [
		'diff --git a/a.md b/a.md',
		'--- a/a.md',
		'+++ b/a.md',
		'@@ -3,0 +4,2 @@',
		'+first',
		'+second',
		'@@ -10 +12 @@',
		'-old Fakefarm',
		'+new',
		'diff --git a/gone.md b/gone.md',
		'--- a/gone.md',
		'+++ /dev/null',
		'@@ -1 +0,0 @@',
		'-Fakefarm',
	].join('\n');
	assert.deepEqual(Object.fromEntries(addedLines(diff)), {
		'a.md': [
			{ line: 4, text: 'first' },
			{ line: 5, text: 'second' },
			{ line: 12, text: 'new' },
		],
	});
});

test('a linked worktree also looks beside the main checkout for the terms file', () => {
	const f = '/infra-secrets/water-management/client-terms.txt';
	assert.deepEqual(termsFileCandidates('/r/wm-a', '/r/main/.git'), ['/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/main/.claude/worktrees/x', '/r/main/.git'), ['/r/main/.claude/worktrees' + f, '/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/main', '/r/main/.git'), ['/r' + f]);
	assert.deepEqual(termsFileCandidates('/r/main', null), ['/r' + f]);
});

test('isReleasedMigration: only a migration identical to the tag, and any doubt is a no', () => {
	const same = Buffer.from('-- Fakefarm\n');
	const show = () => Buffer.from('-- Fakefarm\n');
	assert.equal(isReleasedMigration('backend/migrations/001_a.sql', same, 'backend@1.0.0', show), true);
	assert.equal(isReleasedMigration('backend/migrations/001_a.sql', Buffer.from('-- Fakefarm \n'), 'backend@1.0.0', show), false);
	assert.equal(isReleasedMigration('docs/a.md', same, 'backend@1.0.0', show), false);
	assert.equal(isReleasedMigration('backend/migrations/001_a.sql', same, null, show), false);
	assert.equal(isReleasedMigration('backend/migrations/001_a.sql', null, 'backend@1.0.0', show), false);
	const missing = () => {
		throw new Error('fatal: path not in tag');
	};
	assert.equal(isReleasedMigration('backend/migrations/001_a.sql', same, 'backend@1.0.0', missing), false);
});

// The full scan, end to end, in a throwaway git repo with a synthetic terms file.
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check_client_terms.mjs');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function repo() {
	const dir = mkdtempSync(join(tmpdir(), 'client-terms-'));
	const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env: GIT_ENV, stdio: 'pipe' });
	g('init', '-q', '-b', 'main');
	mkdirSync(join(dir, 'scripts/guards'), { recursive: true });
	copyFileSync(GUARD, join(dir, 'scripts/guards/check_client_terms.mjs'));
	writeFileSync(join(dir, 'terms.txt'), 'Fakefarm\n');
	const put = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
		g('add', path);
	};
	const commit = (msg) => g('commit', '-q', '-m', msg);
	const run = () => {
		const r = spawnSync('node', ['scripts/guards/check_client_terms.mjs'], { cwd: dir, env: { ...GIT_ENV, CLIENT_TERMS_FILE: join(dir, 'terms.txt') }, encoding: 'utf8' });
		assert.doesNotMatch(r.stdout + r.stderr, /fakefarm/i, 'the guard never prints a term');
		return r;
	};
	put('.gitignore', 'terms.txt\n');
	put('README.md', 'synthetic\n');
	commit('init');
	return { dir, g, put, commit, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const MIGRATION = 'backend/migrations/001_a.sql';

test('a released migration identical to the newest backend@* tag is a warning, and the run passes', (t) => {
	const r = repo();
	t.after(r.done);
	r.put(MIGRATION, 'SELECT 1;\n-- Fakefarm\n');
	r.commit('m');
	r.g('tag', 'backend@1.2.0');
	r.g('tag', 'web@9.0.0');
	const res = r.run();
	assert.equal(res.status, 0, res.stderr);
	assert.match(res.stderr, /::warning file=backend\/migrations\/001_a\.sql,line=2::client term #1 .*released as backend@1\.2\.0/);
	assert.doesNotMatch(res.stderr, /::error/);
});

test('the newest backend@* tag is the highest version, not the latest name', (t) => {
	const r = repo();
	t.after(r.done);
	r.put(MIGRATION, '-- Fakefarm\n');
	r.commit('old');
	r.g('tag', 'backend@1.9.0');
	r.put(MIGRATION, '-- Fakefarm, edited\n');
	r.commit('new');
	r.g('tag', 'backend@1.10.0');
	assert.equal(r.run().status, 0);
});

test('a released migration changed since the tag fails', (t) => {
	const r = repo();
	t.after(r.done);
	r.put(MIGRATION, '-- Fakefarm\n');
	r.commit('m');
	r.g('tag', 'backend@1.0.0');
	r.put(MIGRATION, '-- Fakefarm\nSELECT 2;\n');
	r.commit('edit');
	const res = r.run();
	assert.equal(res.status, 1);
	assert.match(res.stderr, /::error file=backend\/migrations\/001_a\.sql,line=1::client term #1/);
});

test('a migration the release tag lacks fails', (t) => {
	const r = repo();
	t.after(r.done);
	r.g('tag', 'backend@1.0.0');
	r.put('backend/migrations/002_new.sql', '-- Fakefarm\n');
	r.commit('new');
	assert.equal(r.run().status, 1);
});

test('a file outside backend/migrations/ fails even when unchanged since the tag', (t) => {
	const r = repo();
	t.after(r.done);
	r.put('docs/notes.md', 'Fakefarm\n');
	r.commit('doc');
	r.g('tag', 'backend@1.0.0');
	assert.equal(r.run().status, 1);
});

test('with no backend@* tag, a migration hit fails', (t) => {
	const r = repo();
	t.after(r.done);
	r.put(MIGRATION, '-- Fakefarm\n');
	r.commit('m');
	r.g('tag', 'web@1.0.0');
	assert.equal(r.run().status, 1);
});
