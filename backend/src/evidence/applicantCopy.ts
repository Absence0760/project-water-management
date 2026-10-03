// The applicant's printable copy of an issued pack (165_applicant_copy): what
// the API (evidence/applicantPacks.ts) and the job
// (jobs/handlers/applicant-pack-render.ts) share, without the API importing
// the job.

/** The dedupe key of a party's request for a pack's copy: one pending per pack and party (a party reads only their own jobs). */
export const applicantCopyDedupeKey = (packId: string, userId: string) => `applicant_copy:${packId}:${userId}`;

/**
 * A failed render's retry, the `made`-th (jobs/handlers/applicant-pack-render.ts): its own key, so it never stands
 * in for the request, and the party's, since they read only their own jobs.
 */
export const applicantCopyRetryDedupeKey = (packId: string, userId: string, made: number) => `applicant_copy_retry:${packId}:${userId}:${made}`;

/**
 * The renderer Lambda's answer for a party's copy, queued as that party (reports/schedule.ts acceptPackRenderResult).
 * Per party: two of a party's members can each ask for the copy, and a key shared between them would meet the
 * other's pending answer, which they can't read (issue #386). Redelivered answers still collapse, and the first
 * copy recorded stands (app_record_applicant_pack_pdf).
 */
export const applicantCopyResultDedupeKey = (packId: string, userId: string) => `applicant_copy_result:${packId}:${userId}`;
