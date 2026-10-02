// The applicant's printable copy of an issued pack (165_applicant_copy): what
// the API (evidence/applicantPacks.ts) and the job
// (jobs/handlers/applicant-pack-render.ts) share, without the API importing
// the job.

/** The dedupe key of a party's request for a pack's copy: one pending per pack and party (a party reads only their own jobs). */
export const applicantCopyDedupeKey = (packId: string, userId: string) => `applicant_copy:${packId}:${userId}`;
