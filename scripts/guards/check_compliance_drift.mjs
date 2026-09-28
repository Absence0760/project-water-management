#!/usr/bin/env node
// Advisory: a change that moves personal data should move the privacy docs
// with it (estate standard: threkir's and feohledger's compliance-drift.yml).
//
// The failure mode: a migration adds a column holding personal data and
// nothing else changes. The app works; the data model, the POPIA notes and
// (once Phase 7 builds them) the export and account-deletion paths silently
// stop describing reality, and it only shows on the day someone exercises a
// data-subject right.
//
// Rules, each a pure function of {changed files, per-file diff}:
//   pii-column      a migration's ADDED lines create or alter a table with a
//                   personal-data-shaped column, and docs/data-model.md did
//                   not change in the same diff.
//   outbound-host   backend/ or frontend/ source gains a URL to a host that is
//                   not local, not AWS and not the site itself. If it receives
//                   personal data it is a sub-processor: record it in
//                   docs/security.md.
//   sdk-dependency  a workspace package.json gains a dependency that is a
//                   known analytics / telemetry / third-party SDK, and
//                   docs/security.md did not change.
//
// Mode: COMPLIANCE_DRIFT_MODE=warn (default: print, never fail) or fail.
// Base: BASE_SHA (the PR base, or the push's `before`), else origin/main.
//
// Run:   pnpm check:compliance
// CI:    .github/workflows/compliance-drift.yml (advisory).
// Tests: node --test scripts/guards/check_compliance_drift.test.mjs

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Matched per snake_case token, so `phone_number`, `client_ip` and
// `email_verified_at` all count, while `capacity_m3` or `pipeline` do not.
export const PII_TOKENS = new Set([
	'email', 'phone', 'mobile', 'cellphone', 'address', 'street', 'postcode', 'postal', 'surname',
	'birth', 'birthday', 'birthdate', 'dob', 'passport', 'gps', 'latitude', 'longitude', 'ip',
]);
const PII_COMPOUND = /(^|_)(first|last|full|display|given|middle)_?name($|_)|user_?agent|id_number|national_id/;

/** @param {string} column */
export const isPiiColumn = (column) => {
	const c = column.toLowerCase();
	return c.split('_').some((t) => PII_TOKENS.has(t)) || PII_COMPOUND.test(c);
};

export const KNOWN_HOST = [
	/(^|\.)localhost$/,
	/^127\./,
	/^0\.0\.0\.0$/,
	/(^|\.)example\.(com|org|net)$/,
	/(^|\.)amazonaws\.com$/,
	/(^|\.)aws\.amazon\.com$/,
	/(^|\.)jaredhoward\.com$/,
	/(^|\.)w3\.org$/,
	/(^|\.)schemastore\.org$/,
	/(^|\.)svelte\.dev$/,
	/(^|\.)github\.com$/,
];

export const SDK_DEPENDENCY =
	/^(@sentry\/|posthog|@segment\/|analytics-node|mixpanel|@datadog\/|dd-trace|newrelic|@amplitude\/|@google-analytics\/|react-ga|@vercel\/analytics|stripe|twilio|@sendgrid\/|mailgun|openai|@anthropic-ai\/|intercom|hotjar|@bugsnag\/|rollbar|logrocket|@honeycombio\/)/;

/** @typedef {{ file: string, rule: string, detail: string }} Finding */

/** @param {string} diff */
const added = (diff) =>
	diff
		.split('\n')
		.filter((l) => l.startsWith('+') && !l.startsWith('+++'))
		.map((l) => l.slice(1));

/**
 * Personal-data-shaped column names in a migration's added lines, when those
 * lines create or alter a table.
 * @param {string} diff
 */
export function piiColumnsInMigration(diff) {
	const lines = added(diff);
	const touchesSchema = lines.some((l) => /\b(create\s+table|alter\s+table)\b/i.test(l));
	if (!touchesSchema) return [];
	const cols = new Set();
	const TYPE = '(?:text|varchar|citext|char|inet|cidr|date|timestamptz?|jsonb?|numeric|double|real|int|integer|bigint|uuid|boolean|bytea)';
	const defAtStart = new RegExp(`^\\s*"?([a-z_][a-z0-9_]*)"?\\s+${TYPE}\\b`, 'i');
	const addColumn = new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?"?([a-z_][a-z0-9_]*)"?\\s+${TYPE}\\b`, 'gi');
	for (const l of lines) {
		if (/^\s*--/.test(l)) continue;
		const names = [...l.matchAll(addColumn)].map((m) => m[1]);
		const def = l.match(defAtStart);
		if (def) names.push(def[1]);
		for (const n of names) if (isPiiColumn(n)) cols.add(n.toLowerCase());
	}
	return [...cols].sort();
}

/** @param {string} diff */
export function unknownHostsInDiff(diff) {
	const hosts = new Set();
	for (const l of added(diff)) {
		if (/^\s*(\/\/|\*|#)/.test(l)) continue;
		for (const m of l.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
			const host = m[1].toLowerCase();
			if (!KNOWN_HOST.some((re) => re.test(host))) hosts.add(host);
		}
	}
	return [...hosts].sort();
}

/** @param {string} diff  a package.json diff */
export function sdkDependenciesInDiff(diff) {
	const out = new Set();
	for (const l of added(diff)) {
		const m = l.match(/^\s*"(@?[a-z0-9][\w./-]*)"\s*:\s*"[^"]*"/i);
		if (m && SDK_DEPENDENCY.test(m[1])) out.add(m[1]);
	}
	return [...out].sort();
}

/**
 * @param {{ files: readonly string[], diffFor: (f: string) => string }} input
 * @returns {Finding[]}
 */
export function collectFindings({ files, diffFor }) {
	/** @type {Finding[]} */
	const findings = [];
	const touched = (p) => files.includes(p);
	for (const f of files) {
		if (/^backend\/migrations\/.+\.sql$/.test(f) && !touched('docs/data-model.md')) {
			const cols = piiColumnsInMigration(diffFor(f));
			if (cols.length) {
				findings.push({
					file: f,
					rule: 'pii-column',
					detail: `adds personal-data-shaped column(s) ${cols.join(', ')} without a docs/data-model.md change. Record what is stored and why, and whether the POPIA export / deletion paths (plan.md Phase 7) must cover it.`,
				});
			}
		}
		if (/^(backend|frontend)\/src\/.+\.(ts|js|svelte)$/.test(f) && !/\.test\.ts$/.test(f)) {
			const hosts = unknownHostsInDiff(diffFor(f));
			if (hosts.length && !touched('docs/security.md')) {
				findings.push({
					file: f,
					rule: 'outbound-host',
					detail: `reaches ${hosts.join(', ')}. If personal data goes there it is a sub-processor: list it in docs/security.md (and the CSP/VPC egress, which block unknown origins by design).`,
				});
			}
		}
		if (/^(backend|frontend|packages\/[^/]+)\/package\.json$/.test(f) && !touched('docs/security.md')) {
			const sdks = sdkDependenciesInDiff(diffFor(f));
			if (sdks.length) {
				findings.push({
					file: f,
					rule: 'sdk-dependency',
					detail: `adds third-party SDK(s) ${sdks.join(', ')}. Document the data flow in docs/security.md before it ships.`,
				});
			}
		}
	}
	return findings;
}

/** @param {string[]} args */
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function resolveBase() {
	const base = process.env.BASE_SHA;
	if (base && !/^0+$/.test(base)) {
		try {
			git(['cat-file', '-e', `${base}^{commit}`]);
			return base;
		} catch {
			console.log(`::notice::BASE_SHA ${base} is not in this clone; diffing against origin/main instead`);
		}
	}
	return git(['merge-base', 'HEAD', 'origin/main']).trim();
}

function main() {
	const mode = process.env.COMPLIANCE_DRIFT_MODE ?? 'warn';
	const base = resolveBase();
	const files = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
	const findings = collectFindings({ files, diffFor: (f) => git(['diff', `${base}...HEAD`, '--', f]) });
	const level = mode === 'fail' ? 'error' : 'warning';
	for (const f of findings) console.log(`::${level} file=${f.file}::[${f.rule}] ${f.detail}`);
	const summary = findings.length
		? `${findings.length} compliance-drift finding(s) across ${files.length} changed files (mode: ${mode}).`
		: `No compliance drift across ${files.length} changed files.`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) {
		const body = ['## Compliance drift (advisory)', '', summary, '', ...findings.map((f) => `- \`${f.file}\` **${f.rule}**: ${f.detail}`), ''];
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.join('\n') + '\n');
	}
	if (mode === 'fail' && findings.length) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
