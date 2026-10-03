// The job kinds a contributor (an applicant) can queue, and every dedupe key
// they are queued under (issue #386).
//
// A contributor reads only their own jobs of these kinds (096_contributor_yield,
// 165_applicant_copy), while the dedupe index is per project. A key shared with
// anyone else lets their pending job block the contributor's insert, and
// enqueueJob then has no job it can hand back (JobCollisionError, a 409). So
// every key here names the user. contributorKinds.test.ts checks each one
// does; contributorKinds.db.test.ts checks this list is exactly the kinds the
// job table's insert policies let someone below viewer queue. A new kind a
// contributor can queue fails there until it is listed here with its keys.
import { applicantCopyDedupeKey, applicantCopyResultDedupeKey, applicantCopyRetryDedupeKey } from '../evidence/applicantCopy.js';
import { YieldRequest, yieldDedupeKey } from '../yield/store.js';
import type { JobKind } from './registry.js';

const SAMPLE_ID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_YIELD = YieldRequest.parse({ kind: 'firm', scenarioId: SAMPLE_ID, nodeId: SAMPLE_ID });

/** Per kind, each dedupe key a contributor's job of that kind is queued under, as a function of the user. */
export const CONTRIBUTOR_JOB_DEDUPE_KEYS: Partial<Record<JobKind, readonly ((userId: string) => string)[]>> = {
	// yield/routes.ts: a contributor's request (an editor's is shared by the editors, who read every job).
	yield: [(u) => yieldDedupeKey(SAMPLE_YIELD, u)],
	// evidence/applicantPacks.ts (the request), jobs/handlers/applicant-pack-render.ts (the retry),
	// reports/schedule.ts acceptPackRenderResult (the renderer's answer).
	applicant_pack_render: [(u) => applicantCopyDedupeKey(SAMPLE_ID, u), (u) => applicantCopyRetryDedupeKey(SAMPLE_ID, u, 1), (u) => applicantCopyResultDedupeKey(SAMPLE_ID, u)]
};
