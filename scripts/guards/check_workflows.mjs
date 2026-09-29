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
//              that block never grants `id-token: write` or `write-all` (OIDC
//              is opted into per job, by the job that assumes a role).
//   oidc-gate  every job that grants `id-token: write` (or `write-all`, which
//              includes it) is gated on `environment: production`. The one
//              exception is OIDC_ALLOWLIST: a named job in a named workflow,
//              with a reason, that uses its named action and runs no `run:`
//              step (so no script of ours can mint a token there).
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
//   image-sha  a step that runs `docker push` names the commit it built from
//              (`${{ needs.<job>.outputs.sha }}` or `${{ github.sha }}`), so
//              its tag can carry it. The renderer's ECR tags are immutable
//              and a deploy skips a push whose tag already exists: a tag
//              made of the version alone would let a release recut at the
//              same version on a new commit keep the old image.
//   push-full  ci.yml's `changes` job (the docs-only skip) emits code=true for
//              every event but pull_request, before anything else writes
//              `code=`, and never diffs against github.event.before. The
//              release preflight trusts `CI gate` on the tagged commit alone,
//              so a docs-only push to main must still run every heavy job:
//              otherwise it goes green over code whose own run failed.
//   prt-head   a workflow triggered by `pull_request_target` never checks out
//              or fetches the PR's head (`ref:`/`repository:` naming
//              github.event.pull_request.head.*, github.head_ref or
//              refs/pull/*, `gh pr checkout`, a git fetch/checkout of those,
//              or an env var holding the head sha/ref/repo). That trigger runs
//              with the base repo's token and secrets, so building PR code
//              under it hands a fork both.
//   no-tail    no `aws lambda invoke --log-type Tail` and no reading of the
//              `LogResult` it returns, in any workflow. Actions logs are
//              public (the repo is), and a function's log tail can quote an
//              error's SQL or data; the detail belongs in CloudWatch.
//   auto-merge dependabot-auto-merge.yml has an ecosystem allowlist, and it
//              leaves out github_actions and docker (the renderer image:
//              .github/dependabot.yml's docker entry); and the same `if:`
//              excludes the renderer image's npm directory
//              (/backend/renderer-deps) by fetch-metadata's `directory` and by
//              the PR's branch name, each on its own line joined with `&&`.
//              Those PRs stay manual.
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

/**
 * Jobs allowed `id-token: write` without `environment: production`. Keep this
 * short: each entry is one job in one workflow, using one action that needs
 * a GitHub OIDC token for something other than AWS, with no `run:` step.
 */
export const OIDC_ALLOWLIST = Object.freeze([
	{
		file: 'scorecard.yml',
		job: 'analysis',
		action: 'ossf/scorecard-action',
		reason: 'publish_results signs the Scorecard result for scorecard.dev with a GitHub OIDC token (Sigstore); no AWS role trusts it, and scorecard-action itself refuses a job with run steps',
	},
]);

/**
 * Whether a job's own `permissions:` grant `id-token: write` (a block entry,
 * a flow map, or `write-all`).
 * @param {string[]} jobLines
 */
export function grantsIdToken(jobLines) {
	const at = jobLines.findIndex((l) => /^ {4}permissions:/.test(l));
	if (at < 0) return false;
	const inline = jobLines[at].replace(/^ {4}permissions:\s*/, '').replace(/#.*$/, '').trim();
	if (inline) return /^['"]?write-all['"]?$/.test(inline) || /id-token:\s*['"]?write/.test(inline);
	for (let i = at + 1; i < jobLines.length; i++) {
		const l = jobLines[i];
		if (/^\s*$/.test(l) || /^\s*#/.test(l)) continue;
		if (!/^ {6}/.test(l)) break;
		if (/^ {6}id-token:\s*['"]?write/.test(l)) return true;
	}
	return false;
}

/**
 * Why a job granting id-token: write is allowed to, or null if it is not.
 * @param {string} file
 * @param {{ id: string, lines: string[] }} job
 */
export function oidcAllowlisted(file, job) {
	const entry = OIDC_ALLOWLIST.find((e) => file.endsWith(`/${e.file}`) && e.job === job.id);
	if (!entry) return null;
	const body = job.lines.filter((l) => !/^\s*#/.test(l));
	const usesAction = body.some((l) => l.match(USES)?.[1]?.startsWith(`${entry.action}@`));
	const runs = body.some((l) => /^\s*-?\s*run:/.test(l));
	return usesAction && !runs ? entry.reason : null;
}

/**
 * Whether the workflow's `on:` includes pull_request_target.
 * @param {string} text
 */
export function triggersOn(text, event) {
	const lines = text.split('\n');
	const at = lines.findIndex((l) => /^['"]?on['"]?:/.test(l));
	if (at < 0) return false;
	const word = new RegExp(`(^|[^\\w-])${event}([^\\w-]|$)`);
	if (word.test(lines[at].replace(/^['"]?on['"]?:/, '').replace(/#.*$/, ''))) return true;
	for (let i = at + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
		if (/^\s*#/.test(lines[i])) continue;
		if (new RegExp(`^ {2}(- )?['"]?${event}['"]?:?\\s*($|#)`).test(lines[i])) return true;
	}
	return false;
}

const PR_HEAD = /github\.event\.pull_request\.head\.(sha|ref|repo|label)|github\.head_ref|refs\/pull\//;

/**
 * Lines of a pull_request_target workflow that check out or fetch the PR head.
 * @param {string} text
 * @returns {{ line: number, message: string }[]}
 */
export function prTargetHeadCheckouts(text) {
	if (!triggersOn(text, 'pull_request_target')) return [];
	/** @type {{ line: number, message: string }[]} */
	const out = [];
	text.split('\n').forEach((l, i) => {
		if (/^\s*#/.test(l)) return;
		const code = l.replace(/\s#.*$/, '');
		let why = null;
		if (/^\s+(ref|repository):/.test(code) && PR_HEAD.test(code)) why = 'a checkout of the PR head';
		else if (/\bgh\s+pr\s+checkout\b/.test(code)) why = '`gh pr checkout`';
		else if (/\bgit\s+(fetch|checkout|switch|pull|clone|worktree)\b/.test(code) && PR_HEAD.test(code)) why = 'a git fetch/checkout of the PR head';
		else if (/^\s+[A-Za-z_][A-Za-z0-9_]*:\s*['"]?\$\{\{\s*(github\.event\.pull_request\.head\.(sha|ref|repo[\w.]*)|github\.head_ref)\s*\}\}['"]?\s*$/.test(code)) why = 'the PR head passed through an env var or input';
		if (why) out.push({ line: i + 1, message: `${why} in a pull_request_target workflow: that trigger runs with this repo's token and secrets, so PR code must never be checked out or run under it (use pull_request instead)` });
	});
	return out;
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

/** Ecosystems whose Dependabot PRs a human always merges (the auto-merge rule). */
export const MANUAL_ECOSYSTEMS = ['github_actions', 'docker'];

/**
 * Dependabot directories whose PRs a human always merges, whatever their
 * ecosystem (the auto-merge rule): the renderer image's npm packages.
 */
export const MANUAL_DIRECTORIES = ['/backend/renderer-deps'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The auto-merge rule for dependabot-auto-merge.yml: its ecosystem allowlist
 * (the `fromJSON('[...]')` compared with package-ecosystem) must exist and
 * must leave out every MANUAL_ECOSYSTEMS entry, and the same `if:` must
 * exclude every MANUAL_DIRECTORIES entry twice, each clause on its own line
 * ending in `&&`: `!startsWith(steps.meta.outputs.directory, '<dir>')` and
 * `!contains(github.event.pull_request.head.ref, '<dir>/')` (fetch-metadata
 * derives the directory from the branch name, so the branch is the backstop).
 * @param {string} text
 * @returns {{ line?: number, message: string } | null}
 */
export function autoMergeProblem(text) {
	const lines = text.split('\n');
	const at = lines.findIndex((l) => !/^\s*#/.test(l) && /fromJSON\('\[.*\]'\).*package-ecosystem/.test(l));
	if (at < 0) return { message: 'no ecosystem allowlist (fromJSON([...]) against package-ecosystem) found; the auto-merge step must fail closed on an allowlist' };
	let listed;
	try {
		listed = JSON.parse(lines[at].match(/fromJSON\('(\[.*?\])'\)/)[1]);
	} catch {
		return { line: at + 1, message: 'the ecosystem allowlist is not a JSON array this guard can read' };
	}
	const manual = MANUAL_ECOSYSTEMS.filter((e) => listed.includes(e));
	if (manual.length) {
		return { line: at + 1, message: `the auto-merge allowlist includes ${manual.join(', ')}; those bumps stay manual (actions run with the repo's token; the renderer image's tag and digest move with its other Playwright pins)` };
	}
	// The `if:` that holds the allowlist: from its `if:` key to the next line
	// indented no deeper than that key.
	let ifAt = at;
	while (ifAt >= 0 && !/^\s+if:/.test(lines[ifAt])) ifAt--;
	if (ifAt < 0) return { line: at + 1, message: 'the ecosystem allowlist is not inside an `if:` this guard can read' };
	const indent = lines[ifAt].match(/^\s*/)[0].length;
	const block = [lines[ifAt].replace(/^\s+if:\s*(>-?|\|-?)?\s*/, '')];
	for (let i = ifAt + 1; i < lines.length && (lines[i].match(/^\s*/)[0].length > indent || /^\s*$/.test(lines[i])); i++) {
		if (!/^\s*$/.test(lines[i])) block.push(lines[i].trim());
	}
	const missing = [];
	for (const dir of MANUAL_DIRECTORIES) {
		const byDirectory = new RegExp(`^!startsWith\\(steps\\.meta\\.outputs\\.directory, '${escapeRe(dir)}'\\) &&$`);
		const byBranch = new RegExp(`^!contains\\(github\\.event\\.pull_request\\.head\\.ref, '${escapeRe(dir)}/'\\) &&$`);
		if (!block.some((l) => byDirectory.test(l))) missing.push(`!startsWith(steps.meta.outputs.directory, '${dir}') &&`);
		if (!block.some((l) => byBranch.test(l))) missing.push(`!contains(github.event.pull_request.head.ref, '${dir}/') &&`);
	}
	if (missing.length) {
		return { line: ifAt + 1, message: `the auto-merge condition does not exclude the renderer image's npm directory; add, each on its own line: ${missing.join(' / ')}` };
	}
	return null;
}

const COMMIT_SHA_REF = /\$\{\{\s*(needs\.[\w-]+\.outputs\.sha|github\.sha)\s*\}\}/;

/**
 * The steps (1-based start lines) that run `docker push` without naming the
 * commit SHA anywhere in the step: its `env:`, `with:` or `run:`. A step runs
 * from its `- ` line to the next line indented no deeper than that dash.
 * @param {string[]} lines
 * @returns {number[]}
 */
export function unshaPushSteps(lines) {
	const out = [];
	lines.forEach((l, i) => {
		if (/^\s*#/.test(l) || !/\bdocker\s+push\b/.test(l)) return;
		let start = i;
		while (start >= 0 && !/^\s*- /.test(lines[start])) start--;
		if (start < 0) return;
		const indent = lines[start].match(/^\s*/)[0].length;
		let end = start + 1;
		while (end < lines.length && (/^\s*$/.test(lines[end]) || lines[end].match(/^\s*/)[0].length > indent)) end++;
		const step = lines.slice(start, end).filter((x) => !/^\s*#/.test(x)).join('\n');
		if (!COMMIT_SHA_REF.test(step) && !out.includes(start + 1)) out.push(start + 1);
	});
	return out;
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

	for (const line of unshaPushSteps(lines)) {
		out.push({ file, line, rule: 'image-sha', message: 'a step pushes an image without naming the commit it was built from; tag it <version>-<sha> (needs.<job>.outputs.sha or github.sha) so a recut release pushes its own image' });
	}

	const perms = topLevelPermissions(text);
	if (!perms) {
		out.push({ file, rule: 'perms', message: 'no top-level permissions: block (least-privilege default missing)' });
	} else if (/id-token:\s*['"]?write/.test(perms) || /^permissions:\s*['"]?write-all/m.test(perms)) {
		out.push({ file, rule: 'perms', message: 'top-level permissions grant id-token: write (or write-all); grant it only on the job that assumes a role' });
	}

	for (const job of jobsOf(text)) {
		const body = job.lines.join('\n');
		if (/uses:\s*aws-actions\/configure-aws-credentials@/.test(body) && !isProductionGated(job.lines)) {
			out.push({ file, line: job.startLine, rule: 'oidc-env', message: `job ${job.id} assumes an AWS role but is not gated on environment: production` });
		}
		if (grantsIdToken(job.lines) && !isProductionGated(job.lines) && !oidcAllowlisted(file, job)) {
			out.push({ file, line: job.startLine, rule: 'oidc-gate', message: `job ${job.id} grants id-token: write without environment: production; gate it, or drop the grant (OIDC_ALLOWLIST is for one named non-AWS action in a job with no run steps)` });
		}
	}

	for (const f of prTargetHeadCheckouts(text)) out.push({ file, line: f.line, rule: 'prt-head', message: f.message });

	if (jobsOf(text).some((j) => isProductionGated(j.lines))) {
		lines.forEach((l, i) => {
			if (/^\s*#/.test(l)) return;
			if (/^\s+cache:\s*\S/.test(l) || /uses:\s*actions\/cache(\/restore)?@/.test(l)) {
				out.push({ file, line: i + 1, rule: 'no-cache', message: 'a deploy workflow restores a dependency cache; release builds install cold so a poisoned cache cannot reach production' });
			}
		});
	}

	if (file.endsWith('/dependabot-auto-merge.yml')) {
		const problem = autoMergeProblem(text);
		if (problem) out.push({ file, line: problem.line, rule: 'auto-merge', message: problem.message });
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
