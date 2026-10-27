#!/usr/bin/env node
// Every upstream the app fetches from has a row in the source register,
// docs/data-sources.md (issue #604, "The rule": each source gets a register
// entry with its host, licence, contact, access pattern, limits, fallback and
// owner).
//
// Two lists in the code name upstreams, and each must be in the register's
// summary table (the table under "## Register", whose header has a "Hosts"
// and a "Feed source" column; the values in backticks):
//   hosts         every host in FEED_HOSTS (backend/src/feeds/http.ts), the
//                 hosts a live feed fetch may ask. Read from the source, not
//                 imported: each entry is a string literal or
//                 `new URL(<const>).host`, the const a string literal in
//                 http.ts or in the module it is imported from;
//   feed sources  every value `data_feed.source` may take: the FEED_SOURCES
//                 tuple (backend/src/feeds/config.ts) and the table's CHECK
//                 at its latest definition in backend/migrations. The two
//                 must agree, or a feed the API accepts would fail the insert
//                 (or the reverse).
// An entry of FEED_HOSTS the guard can't read fails too, so a change in its
// shape is looked at rather than skipped.
//
// Run:   node scripts/guards/data_sources.mjs
// Tests: node --test scripts/guards/data_sources.test.mjs (pnpm test:guards;
//        it also checks the real tree, which is what CI's guard step runs).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const REGISTER = 'docs/data-sources.md';
export const HTTP = 'backend/src/feeds/http.ts';
export const CONFIG = 'backend/src/feeds/config.ts';
export const MIGRATIONS = 'backend/migrations';

const readAt = (root) => (p) => {
	const f = join(root, p);
	return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

/** Split a list's text on its top-level commas (none inside parentheses, brackets or quotes). */
function splitTop(text) {
	const out = [];
	let depth = 0;
	let quote = null;
	let cur = '';
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

const STRING = /^(['"])([^'"`]*)\1$/;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A module-level `const NAME = '…'` in `text`, or null. */
function constString(text, name) {
	const m = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(['"])([^'"\`]*)\\1`).exec(text);
	return m ? m[2] : null;
}

/** The module `name` is imported from in `text` (a relative .js specifier, read as its .ts), or null. */
function importedFrom(text, name, file) {
	const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;
	for (let m; (m = re.exec(text)); ) {
		const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop());
		if (!names.includes(name) || !m[3].startsWith('.')) continue;
		return join(dirname(file), m[3]).replace(/\.js$/, '.ts');
	}
	return null;
}

/**
 * The hosts in FEED_HOSTS, read from `HTTP`'s source. Returns
 * `{ hosts, problems }`: an entry it can't resolve is a problem, never skipped.
 */
export function feedHosts(read = readAt(ROOT), file = HTTP) {
	const problems = [];
	const raw = read(file);
	if (raw === null) return { hosts: [], problems: [`${file} is gone: point the guard at where FEED_HOSTS lives now`] };
	const text = stripComments(raw);
	const m = /export\s+const\s+FEED_HOSTS\b[^=]*=\s*\[([\s\S]*?)\]\s*;/.exec(text);
	if (!m) return { hosts: [], problems: [`${file} has no \`export const FEED_HOSTS = [...]\`: point the guard at where the live hosts are listed now`] };
	const hosts = [];
	for (const entry of splitTop(m[1])) {
		const lit = STRING.exec(entry);
		if (lit) {
			hosts.push(lit[2]);
			continue;
		}
		const url = /^new\s+URL\(\s*(?:(['"])([^'"`]+)\1|([A-Za-z_$][\w$]*))\s*\)\.(host|hostname)$/.exec(entry);
		if (!url) {
			problems.push(`can't read the FEED_HOSTS entry \`${entry}\` in ${file}: write it as a string literal or new URL(<const>).host, or teach scripts/guards/data_sources.mjs its shape`);
			continue;
		}
		let href = url[2] ?? null;
		if (href === null) {
			const name = url[3];
			href = constString(text, name);
			if (href === null) {
				const from = importedFrom(text, name, file);
				const body = from ? read(from) : null;
				href = body === null ? null : constString(stripComments(body), name);
			}
			if (href === null) {
				problems.push(`can't resolve ${name} (in FEED_HOSTS, ${file}) to a string constant`);
				continue;
			}
		}
		try {
			hosts.push(new URL(href).hostname);
		} catch {
			problems.push(`${href} (in FEED_HOSTS, ${file}) is not a URL`);
		}
	}
	return { hosts, problems };
}

/** The FEED_SOURCES tuple in `CONFIG`, or null. */
export function configSources(read = readAt(ROOT), file = CONFIG) {
	const text = read(file);
	const m = text && /export\s+const\s+FEED_SOURCES\s*=\s*\[([^\]]*)\]/.exec(stripComments(text));
	if (!m) return null;
	return splitTop(m[1]).map((s) => STRING.exec(s)?.[2] ?? s);
}

/** The values a `source IN (…)` or `source = ANY (ARRAY[…])` check allows, from its text. */
function checkValues(body) {
	const m = /CHECK\s*\(\s*\(?\s*source\s*(?:::text\s*)?(?:IN\s*\(([^)]*)\)|=\s*ANY\s*\(\s*\(?\s*ARRAY\s*\[([^\]]*)\])/i.exec(body);
	if (!m) return null;
	return [...(m[1] ?? m[2]).matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/**
 * The source values data_feed's CHECK allows at its latest definition: the
 * last `CREATE TABLE data_feed` or `ALTER TABLE data_feed` statement, in
 * migration order, that sets a check on `source`. `files` is
 * [{ name, text }] in order. Null when none does.
 */
export function migrationSources(files) {
	let latest = null;
	for (const { name, text } of files) {
		const sql = text.replace(/--.*$/gm, '');
		const re = /(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?data_feed\s*\(|ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?data_feed\b)/gi;
		for (let m; (m = re.exec(sql)); ) {
			// The statement runs to its semicolon; a CREATE TABLE's body has none.
			const end = sql.indexOf(';', m.index);
			const stmt = sql.slice(m.index, end < 0 ? undefined : end);
			const values = checkValues(stmt);
			if (values) latest = { file: name, values };
		}
	}
	return latest;
}

export function readMigrations(root = ROOT) {
	const dir = join(root, MIGRATIONS);
	return readdirSync(dir)
		.filter((n) => n.endsWith('.sql'))
		.sort()
		.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * The register's summary table: the hosts and feed sources it names, each
 * in backticks in its column. Null when no table has both columns.
 */
export function registerEntries(markdown) {
	const lines = markdown.split('\n');
	const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
	for (let i = 0; i < lines.length - 1; i++) {
		if (!lines[i].trim().startsWith('|') || !/^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) continue;
		const head = cells(lines[i]).map((c) => c.toLowerCase());
		const h = head.indexOf('hosts');
		const s = head.indexOf('feed source');
		if (h < 0 || s < 0) continue;
		const hosts = new Set();
		const sources = new Set();
		for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
			const row = cells(lines[j]);
			for (const m of (row[h] ?? '').matchAll(/`([^`]+)`/g)) hosts.add(m[1]);
			for (const m of (row[s] ?? '').matchAll(/`([^`]+)`/g)) sources.add(m[1]);
		}
		return { hosts, sources };
	}
	return null;
}

/** Everything wrong, as messages; [] when the register covers the code. */
export function findProblems({ register, hosts, hostProblems = [], config, migration }) {
	const problems = [...hostProblems];
	if (register === null) return [...problems, `${REGISTER} is gone: the source register is required (issue #604, "The rule")`];
	const entries = registerEntries(register);
	if (!entries) return [...problems, `${REGISTER} has no summary table with a "Hosts" and a "Feed source" column`];
	for (const host of hosts) {
		if (!entries.hosts.has(host)) problems.push(`FEED_HOSTS lets a live fetch ask ${host}, but ${REGISTER} has no row naming it (\`${host}\` in the Hosts column): add the source's row before it is fetched`);
	}
	if (config === null) problems.push(`${CONFIG} has no \`export const FEED_SOURCES = [...]\`: point the guard at where the feed sources are listed now`);
	if (migration === null) problems.push(`no migration under ${MIGRATIONS} sets a CHECK on data_feed.source: point the guard at the constraint's new form`);
	const sources = new Set([...(config ?? []), ...(migration?.values ?? [])]);
	for (const source of sources) {
		if (!entries.sources.has(source)) problems.push(`data_feed.source may be '${source}', but ${REGISTER} has no row naming it (\`${source}\` in the Feed source column)`);
	}
	if (config && migration) {
		const a = [...config].sort().join(', ');
		const b = [...migration.values].sort().join(', ');
		if (a !== b) problems.push(`FEED_SOURCES (${CONFIG}: ${a}) and data_feed's CHECK on source (${migration.file}: ${b}) disagree`);
	}
	return problems;
}

/** Read the real tree and check it. */
export function check(root = ROOT) {
	const read = readAt(root);
	const { hosts, problems: hostProblems } = feedHosts(read);
	return findProblems({
		register: read(REGISTER),
		hosts,
		hostProblems,
		config: configSources(read),
		migration: migrationSources(readMigrations(root))
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const problems = check();
	if (problems.length) {
		for (const p of problems) console.error(`data_sources: ${p}`);
		process.exit(1);
	}
	const { hosts } = feedHosts();
	console.log(`data_sources: ${REGISTER} has a row for every live feed host (${hosts.join(', ')}) and every data_feed.source (${configSources().join(', ')})`);
}
