#!/usr/bin/env node
// The renderer image's Ubuntu archive snapshot: how old it is, and moving it.
//
// backend/renderer.Dockerfile's build stage installs its apt packages at exact
// versions from one snapshot.ubuntu.com snapshot (`ARG APT_SNAPSHOT`;
// check_playwright_pins.mjs refuses anything less). That makes the build
// reproducible, and it also means those packages get no Ubuntu security update
// until someone moves the snapshot. Dependabot can't: it moves the base image's
// tag and digest, never an apt pin. So:
//
//   age    how many days old APT_SNAPSHOT is, against a limit (default 90).
//          Always exits 0 on a readable Dockerfile: the verdict goes to stdout,
//          to $GITHUB_OUTPUT (stale, age_days, snapshot) when set, and, when
//          stale, to --body-file as the tracking issue's text.
//          The weekly workflow .github/workflows/renderer-apt-snapshot.yml
//          opens (or updates) one `renderer-apt-snapshot` issue from it, and
//          closes that issue once the snapshot is fresh again.
//
//   bump   moves APT_SNAPSHOT (to today, 00:00 UTC, or the id given) and
//          rewrites every pinned package's version to its candidate in that
//          snapshot, read with `apt-cache --snapshot <id> policy` inside the
//          Dockerfile's own digest-pinned base image (docker run; no build).
//          The --snapshot on apt-cache matters: `apt-get update --snapshot`
//          also fetches the live lists (to read the archive's Snapshots
//          field), and a bare `apt-cache policy` reads those, reporting
//          today's versions instead of the snapshot's. Run it whenever
//          the base digest moves (Dependabot's docker PR) and whenever the
//          age check says so, then `pnpm check:pins` and
//          `pnpm check:renderer-image`.
//
// Run:   pnpm check:apt-snapshot          (age, 90 days)
//        pnpm gen:renderer-apt [<id>]     (bump; needs docker and network)
// CI:    .github/workflows/renderer-apt-snapshot.yml (weekly, age)
// Tests: node --test scripts/guards/renderer_apt_snapshot.test.mjs

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCKERFILE = 'backend/renderer.Dockerfile';
export const DEFAULT_MAX_DAYS = 90;

const SNAPSHOT_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const ARG_LINE = /^(ARG\s+APT_SNAPSHOT=)(\S+)\s*$/m;
// One pinned package per line inside the apt-get install, the Dockerfile's
// layout: `<tabs>pkg=version \`.
const PIN_LINE = /^(\s+)([a-z0-9][a-z0-9+.-]*)=(\S+?)(\s*\\)?$/;

/**
 * The APT_SNAPSHOT build arg's value, or null.
 * @param {string} dockerfile
 */
export function readSnapshot(dockerfile) {
	return dockerfile.match(ARG_LINE)?.[2] ?? null;
}

/**
 * A snapshot id (YYYYMMDDTHHMMSSZ) as a Date, or null if it isn't one.
 * @param {string} id
 */
export function snapshotDate(id) {
	const m = id?.match(SNAPSHOT_ID);
	if (!m) return null;
	const [, y, mo, d, h, mi, s] = m.map(Number);
	const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	// Date.UTC rolls 20260231 over into March; a real id round-trips.
	if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
	return t;
}

/**
 * Whole days from the snapshot to `now` (never negative).
 * @param {string} id
 * @param {Date} now
 */
export function ageDays(id, now) {
	const t = snapshotDate(id);
	if (!t) throw new Error(`APT_SNAPSHOT "${id}" is not a snapshot id (YYYYMMDDTHHMMSSZ)`);
	return Math.max(0, Math.floor((now.getTime() - t.getTime()) / 86_400_000));
}

/**
 * The snapshot id for midnight UTC on `now`'s day.
 * @param {Date} now
 */
export function todaySnapshot(now) {
	return `${now.toISOString().slice(0, 10).replaceAll('-', '')}T000000Z`;
}

/**
 * The digest-pinned base image (the first FROM), or null.
 * @param {string} dockerfile
 */
export function baseImage(dockerfile) {
	return dockerfile.match(/^FROM\s+(\S+@sha256:[0-9a-f]{64})/m)?.[1] ?? null;
}

/**
 * The apt packages pinned in the Dockerfile, in order: [{ name, version }].
 * Only lines inside the RUN that runs `apt-get install` count.
 * @param {string} dockerfile
 */
export function aptPins(dockerfile) {
	const lines = dockerfile.split('\n');
	const out = [];
	let inInstall = false;
	for (const l of lines) {
		if (/apt-get\s+install\b/.test(l)) {
			inInstall = true;
			continue;
		}
		if (!inInstall) continue;
		const m = l.match(PIN_LINE);
		if (!m) {
			inInstall = false;
			continue;
		}
		out.push({ name: m[2], version: m[3] });
		if (!m[4]) inInstall = false;
	}
	return out;
}

/**
 * Each package's Candidate from `apt-cache policy <pkg…>` output.
 * @param {string} output
 * @returns {Map<string, string>}
 */
export function parsePolicy(output) {
	const out = new Map();
	let current = null;
	for (const l of output.split('\n')) {
		const head = l.match(/^(\S+):\s*$/);
		if (head) {
			current = head[1];
			continue;
		}
		const cand = l.match(/^\s+Candidate:\s*(\S+)\s*$/);
		if (current && cand && cand[1] !== '(none)') out.set(current, cand[1]);
	}
	return out;
}

/**
 * The Dockerfile with APT_SNAPSHOT set to `snapshot` and every pinned package
 * at its version in `versions`. Throws if a package has no version there.
 * @param {string} dockerfile
 * @param {string} snapshot
 * @param {Map<string, string>} versions
 */
export function rewriteDockerfile(dockerfile, snapshot, versions) {
	if (!snapshotDate(snapshot)) throw new Error(`"${snapshot}" is not a snapshot id (YYYYMMDDTHHMMSSZ)`);
	if (!ARG_LINE.test(dockerfile)) throw new Error(`${DOCKERFILE} has no ARG APT_SNAPSHOT=… line`);
	const pins = aptPins(dockerfile);
	if (!pins.length) throw new Error(`${DOCKERFILE} pins no apt package this script can read`);
	const missing = pins.filter((p) => !versions.has(p.name)).map((p) => p.name);
	if (missing.length) throw new Error(`no candidate in snapshot ${snapshot} for: ${missing.join(', ')}`);
	const names = new Set(pins.map((p) => p.name));
	let inInstall = false;
	const lines = dockerfile.replace(ARG_LINE, `$1${snapshot}`).split('\n').map((l) => {
		if (/apt-get\s+install\b/.test(l)) {
			inInstall = true;
			return l;
		}
		if (!inInstall) return l;
		const m = l.match(PIN_LINE);
		if (!m || !names.has(m[2])) {
			inInstall = false;
			return l;
		}
		if (!m[4]) inInstall = false;
		return `${m[1]}${m[2]}=${versions.get(m[2])}${m[4] ?? ''}`;
	});
	return lines.join('\n');
}

/**
 * How old the Dockerfile's snapshot is against a limit in days. Throws when
 * there is no APT_SNAPSHOT to read or the limit isn't a positive number, so
 * the check can never pass by reading nothing.
 * @param {string} dockerfile
 * @param {Date} now
 * @param {number} maxDays
 */
export function snapshotVerdict(dockerfile, now, maxDays = DEFAULT_MAX_DAYS) {
	if (!Number.isFinite(maxDays) || maxDays <= 0) throw new Error(`--max-days must be a positive number, not ${maxDays}`);
	const snapshot = readSnapshot(dockerfile);
	if (!snapshot) throw new Error(`${DOCKERFILE} has no ARG APT_SNAPSHOT=… line; this check read nothing`);
	const age = ageDays(snapshot, now);
	return { snapshot, age, maxDays, stale: age > maxDays };
}

/**
 * The tracking issue's body for a stale snapshot.
 * @param {{ snapshot: string, age: number, maxDays: number }} s
 */
export function issueBody({ snapshot, age, maxDays }) {
	return [
		`The renderer image's apt snapshot is **${age} days old** (\`APT_SNAPSHOT=${snapshot}\` in \`${DOCKERFILE}\`; the limit is ${maxDays}).`,
		'',
		"Its build stage's packages (the compilers and libraries aws-lambda-ric builds with) are pinned to exact versions from that snapshot, so they get no Ubuntu security update until it moves. Dependabot moves the base image's tag and digest, never these pins.",
		'',
		'To move it (docs/deployment.md § Reports):',
		'',
		"1. If Dependabot has a `docker` PR open for `/backend`, do this on that PR's branch, so the snapshot moves with the base digest.",
		"2. `pnpm gen:renderer-apt`: sets `APT_SNAPSHOT` to today (00:00 UTC) and rewrites each pinned package to its candidate in that snapshot, read with `apt-cache --snapshot <id> policy` in the Dockerfile's digest-pinned base (needs docker; pulls the base if absent).",
		'3. `pnpm check:pins && pnpm check:renderer-image`: every package still pinned, and the image still builds, prints a PDF and answers as a Lambda.',
		'4. Open a PR; CI builds and smoke-tests the image again (`renderer-image` job).',
		'',
		'This issue is updated weekly while the snapshot stays stale and closes itself once it is fresh.'
	].join('\n');
}

function root() {
	return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function flag(args, name) {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

function age(args) {
	let v;
	try {
		v = snapshotVerdict(readFileSync(join(root(), DOCKERFILE), 'utf8'), new Date(), Number(flag(args, '--max-days') ?? DEFAULT_MAX_DAYS));
	} catch (e) {
		console.error(`::error file=${DOCKERFILE}::${e.message}`);
		process.exit(1);
	}
	console.log(`APT_SNAPSHOT ${v.snapshot}: ${v.age} day${v.age === 1 ? '' : 's'} old (limit ${v.maxDays})${v.stale ? ' - STALE, run pnpm gen:renderer-apt' : ''}.`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `stale=${v.stale}\nage_days=${v.age}\nsnapshot=${v.snapshot}\n`);
	}
	const bodyFile = flag(args, '--body-file');
	if (v.stale && bodyFile) writeFileSync(bodyFile, `${issueBody(v)}\n`);
}

function bump(args) {
	const path = join(root(), DOCKERFILE);
	const text = readFileSync(path, 'utf8');
	const snapshot = args.find((a) => !a.startsWith('-')) ?? todaySnapshot(new Date());
	if (!snapshotDate(snapshot)) {
		console.error(`"${snapshot}" is not a snapshot id (YYYYMMDDTHHMMSSZ)`);
		process.exit(1);
	}
	const image = baseImage(text);
	if (!image) {
		console.error(`${DOCKERFILE} has no digest-pinned FROM`);
		process.exit(1);
	}
	const pins = aptPins(text);
	const names = pins.map((p) => p.name);
	console.log(`Reading ${names.length} candidates from snapshot ${snapshot} in ${image.split('@')[0]}…`);
	const output = execFileSync(
		'docker',
		['run', '--rm', '--platform', 'linux/amd64', '--user', 'root', image, 'bash', '-c', `apt-get update --snapshot "$0" -qq >/dev/null && apt-cache --snapshot "$0" policy ${names.join(' ')}`, snapshot],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
	);
	const next = rewriteDockerfile(text, snapshot, parsePolicy(output));
	writeFileSync(path, next);
	const after = new Map(aptPins(next).map((p) => [p.name, p.version]));
	for (const p of pins) {
		const v = after.get(p.name);
		console.log(`  ${p.name}: ${p.version === v ? v : `${p.version} -> ${v}`}`);
	}
	console.log(`APT_SNAPSHOT=${snapshot}. Next: pnpm check:pins && pnpm check:renderer-image`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === 'age') age(args);
	else if (cmd === 'bump') bump(args);
	else {
		console.error('usage: renderer_apt_snapshot.mjs age [--max-days N] [--body-file F] | bump [<YYYYMMDDTHHMMSSZ>]');
		process.exit(2);
	}
}
