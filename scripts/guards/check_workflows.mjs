#!/usr/bin/env node
// Workflow guard: the CLAUDE.md CI rules, enforced rather than stated
// (estate standard: threkir's workflow-lint job, which pairs actionlint with
// its own pin / gate-coverage guards).
//
// actionlint (run beside this in CI) checks that each workflow parses the way
// GitHub parses it. This checks what actionlint cannot know about this repo:
//
//   pin        every third-party `uses:` is pinned to a full 40-hex commit SHA
//              with a `# vX.Y.Z` comment, including inside reusable workflows.
//              A tag is mutable; a SHA is not.
//   perms      every workflow declares a top-level `permissions:` block, and
//              that block never grants `id-token: write` (OIDC is opted into
//              per job, by the job that assumes a role).
//   no-keys    no static AWS credentials anywhere (`aws-access-key-id`,
//              `AWS_SECRET_ACCESS_KEY`, ...). CI auth to AWS is OIDC only.
//   oidc-env   every job that runs aws-actions/configure-aws-credentials is
//              gated on `environment: production`, which is what the deploy
//              role's trust policy pins (`environment:production` sub claim).
//   gate       every job in ci.yml is in the `ci-gate` job's `needs:`, so no
//              job can be red on a commit the gate calls green.
//   no-cache   a workflow with a production-gated job restores no dependency
//              cache anywhere (`cache:` on setup-node and friends,
//              actions/cache). A cache is written by other runs, including
//              ones that execute untrusted code on main, and a release build
//              ships what it builds with deploy credentials.
//   image      every `docker build` / `docker buildx build` in a workflow
//              says --provenance=false --sbom=false --platform linux/amd64
//              (on the command's first line). Lambda accepts one image
//              manifest, never the image index attestations produce.
//   push-full  ci.yml's `changes` job (the docs-only skip) emits code=true for
//              every event but pull_request, before anything else writes
//              `code=`, and never diffs against github.event.before. The
//              release preflight trusts `CI gate` on the tagged commit alone,
//              so a docs-only push to main must still run every heavy job:
//              otherwise it goes green over code whose own run failed.
//   no-tail    no `aws lambda invoke --log-type Tail` and no reading of the
//              `LogResult` it returns, in any workflow. Actions logs are
//              public (the repo is), and a function's log tail can quote an
//              error's SQL or data; the detail belongs in CloudWatch.
//
// Line-based on purpose (no YAML dependency at the root): the workflows are
// ours and 2-space indented, and the tests pin the shapes it reads.
//
// Run:   pnpm check:workflows   (also runs actionlint if it is installed)
// CI:    ci.yml, job `workflow-lint`.
// Tests: node --test scripts/guards/check_workflows.test.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ file: string, line?: number, rule: string, message: string }} Finding */

const USES = /^\s*-?\s*uses:\s*['"]?([^'"\s#]+)['"]?\s*(#.*)?$/;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d+(\.\d+)*\b/;
const STATIC_KEYS = /aws-access-key-id|aws-secret-access-key|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/;

/**
 * Split a workflow into its top-level `jobs:` entries.
 * @param {string} text
 * @returns {{ id: string, startLine: number, lines: string[] }[]}
 */
export function jobsOf(text) {
	const lines = text.split('\n');
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt < 0) return [];
	/** @type {{ id: string, startLine: number, lines: string[] }[]} */
	const jobs = [];
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const l = lines[i];
		if (/^\S/.test(l)) break; // next top-level key
		const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (m) jobs.push({ id: m[1], startLine: i + 1, lines: [] });
		else if (jobs.length) jobs[jobs.length - 1].lines.push(l);
	}
	return jobs;
}

/**
 * The top-level `permissions:` block (value lines included), or null.
 * @param {string} text
 */
export function topLevelPermissions(text) {
	const lines = text.split('\n');
	const at = lines.findIndex((l) => /^permissions:/.test(l));
	if (at < 0) return null;
	const block = [lines[at]];
	for (let i = at + 1; i < lines.length && /^\s+\S|^\s*$/.test(lines[i]); i++) {
		if (/^\s*$/.test(lines[i])) break;
		block.push(lines[i]);
	}
	return block.join('\n');
}

/** @param {string[]} jobLines */
export function isProductionGated(jobLines) {
	const body = jobLines.join('\n');
	return /^ {4}environment:\s*['"]?production['"]?\s*$/m.test(body) || /^ {4}environment:\s*\n {6}name:\s*['"]?production['"]?\s*$/m.test(body);
}

/**
 * The ids listed in a job's `needs:` (inline list, block list or scalar).
 * @param {string[]} jobLines
 */
export function needsOf(jobLines) {
	const at = jobLines.findIndex((l) => /^ {4}needs:/.test(l));
	if (at < 0) return [];
	const inline = jobLines[at].replace(/^ {4}needs:\s*/, '').trim();
	if (inline.startsWith('[')) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
	if (inline) return [inline];
	const out = [];
	for (let i = at + 1; i < jobLines.length; i++) {
		const m = jobLines[i].match(/^ {6}- ([A-Za-z0-9_-]+)\s*$/);
		if (!m) break;
		out.push(m[1]);
	}
	return out;
}

const EVENT_ENV = /^\s+EVENT_NAME:\s*\$\{\{\s*github\.event_name\s*\}\}\s*$/;
const FULL_ON_NON_PR = /^\s+if \[ "\$EVENT_NAME" != "pull_request" \]; then echo "code=true" >> "\$GITHUB_OUTPUT"; exit 0; fi\s*$/;

/**
 * Why ci.yml's `changes` job could let a push skip the heavy jobs, or null.
 * @param {string[]} jobLines
 */
export function pushFullProblem(jobLines) {
	if (jobLines.some((l) => /github\.event\.before/.test(l))) {
		return 'changes diffs against github.event.before; only a pull request may skip the heavy jobs, a push runs them all';
	}
	if (!jobLines.some((l) => EVENT_ENV.test(l))) {
		return 'changes has no `EVENT_NAME: ${{ github.event_name }}` env, so it cannot tell a push from a pull request';
	}
	const firstCode = jobLines.findIndex((l) => /code=/.test(l) && !/^\s*#/.test(l));
	if (firstCode < 0 || !FULL_ON_NON_PR.test(jobLines[firstCode])) {
		return 'changes must start with `if [ "$EVENT_NAME" != "pull_request" ]; then echo "code=true" >> "$GITHUB_OUTPUT"; exit 0; fi`, so a push to main always runs the full suite';
	}
	return null;
}

/**
 * @param {string} file e.g. `.github/workflows/ci.yml`
 * @param {string} text
 * @returns {Finding[]}
 */
export function checkWorkflow(file, text) {
	/** @type {Finding[]} */
	const out = [];
	const lines = text.split('\n');

	lines.forEach((l, i) => {
		const m = l.match(USES);
		if (m) {
			const ref = m[1];
			if (!ref.startsWith('./') && !ref.startsWith('docker://')) {
				if (!PINNED.test(ref)) {
					out.push({ file, line: i + 1, rule: 'pin', message: `${ref} is not pinned to a full commit SHA` });
				} else if (!VERSION_COMMENT.test((m[2] ?? '').trim())) {
					out.push({ file, line: i + 1, rule: 'pin', message: `${ref.split('@')[0]} is SHA-pinned but has no "# vX.Y.Z" comment saying which release it is` });
				}
			}
		}
		if (/--log-type[\s=]+['"]?Tail\b|\bLogResult\b/.test(l) && !/^\s*#/.test(l)) {
			out.push({ file, line: i + 1, rule: 'no-tail', message: 'a Lambda log tail printed to a public Actions log; print names and codes only and leave the detail in CloudWatch' });
		}
		if (STATIC_KEYS.test(l) && !/^\s*#/.test(l)) {
			out.push({ file, line: i + 1, rule: 'no-keys', message: 'static AWS credential reference; CI auth to AWS is GitHub OIDC only' });
		}
	});

	lines.forEach((l, i) => {
		if (/^\s*#/.test(l) || !/\bdocker\s+(buildx\s+)?build\b/.test(l)) return;
		const missing = ['--provenance=false', '--sbom=false', '--platform linux/amd64'].filter((f) => !l.includes(f));
		if (missing.length) {
			out.push({ file, line: i + 1, rule: 'image', message: `docker build without ${missing.join(' ')}: an attestation-carrying image index is what Lambda rejects` });
		}
	});

	const perms = topLevelPermissions(text);
	if (!perms) {
		out.push({ file, rule: 'perms', message: 'no top-level permissions: block (least-privilege default missing)' });
	} else if (/id-token:\s*write/.test(perms)) {
		out.push({ file, rule: 'perms', message: 'top-level permissions grant id-token: write; grant it only on the job that assumes a role' });
	}

	for (const job of jobsOf(text)) {
		const body = job.lines.join('\n');
		if (/uses:\s*aws-actions\/configure-aws-credentials@/.test(body) && !isProductionGated(job.lines)) {
			out.push({ file, line: job.startLine, rule: 'oidc-env', message: `job ${job.id} assumes an AWS role but is not gated on environment: production` });
		}
	}

	if (jobsOf(text).some((j) => isProductionGated(j.lines))) {
		lines.forEach((l, i) => {
			if (/^\s*#/.test(l)) return;
			if (/^\s+cache:\s*\S/.test(l) || /uses:\s*actions\/cache(\/restore)?@/.test(l)) {
				out.push({ file, line: i + 1, rule: 'no-cache', message: 'a deploy workflow restores a dependency cache; release builds install cold so a poisoned cache cannot reach production' });
			}
		});
	}

	if (file.endsWith('/ci.yml')) {
		const jobs = jobsOf(text);
		const gate = jobs.find((j) => j.id === 'ci-gate');
		if (!gate) {
			out.push({ file, rule: 'gate', message: 'ci.yml has no ci-gate job; branch protection requires exactly that one check' });
		} else {
			const needs = new Set(needsOf(gate.lines));
			for (const j of jobs) {
				if (j.id !== 'ci-gate' && !needs.has(j.id)) {
					out.push({ file, line: j.startLine, rule: 'gate', message: `job ${j.id} is not in ci-gate's needs, so it can fail while the gate reports green` });
				}
			}
		}
		const changes = jobs.find((j) => j.id === 'changes');
		if (changes) {
			const problem = pushFullProblem(changes.lines);
			if (problem) out.push({ file, line: changes.startLine, rule: 'push-full', message: problem });
		}
	}
	return out;
}

function main() {
	const dir = '.github/workflows';
	const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
	if (!files.length) {
		console.error(`::error::no workflows found under ${dir}; this guard checked nothing`);
		process.exit(1);
	}
	const findings = files.flatMap((f) => checkWorkflow(join(dir, f), readFileSync(join(dir, f), 'utf8')));
	for (const f of findings) {
		const loc = f.line ? `file=${f.file},line=${f.line}` : `file=${f.file}`;
		console.error(`::error ${loc}::[${f.rule}] ${f.message}`);
	}
	if (findings.length) process.exit(1);
	console.log(`Workflow guard OK (${files.length} workflows).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
