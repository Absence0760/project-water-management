#!/usr/bin/env node
// Release preflight for deploy-frontend.yml and deploy-backend.yml.
//
// Runs in a job with NO environment and NO AWS credentials, before anything
// is built or deployed, and refuses the release unless every precondition
// holds. It reports every failed precondition at once, not just the first.
//
//   tag          `<component>@X.Y.Z` (web@1.2.0, backend@1.2.0). A prerelease
//                (`-rc.1`) is skipped on a release event and refused on a
//                manual run: prereleases never reach production.
//   release      a published (not draft) GitHub Release exists for the tag.
//   version      on a release event, the version is newer than every other
//                published release of the same component (a manual run may
//                redeploy an older tag: that is the rollback path).
//   main         the tagged commit is on main. The operator pushes to main,
//                so a tag cut from a side branch is refused.
//   ci           the `CI gate` check on the tagged commit passed. Waits up to
//                CI_WAIT_SECONDS while it is still running (a release cut
//                right after a push), then fails.
//   environment  the `production` environment exists and has a required
//                reviewer. Without this, the deploy job's `environment:
//                production` would auto-create an UNPROTECTED environment and
//                the approval gate would silently not exist.
//   config       every AWS variable and secret the deploy reads is set (they
//                come from `export-tf-vars.sh` after `terraform apply`), so an
//                un-bootstrapped account fails here with a pointer to the
//                runbook instead of half-way through a deploy.
//
// Usage (CI):     node scripts/release/preflight.mjs <web|backend>
//   env: RELEASE_TAG, GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GH_TOKEN,
//        REQUIRED_CONFIG (comma-separated env var names that must be set),
//        CI_WAIT_SECONDS (default 1800), GITHUB_OUTPUT.
// Usage (local):  RELEASE_TAG=web@0.1.0 GITHUB_EVENT_NAME=workflow_dispatch \
//                 GITHUB_REPOSITORY=Absence0760/project-water-management \
//                 node scripts/release/preflight.mjs web
// Tests:          node --test scripts/release/preflight.test.mjs

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = Object.freeze(['web', 'backend']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RUNBOOK = 'infra/README.md § Operator steps';

/**
 * @param {string} tag
 * @param {string} component
 * @returns {{ ok: true, version: string, prerelease: boolean } | { ok: false, error: string }}
 */
export function parseReleaseTag(tag, component) {
	const prefix = `${component}@`;
	if (!tag) return { ok: false, error: 'no release tag (RELEASE_TAG is empty)' };
	if (!tag.startsWith(prefix)) return { ok: false, error: `tag "${tag}" is not a ${component} release (expected ${prefix}X.Y.Z)` };
	const version = tag.slice(prefix.length);
	const m = version.match(SEMVER);
	if (!m) return { ok: false, error: `tag "${tag}": "${version}" is not a semantic version (X.Y.Z)` };
	return { ok: true, version, prerelease: m[4] !== undefined };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} <0, 0, >0 (release versions only; prerelease suffixes ignored)
 */
export function compareVersions(a, b) {
	const pa = a.split('-')[0].split('.').map(Number);
	const pb = b.split('-')[0].split('.').map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	return 0;
}

/**
 * Versions of other published, non-prerelease releases of this component that
 * are not older than `version`.
 * @param {string} version
 * @param {string} component
 * @param {string} tag
 * @param {{ tagName: string, isDraft: boolean, isPrerelease: boolean }[]} releases
 */
export function notNewerThan(version, component, tag, releases) {
	return releases
		.filter((r) => !r.isDraft && !r.isPrerelease && r.tagName !== tag)
		.map((r) => parseReleaseTag(r.tagName, component))
		.filter((p) => p.ok && !p.prerelease)
		.map((p) => /** @type {{ version: string }} */ (p).version)
		.filter((v) => compareVersions(v, version) >= 0);
}

/**
 * The newest `CI gate` check run decides.
 * @param {{ id: number, status: string, conclusion: string | null }[]} runs
 * @returns {{ state: 'pass' | 'pending' | 'fail', detail: string }}
 */
export function ciGateState(runs) {
	if (!runs.length) return { state: 'fail', detail: 'no "CI gate" check run exists for this commit, so CI never ran on it' };
	const latest = [...runs].sort((a, b) => b.id - a.id)[0];
	if (latest.status !== 'completed') return { state: 'pending', detail: `"CI gate" is ${latest.status}` };
	if (latest.conclusion === 'success') return { state: 'pass', detail: '"CI gate" passed' };
	return { state: 'fail', detail: `"CI gate" concluded ${latest.conclusion}` };
}

/**
 * @param {null | { protection_rules?: { type: string, reviewers?: unknown[] }[] }} env
 *        null when the environment does not exist
 * @returns {string | null} the problem, or null when the gate holds
 */
export function environmentProblem(env) {
	if (!env) {
		return 'the "production" GitHub environment does not exist. A deploy job naming it would auto-create it with NO required reviewer, so nothing would stop the deploy. Create it with a required reviewer (templates/scripts/backfill-prod-environment.sh --apply). On a private repo this needs GitHub Pro/Team, or make the repo public (CLAUDE.md rule 11 says it is).';
	}
	const reviewers = (env.protection_rules ?? []).filter((r) => r.type === 'required_reviewers').flatMap((r) => r.reviewers ?? []);
	if (!reviewers.length) {
		return 'the "production" environment has no required reviewer, so a release would deploy without anyone approving it. Add the operator as a required reviewer (templates/scripts/backfill-prod-environment.sh --apply).';
	}
	return null;
}

/**
 * @param {readonly string[]} names
 * @param {Record<string, string | undefined>} env
 */
export const missingConfig = (names, env) => names.filter((n) => !(env[n] ?? '').trim());

// ── I/O ────────────────────────────────────────────────────────────────────

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
	return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string[]} args */
function tryRun(cmd, args) {
	try {
		return { ok: true, out: run(cmd, args) };
	} catch (e) {
		const err = /** @type {{ stderr?: string, message: string }} */ (e);
		return { ok: false, out: String(err.stderr || err.message) };
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const component = process.argv[2];
	const env = process.env;
	const repo = env.GITHUB_REPOSITORY ?? '';
	const tag = (env.RELEASE_TAG ?? '').trim();
	const isReleaseEvent = env.GITHUB_EVENT_NAME === 'release';
	const waitSeconds = Number(env.CI_WAIT_SECONDS ?? 1800);
	/** @type {string[]} */
	const errors = [];
	/** @type {Record<string, string>} */
	const outputs = { deploy: 'false', tag, sha: '', version: '' };

	const finish = () => {
		for (const e of errors) console.log(`::error::${e}`);
		if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
		if (env.GITHUB_STEP_SUMMARY) {
			const lines = [`## Release preflight: ${tag || '(no tag)'}`, '', errors.length ? `**Refused.** ${errors.length} problem(s):` : outputs.deploy === 'true' ? '**Cleared.** Waiting for the production approval next.' : '**Skipped.**', '', ...errors.map((e) => `- ${e}`), ''];
			appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
		}
		process.exit(errors.length ? 1 : 0);
	};

	if (!COMPONENTS.includes(component)) {
		errors.push(`unknown component "${component}" (expected one of ${COMPONENTS.join(', ')})`);
		return finish();
	}
	if (!repo) errors.push('GITHUB_REPOSITORY is not set');

	// tag
	const parsed = parseReleaseTag(tag, component);
	if (!parsed.ok) {
		errors.push(parsed.error);
		return finish();
	}
	outputs.version = parsed.version;
	if (parsed.prerelease) {
		if (isReleaseEvent) {
			console.log(`::notice::${tag} is a prerelease; prereleases are never deployed to production. Skipping.`);
			return finish();
		}
		errors.push(`${tag} is a prerelease; prereleases are never deployed to production`);
		return finish();
	}

	// release
	const rel = tryRun('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease']);
	if (!rel.ok) {
		errors.push(`no GitHub Release for ${tag} (${rel.out.trim().split('\n')[0]}). Publish one: gh release create ${tag} --target main --generate-notes`);
	} else {
		const r = JSON.parse(rel.out);
		if (r.isDraft) errors.push(`the ${tag} release is still a draft; publish it`);
		if (r.isPrerelease) {
			if (isReleaseEvent) {
				console.log(`::notice::${tag} is marked as a prerelease; skipping.`);
				return finish();
			}
			errors.push(`the ${tag} release is marked as a prerelease; prereleases are never deployed to production`);
		}
	}

	// version ordering (release events only; a manual run is the rollback path)
	if (isReleaseEvent) {
		const list = tryRun('gh', ['release', 'list', '--repo', repo, '--limit', '200', '--json', 'tagName,isDraft,isPrerelease']);
		if (!list.ok) errors.push(`could not list releases to check version ordering: ${list.out.trim().split('\n')[0]}`);
		else {
			const newer = notNewerThan(parsed.version, component, tag, JSON.parse(list.out));
			if (newer.length) errors.push(`${tag} is not newer than already-published ${newer.map((v) => `${component}@${v}`).join(', ')}. Bump the version; to roll back, run the workflow manually with the older tag (docs/deployment.md § Rollback)`);
		}
	}

	// environment
	const envRes = tryRun('gh', ['api', `repos/${repo}/environments/production`]);
	if (envRes.ok) {
		const problem = environmentProblem(JSON.parse(envRes.out));
		if (problem) errors.push(problem);
	} else if (/Not Found|HTTP 404/.test(envRes.out)) {
		errors.push(/** @type {string} */ (environmentProblem(null)));
	} else {
		errors.push(`could not read the production environment, so the approval gate cannot be confirmed: ${envRes.out.trim().split('\n')[0]}`);
	}

	// config
	const required = (env.REQUIRED_CONFIG ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	const missing = missingConfig(required, env);
	if (missing.length) {
		errors.push(`not configured: ${missing.join(', ')}. These come from Terraform outputs; the AWS account is not bootstrapped or CI was never wired. Follow ${RUNBOOK} (apply, then step 9: templates/scripts/export-tf-vars.sh infra/). Nothing was built or deployed.`);
	}

	// the tagged commit, and that it is on main
	const sha = tryRun('git', ['rev-list', '-n', '1', `refs/tags/${tag}`]);
	if (!sha.ok) {
		errors.push(`tag ${tag} is not in this clone (${sha.out.trim().split('\n')[0]})`);
		return finish();
	}
	outputs.sha = sha.out.trim();
	if (!tryRun('git', ['merge-base', '--is-ancestor', outputs.sha, 'origin/main']).ok) {
		errors.push(`${tag} (${outputs.sha.slice(0, 12)}) is not on main. Releases are cut from main: gh release create ${tag} --target main`);
	}

	// CI gate on the tagged commit (last: the only step that waits)
	if (outputs.sha) {
		const deadline = Date.now() + waitSeconds * 1000;
		for (;;) {
			const res = tryRun('gh', ['api', `repos/${repo}/commits/${outputs.sha}/check-runs?check_name=${encodeURIComponent('CI gate')}&per_page=100`, '--jq', '.check_runs | map({id, status, conclusion})']);
			if (!res.ok) {
				errors.push(`could not read CI status for ${outputs.sha.slice(0, 12)}: ${res.out.trim().split('\n')[0]}`);
				break;
			}
			const state = ciGateState(JSON.parse(res.out));
			if (state.state === 'pass') break;
			if (state.state === 'fail' || Date.now() > deadline) {
				errors.push(`CI did not pass on ${outputs.sha.slice(0, 12)}: ${state.detail}${state.state === 'pending' ? ` after ${waitSeconds}s` : ''}. Only a commit whose CI gate is green may be released.`);
				break;
			}
			console.log(`${state.detail}; waiting for it to finish`);
			await sleep(30_000);
		}
	}

	if (!errors.length) outputs.deploy = 'true';
	return finish();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
