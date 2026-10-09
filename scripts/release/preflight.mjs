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
//                right after a push: `CI gate` is ci.yml's last job, so until
//                the jobs it needs finish there is no check run, only an
//                unfinished ci.yml run of the commit), then fails. Only a `CI gate` posted by
//                the GitHub Actions app, from a run of .github/workflows/ci.yml
//                on a push or manual run of that exact commit, counts: any
//                app with checks:write can post a check run by that name, and
//                a pull_request run executes the merge ref's ci.yml, which the
//                PR itself can rewrite.
//   environment  the `production` environment exists and has a required
//                reviewer. Without this, the deploy job's `environment:
//                production` would auto-create an UNPROTECTED environment and
//                the approval gate would silently not exist. It also has a
//                custom deployment branch policy allowing exactly `main`
//                (branch) and `backend@*` / `web@*` (tags), so no other branch
//                or tag can reach the deploy job's OIDC subject.
//   tags         an active tag ruleset restricts creating, moving and deleting
//                `backend@*` and `web@*` tags, so a released tag cannot be
//                re-pointed at another commit after its checks passed.
//   config       every AWS variable and secret the deploy reads is set (they
//                come from `export-tf-vars.sh` after `terraform apply`), so an
//                un-bootstrapped account fails here with a pointer to the
//                runbook instead of half-way through a deploy.
//
// Usage (CI):     node scripts/release/preflight.mjs <web|backend>
//                 node scripts/release/preflight.mjs environment   (the
//                 environment and config checks alone, for a production-gated
//                 workflow that deploys no release: load-reference.yml)
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

/** The GitHub Actions app, the only app whose `CI gate` check run counts. */
export const ACTIONS_APP = Object.freeze({ id: 15368, slug: 'github-actions' });
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
/** Events whose run executes the workflow file at the commit itself (not a PR merge ref). */
const CI_EVENTS = ['push', 'workflow_dispatch'];

/**
 * @typedef {{ id: number, status: string, conclusion: string | null, app?: { id?: number, slug?: string } | null, check_suite_id?: number | null }} CheckRun
 * @typedef {{ path?: string, event?: string, head_sha?: string, head_repository?: string | null, status?: string }} WorkflowRun
 */

/**
 * Split the `CI gate` check runs on a commit into the ones that count and the
 * reasons the others do not. A run counts only when the GitHub Actions app
 * posted it and its check suite belongs to a run of ci.yml, triggered by a
 * push or a manual run, on this very commit in this repository.
 * @param {CheckRun[]} checkRuns
 * @param {Record<string, WorkflowRun[]>} runsBySuite workflow runs per check suite id
 * @param {string} sha
 * @param {string} repo owner/name
 * `unresolved` counts GitHub Actions runs whose check suite has no workflow run
 * yet: right after a push the check run can appear before its workflow run is
 * indexed, so that is a wait, not a verdict.
 * @returns {{ trusted: CheckRun[], ignored: string[], unresolved: number }}
 */
export function trustedCiGateRuns(checkRuns, runsBySuite, sha, repo) {
	/** @type {CheckRun[]} */
	const trusted = [];
	/** @type {string[]} */
	const ignored = [];
	let unresolved = 0;
	for (const cr of checkRuns) {
		if (cr.app?.id !== ACTIONS_APP.id || cr.app?.slug !== ACTIONS_APP.slug) {
			ignored.push(`check run ${cr.id} was posted by ${cr.app?.slug ?? 'an unknown app'}, not GitHub Actions`);
			continue;
		}
		const wfRuns = cr.check_suite_id == null ? [] : (runsBySuite[String(cr.check_suite_id)] ?? []);
		const match = wfRuns.find(
			(w) => (w.path ?? '').split('@')[0] === CI_WORKFLOW_PATH && CI_EVENTS.includes(w.event ?? '') && w.head_sha === sha && (w.head_repository ?? repo) === repo,
		);
		if (match) {
			trusted.push(cr);
			continue;
		}
		const w = wfRuns[0];
		if (!w && cr.check_suite_id != null) unresolved++;
		ignored.push(
			w
				? `check run ${cr.id} came from ${w.path ?? '(no path)'} on a ${w.event ?? '(unknown)'} event for ${(w.head_sha ?? '').slice(0, 12) || '(no sha)'}${w.head_repository && w.head_repository !== repo ? ` in ${w.head_repository}` : ''}, not ${CI_WORKFLOW_PATH} on a push or manual run of this commit`
				: `check run ${cr.id} belongs to no workflow run of this repository`,
		);
	}
	return { trusted, ignored, unresolved };
}

/**
 * Count the runs of ci.yml, on a push or a manual run of this very commit in
 * this repository, that have not finished. Until one finishes its `CI gate`
 * check run does not exist, so the preflight waits on these instead.
 * @param {WorkflowRun[]} workflowRuns ci.yml's runs for the commit (`status` included)
 * @param {string} sha
 * @param {string} repo owner/name
 */
export function runningCiRuns(workflowRuns, sha, repo) {
	return workflowRuns.filter(
		(w) => (w.path ?? '').split('@')[0] === CI_WORKFLOW_PATH && CI_EVENTS.includes(w.event ?? '') && w.head_sha === sha && (w.head_repository ?? repo) === repo && w.status !== 'completed',
	).length;
}

/**
 * The newest `CI gate` check run decides.
 * @param {{ id: number, status: string, conclusion: string | null }[]} runs the trusted runs (trustedCiGateRuns)
 * @param {string[]} [ignored] why other runs by that name did not count
 * @param {number} [unresolved] Actions runs whose workflow run is not indexed yet (trustedCiGateRuns)
 * @param {number} [running] unfinished ci.yml runs of this commit (runningCiRuns): `CI gate` is the
 *   last job, so GitHub creates its check run only once every job it needs has finished
 * @returns {{ state: 'pass' | 'pending' | 'fail', detail: string }}
 */
export function ciGateState(runs, ignored = [], unresolved = 0, running = 0) {
	if (!runs.length && unresolved > 0) {
		return { state: 'pending', detail: `"CI gate" exists but its workflow run is not visible yet (${unresolved} check suite${unresolved === 1 ? '' : 's'})` };
	}
	if (!runs.length && running > 0) {
		return { state: 'pending', detail: `${CI_WORKFLOW_PATH} is still running on this commit (${running} run${running === 1 ? '' : 's'}); "CI gate" is its last job` };
	}
	if (!runs.length) {
		const why = ignored.length ? ` (ignored: ${ignored.join('; ')})` : '';
		return { state: 'fail', detail: `no "CI gate" check run from ${CI_WORKFLOW_PATH} under GitHub Actions exists for this commit, so CI never ran on it${why}` };
	}
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

/** Exactly what may deploy to `production`: main, and the release tags. */
export const DEPLOYMENT_POLICIES = Object.freeze([
	{ name: 'main', type: 'branch' },
	{ name: 'backend@*', type: 'tag' },
	{ name: 'web@*', type: 'tag' },
]);

/**
 * @param {{ deployment_branch_policy?: { protected_branches?: boolean, custom_branch_policies?: boolean } | null }} env
 * @param {{ name: string, type?: string }[] | null} policies the environment's
 *        deployment-branch-policies (null when custom policies are off)
 * @returns {string | null}
 */
export function branchPolicyProblem(env, policies) {
	const how = 'docs/deployment.md § The production environment\'s branch and tag policy';
	const dbp = env.deployment_branch_policy;
	if (!dbp) return `the "production" environment has no deployment branch policy, so a workflow run from ANY branch or tag can reach the deploy job (and its OIDC subject) once a reviewer approves. Restrict it to main and the backend@*/web@* tags (${how}).`;
	if (!dbp.custom_branch_policies) return `the "production" environment's deployment branch policy is "protected branches", not a custom list, so release tags cannot deploy and any protected branch can. Switch it to custom branches and tags: main, backend@*, web@* (${how}).`;
	const got = (policies ?? []).map((p) => ({ name: p.name, type: p.type ?? 'branch' }));
	const key = (/** @type {{ name: string, type: string }} */ p) => `${p.type} ${p.name}`;
	const want = new Set(DEPLOYMENT_POLICIES.map(key));
	const have = new Set(got.map(key));
	const missing = DEPLOYMENT_POLICIES.filter((p) => !have.has(key(p)));
	const extra = got.filter((p) => !want.has(key(p)));
	const parts = [];
	if (missing.length) parts.push(`missing ${missing.map(key).join(', ')}`);
	if (extra.length) parts.push(`also allows ${extra.map(key).join(', ')}, which must not deploy`);
	return parts.length ? `the "production" environment's deployment policy must allow exactly branch main, tag backend@*, tag web@*: ${parts.join('; ')} (${how}).` : null;
}

/** The rules a tag ruleset must apply to the release tags. */
export const TAG_RULES = Object.freeze(['creation', 'update', 'deletion']);

/**
 * @param {{ name?: string, target?: string, enforcement?: string, conditions?: { ref_name?: { include?: string[], exclude?: string[] } } | null, rules?: { type: string }[] }[]} rulesets
 *        every ruleset on the repository, in full (with conditions and rules)
 * @returns {string | null}
 */
export function tagRulesetProblem(rulesets) {
	const problems = [];
	for (const comp of COMPONENTS) {
		const ref = `refs/tags/${comp}@*`;
		const covering = rulesets.filter((r) => {
			if (r.target !== 'tag' || r.enforcement !== 'active') return false;
			const inc = r.conditions?.ref_name?.include ?? [];
			const exc = r.conditions?.ref_name?.exclude ?? [];
			return (inc.includes(ref) || inc.includes('~ALL')) && !exc.includes(ref) && !exc.includes('~ALL');
		});
		const types = new Set(covering.flatMap((r) => (r.rules ?? []).map((x) => x.type)));
		const missing = TAG_RULES.filter((t) => !types.has(t));
		if (missing.length) problems.push(`${ref} lacks ${missing.join(', ')}`);
	}
	if (!problems.length) return null;
	return `no active tag ruleset protects the release tags (${problems.join('; ')}), so a released tag could be moved to an unchecked commit or deleted and recut. Add the "Release tags" ruleset (docs/deployment.md § The production environment's branch and tag policy).`;
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

/**
 * The environment gate: `production` exists, has a required reviewer and
 * the custom branch and tag policy. Pushes each problem onto `errors`.
 * @param {string} repo
 * @param {string[]} errors
 */
function checkEnvironment(repo, errors) {
	const envRes = tryRun('gh', ['api', `repos/${repo}/environments/production`]);
	if (envRes.ok) {
		const envJson = JSON.parse(envRes.out);
		const problem = environmentProblem(envJson);
		if (problem) errors.push(problem);
		/** @type {{ name: string, type?: string }[] | null} */
		let policies = null;
		let readPolicies = true;
		if (envJson.deployment_branch_policy?.custom_branch_policies) {
			const pol = tryRun('gh', ['api', '--paginate', `repos/${repo}/environments/production/deployment-branch-policies?per_page=100`, '--jq', '.branch_policies[] | "\\(.type // "branch") \\(.name)"']);
			if (!pol.ok) {
				readPolicies = false;
				errors.push(`could not read the production environment's deployment branch policies: ${pol.out.trim().split('\n')[0]}`);
			} else {
				// one "<type> <name>" per line: raw strings, whatever the page count
				policies = pol.out.split('\n').filter((l) => l.trim()).map((l) => {
					const [type, ...name] = l.trim().split(' ');
					return { type, name: name.join(' ') };
				});
			}
		}
		const bp = readPolicies ? branchPolicyProblem(envJson, policies) : null;
		if (bp) errors.push(bp);
	} else if (/Not Found|HTTP 404/.test(envRes.out)) {
		errors.push(/** @type {string} */ (environmentProblem(null)));
	} else {
		errors.push(`could not read the production environment, so the approval gate cannot be confirmed: ${envRes.out.trim().split('\n')[0]}`);
	}
}

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

	// `environment`: the gate alone, for a workflow that deploys no release
	// but still reaches production (load-reference.yml): the environment
	// checks and the config, no tag, release or CI.
	if (component === 'environment') {
		if (!repo) errors.push('GITHUB_REPOSITORY is not set');
		else checkEnvironment(repo, errors);
		const missingEnv = missingConfig((env.REQUIRED_CONFIG ?? '').split(',').map((x) => x.trim()).filter(Boolean), env);
		if (missingEnv.length) errors.push(`not configured: ${missingEnv.join(', ')}. Follow ${RUNBOOK} (apply, then step 9: templates/scripts/export-tf-vars.sh infra/).`);
		if (!errors.length) outputs.deploy = 'true';
		return finish();
	}

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
	checkEnvironment(repo, errors);

	// tags: the release-tag ruleset
	const rs = tryRun('gh', ['api', '--paginate', `repos/${repo}/rulesets?includes_parents=true&per_page=100`, '--jq', '.[] | select(.target == "tag") | .id']);
	if (!rs.ok) errors.push(`could not list the repository's rulesets, so the release-tag ruleset cannot be confirmed: ${rs.out.trim().split('\n')[0]}`);
	else {
		const full = [];
		for (const id of rs.out.split('\n').map((l) => l.trim()).filter(Boolean)) {
			const one = tryRun('gh', ['api', `repos/${repo}/rulesets/${id}`]);
			if (one.ok) full.push(JSON.parse(one.out));
			else errors.push(`could not read ruleset ${id}: ${one.out.trim().split('\n')[0]}`);
		}
		const problem = tagRulesetProblem(full);
		if (problem) errors.push(problem);
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
		/** @type {Record<string, WorkflowRun[]>} */
		const runsBySuite = {};
		for (;;) {
			const res = tryRun('gh', ['api', `repos/${repo}/commits/${outputs.sha}/check-runs?check_name=${encodeURIComponent('CI gate')}&per_page=100`, '--jq', '.check_runs | map({id, status, conclusion, app: {id: .app.id, slug: .app.slug}, check_suite_id: .check_suite.id})']);
			if (!res.ok) {
				errors.push(`could not read CI status for ${outputs.sha.slice(0, 12)}: ${res.out.trim().split('\n')[0]}`);
				break;
			}
			/** @type {CheckRun[]} */
			const checkRuns = JSON.parse(res.out);
			let lookupFailed = false;
			for (const cr of checkRuns) {
				const suite = cr.check_suite_id;
				if (cr.app?.id !== ACTIONS_APP.id || suite == null || runsBySuite[String(suite)]) continue;
				const wr = tryRun('gh', ['api', `repos/${repo}/actions/runs?check_suite_id=${suite}&per_page=100`, '--jq', '.workflow_runs | map({path, event, head_sha, head_repository: .head_repository.full_name})']);
				if (!wr.ok) {
					errors.push(`could not find the workflow run behind "CI gate" check suite ${suite}: ${wr.out.trim().split('\n')[0]}`);
					lookupFailed = true;
					break;
				}
				// An empty answer isn't cached: the workflow run may just not be indexed yet.
				const found = JSON.parse(wr.out);
				if (found.length) runsBySuite[String(suite)] = found;
			}
			if (lookupFailed) break;
			const { trusted, ignored, unresolved } = trustedCiGateRuns(checkRuns, runsBySuite, outputs.sha, repo);
			let running = 0;
			if (!trusted.length) {
				const wf = tryRun('gh', ['api', `repos/${repo}/actions/workflows/${CI_WORKFLOW_PATH.split('/').pop()}/runs?head_sha=${outputs.sha}&per_page=100`, '--jq', '.workflow_runs | map({path, event, head_sha, status, head_repository: .head_repository.full_name})']);
				if (!wf.ok) {
					errors.push(`could not list ${CI_WORKFLOW_PATH}'s runs for ${outputs.sha.slice(0, 12)}: ${wf.out.trim().split('\n')[0]}`);
					break;
				}
				running = runningCiRuns(JSON.parse(wf.out), outputs.sha, repo);
			}
			const state = ciGateState(trusted, ignored, unresolved, running);
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
