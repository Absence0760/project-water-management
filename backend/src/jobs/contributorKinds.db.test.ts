// The kinds a contributor can queue are exactly those contributorKinds.ts
// lists with per-user dedupe keys (issue #386). Read from the job table's
// policies: an insert policy gated only on viewer or above admits people who
// read every job of the project (job_select), so any dedupe key works for
// them; any other insert policy admits someone below viewer, who reads only
// their own jobs, and must name its kinds, each listed in contributorKinds.ts.
import { describe, expect, it } from 'vitest';
import { asOwner } from '../__tests__/helpers.js';
import { CONTRIBUTOR_JOB_DEDUPE_KEYS } from './contributorKinds.js';

type Policy = { name: string; cmd: string; expr: string };

const policies = async () =>
	(await asOwner(`SELECT policyname AS name, cmd, coalesce(with_check, qual) AS expr FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job' ORDER BY 1`)) as Policy[];

/** Gated only on app_has_role at viewer or above (plus the acting-user stamp): no other app_* function, no lower role. */
function viewerOrAbove(expr: string): boolean {
	const fns = [...expr.matchAll(/\b(app_\w+)\(/g)].map((m) => m[1]);
	const roles = [...expr.matchAll(/app_has_role\(project_id, '(\w+)'::project_role\)/g)].map((m) => m[1]);
	return (
		fns.every((f) => f === 'app_has_role' || f === 'app_current_user_id') &&
		roles.length === fns.filter((f) => f === 'app_has_role').length &&
		roles.length > 0 &&
		roles.every((r) => r === 'viewer' || r === 'editor' || r === 'owner')
	);
}

describe('the job kinds a contributor can queue (issue #386)', () => {
	it('viewers read every job, so a key shared among viewers and editors always finds its pending job', async () => {
		const select = (await policies()).find((p) => p.name === 'job_select');
		expect(select?.expr).toBe(`app_has_role(project_id, 'viewer'::project_role)`);
	});

	it('are exactly the kinds contributorKinds.ts keys per user', async () => {
		const below = (await policies()).filter((p) => p.cmd === 'INSERT' && !viewerOrAbove(p.expr));
		const kinds = new Set<string>();
		for (const p of below) {
			const named = [...p.expr.matchAll(/\(kind = '(\w+)'::text\)/g)].map((m) => m[1]!);
			// A policy below viewer that names no kind would let a contributor queue any kind.
			expect(named, `${p.name} admits someone below viewer without naming its kind: ${p.expr}`).toHaveLength(1);
			kinds.add(named[0]!);
		}
		expect([...kinds].sort()).toEqual(Object.keys(CONTRIBUTOR_JOB_DEDUPE_KEYS).sort());
	});

	it('positive control: the base insert policy reads as viewer-or-above, and the contributor ones don’t', async () => {
		const byName = Object.fromEntries((await policies()).map((p) => [p.name, p.expr]));
		expect(viewerOrAbove(byName.job_insert!)).toBe(true);
		expect(viewerOrAbove(byName.job_insert_contributor!)).toBe(false);
		expect(viewerOrAbove(byName.job_insert_applicant_copy!)).toBe(false);
	});
});
