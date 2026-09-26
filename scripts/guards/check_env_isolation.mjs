#!/usr/bin/env node
// Committed env files stay local-only (estate standard: feohledger's
// env-isolation.yml, threkir's env-isolation job).
//
// This repo commits `*.env.development` so a fresh clone runs with no setup
// (CLAUDE.md "Local-dev env is committed; real secrets never are"). That is
// only safe while those files stay boring: loopback hosts, throwaway docker
// credentials, dev-only placeholders. gitleaks scans for known credential
// SHAPES; this guard is the semantic complement. It asserts that:
//
//   1. the only tracked env files are `*.env.development`, `*.env.example`
//      and `frontend/.env.production` (the production build default, which
//      holds only same-origin `/api`);
//   2. no sops payload or `.sops.yaml` is tracked (secrets live in the
//      private infra-secrets repo; `*.sops.yaml.example` key lists are fine);
//   3. every host a committed dev default names is local;
//   4. the dev-only placeholders stay placeholders (`AUTH_JWT_SECRET` starts
//      with `dev-only-`, `CLOUDFRONT_SHARED_SECRET` is empty, the object
//      store is the local MinIO with its default `minioadmin` login);
//   5. frontend env files define only `PUBLIC_*` keys (anything else in a
//      Vite env file is either ignored or a secret in the wrong place), and the
//      production default points the API at same-origin `/api`.
//
// It never prints a matched VALUE, only the file, the line and the rule: a CI
// log is as public as the repo.
//
// Run:   pnpm check:env
// CI:    ci.yml, job `env-isolation`.
// Tests: node --test scripts/guards/check_env_isolation.test.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALLOWED_ENV_FILE = /(^|\/)\.env\.(development|example)$/;
export const ALLOWED_EXACT = new Set(['frontend/.env.production']);
const ENV_FILE = /(^|\/)\.env($|\.)/;
const SOPS_FILE = /(^|\/)\.sops\.ya?ml$|\.sops$|\.sops\.(ya?ml|json|env|ini)$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

/** @typedef {{ file: string, line?: number, rule: string }} Finding */

/** @param {string} host */
export const isLocalHost = (host) => LOCAL_HOSTS.has(host.toLowerCase()) || /\.localhost$/i.test(host);

/**
 * @param {readonly string[]} tracked every path `git ls-files` reports
 * @returns {Finding[]}
 */
export function checkTrackedFiles(tracked) {
	/** @type {Finding[]} */
	const out = [];
	for (const f of tracked) {
		const base = f.split('/').pop() ?? f;
		if (ENV_FILE.test(base) && !ALLOWED_ENV_FILE.test(f) && !ALLOWED_EXACT.has(f)) {
			out.push({ file: f, rule: 'env file outside the allowlist is tracked (only *.env.development, *.env.example and frontend/.env.production may be committed)' });
		}
		if (SOPS_FILE.test(f)) {
			out.push({ file: f, rule: 'sops file tracked in a public repo (encrypted secrets live in the private infra-secrets repo)' });
		}
	}
	return out;
}

/**
 * Parse KEY=value lines, skipping comments and blanks.
 * @param {string} text
 * @returns {{ line: number, key: string, value: string }[]}
 */
export function parseEnv(text) {
	const out = [];
	text.split('\n').forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) return;
		const eq = line.indexOf('=');
		if (eq <= 0) return;
		let value = line.slice(eq + 1).trim();
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		out.push({ line: i + 1, key: line.slice(0, eq).trim().replace(/^export\s+/, ''), value });
	});
	return out;
}

/**
 * Hosts named by one value: every `scheme://[user[:pw]@]host` in it.
 * @param {string} value
 */
export function hostsIn(value) {
	const hosts = [];
	for (const m of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/]*@)?(\[[^\]]+\]|[^:/?#\s,;"']+)/gi)) {
		hosts.push(m[1].replace(/^\[|\]$/g, ''));
	}
	return hosts;
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkEnvFile(file, text) {
	/** @type {Finding[]} */
	const out = [];
	const entries = parseEnv(text);
	const isDev = /\.env\.development$/.test(file);
	const isFrontend = file.startsWith('frontend/');
	for (const { line, key, value } of entries) {
		if (isFrontend && !key.startsWith('PUBLIC_')) {
			out.push({ file, line, rule: `${key} is not a PUBLIC_* key; a frontend env file may only hold values that are safe to bake into the public bundle` });
		}
		if (isDev) {
			for (const host of hostsIn(value)) {
				if (!isLocalHost(host)) out.push({ file, line, rule: `${key} names a non-local host; committed dev defaults must point at the local stack` });
			}
			if (/_HOST$/.test(key) && value && !isLocalHost(value)) {
				out.push({ file, line, rule: `${key} is not a local host; committed dev defaults must point at the local stack` });
			}
			if ((key === 'AUTH_JWT_SECRET' || key === 'ALERTS_TOKEN_SECRET') && !value.startsWith('dev-only-')) {
				out.push({ file, line, rule: `${key} is no longer the dev-only- placeholder; a real signing key here is public. Move it to infra-secrets` });
			}
			if (key === 'CLOUDFRONT_SHARED_SECRET' && value !== '') {
				out.push({ file, line, rule: 'CLOUDFRONT_SHARED_SECRET must stay empty in a committed dev default (Terraform generates the real one)' });
			}
			// Object storage: the local MinIO's documented default login, never a real key pair.
			if ((key === 'S3_ACCESS_KEY_ID' || key === 'S3_SECRET_ACCESS_KEY') && value !== 'minioadmin') {
				out.push({ file, line, rule: `${key} must stay MinIO's local default (minioadmin); production S3 uses the Lambda's role, never a key` });
			}
			if (key === 'STORAGE' && value !== 'local') {
				out.push({ file, line, rule: 'STORAGE must be local (MinIO) in a committed dev default' });
			}
		}
	}
	if (file === 'frontend/.env.production') {
		const api = entries.find((e) => e.key === 'PUBLIC_API_URL');
		if (!api || api.value !== '/api') {
			out.push({ file, line: api?.line, rule: 'PUBLIC_API_URL must be the same-origin /api (CloudFront proxies it to the Lambda; deploy-frontend.yml relies on it)' });
		}
		for (const { line, key, value } of entries) {
			if (hostsIn(value).length) out.push({ file, line, rule: `${key} holds an absolute URL; the production default must stay origin-relative` });
		}
	}
	return out;
}

function main() {
	const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
	const findings = checkTrackedFiles(tracked);
	const envFiles = tracked.filter((f) => ALLOWED_ENV_FILE.test(f) || ALLOWED_EXACT.has(f));
	if (!envFiles.some((f) => f.endsWith('.env.development'))) {
		findings.push({ file: '(index)', rule: 'no committed .env.development found; the file list derivation stopped matching, so every rule above checked nothing' });
	}
	for (const f of envFiles) {
		console.log(`Scanning ${f}`);
		findings.push(...checkEnvFile(f, readFileSync(f, 'utf8')));
	}
	for (const f of findings) {
		const loc = f.line ? `file=${f.file},line=${f.line}` : `file=${f.file}`;
		console.error(`::error ${loc}::${f.rule}`);
	}
	if (findings.length) {
		console.error(`${findings.length} env-isolation finding(s). Values are deliberately not printed.`);
		process.exit(1);
	}
	console.log(`Env isolation OK (${envFiles.length} committed env files).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
