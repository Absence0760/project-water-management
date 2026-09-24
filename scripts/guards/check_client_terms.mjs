#!/usr/bin/env node
// Client-identifying terms never enter the repo (docs/security.md § Public
// repo hygiene).
//
// The repo is public, so the client's catchment, farm and workbook names must
// not appear in a file, a path or a commit message. The list of those terms
// names the client itself, so it lives OUTSIDE the repo, in the private
// infra-secrets repo:
//
//   ../infra-secrets/water-management/client-terms.txt   (or $CLIENT_TERMS_FILE)
//
// One term per line; `#` starts a comment. Matching ignores case, and a space
// in a term also matches "", "_", "-", or a line break plus comment markers,
// so "Some River" catches "SomeRiver", "some-river" and a name split across a
// comment line. A term only matches as a whole word (no letter or digit on
// either side).
//
// Without the terms file the guard is a no-op (a fresh clone, CI, anyone
// outside the project), so it never blocks work, it just cannot check.
//
// It never prints a matched term or the line's text, only the file, the line
// and the term's number in the list: a CI log is as public as the repo.
//
// Run:   pnpm check:terms                  (every tracked file and path)
//        node scripts/guards/check_client_terms.mjs --staged      (pre-commit)
//        node scripts/guards/check_client_terms.mjs --message <f> (commit-msg)
//        node scripts/guards/check_client_terms.mjs --history     (all refs)
// Tests: node --test scripts/guards/check_client_terms.test.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_TERMS_FILE = resolve(ROOT, '../infra-secrets/water-management/client-terms.txt');

/** @param {string} text */
export function parseTerms(text) {
	return text
		.split(/\r?\n/)
		.map((l) => l.replace(/#.*$/, '').trim())
		.filter(Boolean);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One case-insensitive, whole-word pattern per term. @param {string[]} terms */
export function compileTerms(terms) {
	return terms.map((t) => {
		const body = t.split(/\s+/).map(escape).join('(?:[\\s_-]|\\n[\\s#/*>-]*)*');
		return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
	});
}

/**
 * Findings in one text: which term matched on which line. The text is never
 * returned. @param {string} text @param {RegExp[]} patterns
 * @returns {{ line: number, term: number }[]}
 */
export function scanText(text, patterns) {
	const out = [];
	patterns.forEach((re, i) => {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) {
			out.push({ line: text.slice(0, m.index).split('\n').length, term: i + 1 });
		}
	});
	return out.sort((a, b) => a.line - b.line || a.term - b.term);
}

/**
 * Added lines of a unified diff, keyed by file and new-file line number.
 * @param {string} diff @returns {Map<string, { line: number, text: string }[]>}
 */
export function addedLines(diff) {
	const files = new Map();
	let file = null;
	let line = 0;
	for (const l of diff.split('\n')) {
		if (l.startsWith('+++ ')) {
			file = l === '+++ /dev/null' ? null : l.slice(6);
			if (file && !files.has(file)) files.set(file, []);
		} else if (l.startsWith('@@')) {
			line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
		} else if (file && l.startsWith('+')) {
			files.get(file).push({ line, text: l.slice(1) });
			line++;
		} else if (!l.startsWith('-') && !l.startsWith('\\')) {
			line++;
		}
	}
	return files;
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });

function report(findings, what) {
	for (const f of findings) {
		const loc = f.line ? `file=${f.file},line=${f.line}` : `file=${f.file}`;
		console.error(`::error ${loc}::client term #${f.term} from the terms file`);
	}
	if (findings.length) {
		console.error(`${findings.length} client-term finding(s) in ${what}. Terms are deliberately not printed; see docs/security.md § Public repo hygiene.`);
		process.exit(1);
	}
	console.log(`Client terms OK (${what}).`);
}

function main() {
	const args = process.argv.slice(2);
	const termsFile = process.env.CLIENT_TERMS_FILE || DEFAULT_TERMS_FILE;
	if (!existsSync(termsFile)) {
		console.log(`No client terms file at ${termsFile}; skipping (see docs/security.md § Public repo hygiene).`);
		return;
	}
	const patterns = compileTerms(parseTerms(readFileSync(termsFile, 'utf8')));
	if (!patterns.length) return console.log('Client terms file is empty; nothing to check.');
	const findings = [];
	const scanPath = (p) => scanText(p, patterns).forEach((f) => findings.push({ file: p, term: f.term }));

	if (args[0] === '--message') {
		const msg = readFileSync(args[1], 'utf8').replace(/^#.*$/gm, '');
		scanText(msg, patterns).forEach((f) => findings.push({ ...f, file: '(commit message)' }));
		return report(findings, 'the commit message');
	}
	if (args[0] === '--staged') {
		for (const p of git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean)) scanPath(p);
		for (const [file, lines] of addedLines(git(['diff', '--cached', '-U0', '--no-color', '--text']))) {
			// Join consecutive added lines so a term split across two lines still matches.
			const text = lines.map((l) => l.text).join('\n');
			for (const f of scanText(text, patterns)) findings.push({ file, line: lines[f.line - 1].line, term: f.term });
		}
		return report(findings, 'staged changes');
	}
	if (args[0] === '--history') {
		for (const f of scanText(git(['log', '--all', '--format=%B']), patterns)) findings.push({ file: '(commit messages, all refs)', term: f.term });
		for (const f of scanText(git(['log', '--all', '-p', '--text', '--format=', '--no-color']), patterns)) findings.push({ file: '(diffs, all refs)', term: f.term });
		for (const p of new Set(git(['log', '--all', '--format=', '--name-only']).split('\n').filter(Boolean))) scanPath(p);
		return report(findings, 'the history of every ref');
	}
	const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
	for (const p of tracked) {
		scanPath(p);
		if (!existsSync(resolve(ROOT, p))) continue;
		const buf = readFileSync(resolve(ROOT, p));
		if (buf.includes(0)) continue; // binary
		scanText(buf.toString('utf8'), patterns).forEach((f) => findings.push({ file: p, ...f }));
	}
	report(findings, `${tracked.length} tracked files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
