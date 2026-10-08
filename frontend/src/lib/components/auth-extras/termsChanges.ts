// What changed in the terms and privacy notice, version by version, and
// which of those lines the re-acceptance step shows (TermsUpdate.svelte).
import { msg, type Msg } from '$lib/i18n/locale.svelte';

/** One version's changes, as TermsUpdate.svelte lists them: its LEGAL_VERSION and its lines (messages, msg()). */
export interface TermsChange<T = string> {
	version: string;
	items: T[];
}

/**
 * Every change made after the version the account accepted, newest version
 * first; all of them when it accepted none (null: an account a script made).
 * Versions are ISO dates, so they compare as strings.
 */
export function changesSince<T>(changes: readonly TermsChange<T>[], accepted: string | null): T[] {
	return changes.filter((c) => accepted === null || c.version > accepted).flatMap((c) => c.items);
}

// i18n-section: terms-update
// What changed, by the version it came in (LEGAL_VERSION, packages/engine/src/legal.ts), newest first. When
// LEGAL_VERSION changes, add its entry on top and keep the older ones: an account that accepted an older version
// (session.user.termsVersion) is shown every change since, so two versions landing between deploys never
// hide the first one's changes (persona-wua-manager, round 4). An account that accepted none sees them all.
export const TERMS_CHANGES: readonly TermsChange<Msg>[] = [
	// Removing two-step sign-in after a lost phone (205_mfa_recovery, docs/legal-status.md, 2026-10-08).
	{
		version: '2026-10-08',
		items: [
			msg('If you lose your phone and ask us to remove two-step sign-in, or a team admin removes it, we keep a record of the request and how it ended for 90 days, and the record that it happened with your account.')
		]
	},
	// The Terms §9 clause on map data licensed to us (HydroRIVERS' end-user terms, docs/legal-status.md, 2026-10-02).
	{
		version: '2026-10-03',
		items: [
			msg('Some map data, such as the river network, is licensed to us by others. You may use it in the service and in your projects, results, reports and maps, but not copy or share it on its own, or try to reverse engineer it.')
		]
	},
	// The positions taken pending counsel (docs/legal-status.md, 2026-10-02): lawful bases and the right to object,
	// deleted notes and invitation entries, restores, licence records' dates, registered water use outside the
	// organisation, the organisation's privacy contact, and public comments on a licence application.
	{
		version: '2026-10-02',
		items: [
			msg('We now say which lawful basis covers each use of your information. Alert emails are service messages that never advertise anything, and you can object to them, or to an organisation’s use of your information, at any time.'),
			msg('A deleted note’s text is erased 90 days after it is deleted, and when you delete your account, the partly hidden email in invitation entries is removed.'),
			msg('If we ever restore the database from a backup, we first delete again everything that was deleted after the backup was made.'),
			msg('Licence records, and the names they keep, are kept until a set date and then deleted.'),
			msg('Outside the organisation, registered water use is shown only as totals, never with a name.'),
			msg('Each organisation can now name whom to ask about your information; you’ll find it on your farm page and in your invitation.'),
			msg('When you comment publicly on a licence application, the applicant receives your comment, display name and date for their public participation report, and your email only if you tick the box to join their register. You can also comment through a share link without joining the project.')
		]
	}
];
