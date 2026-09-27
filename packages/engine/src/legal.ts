// The version of the terms of use and privacy notice (/terms, /privacy): the
// date both took effect, in one place. The legal pages show it as their
// "Effective" line; the sign-up form sends it as `acceptTerms`, and
// POST /auth/register refuses any other version and stores it on the account
// (app_user.terms_version, 087; docs/legal-status.md). Bump it when either
// page changes materially, the same day the new text goes live: every account
// that accepted an older one then reads `termsCurrent: false` on /auth/me.
// A module of its own, with no imports, so the legal pages and the e2e
// helpers load nothing else.

/** The terms and privacy notice in force: the date they took effect, `YYYY-MM-DD`. */
export const LEGAL_VERSION = '2026-09-27';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Effective 27 September 2026." for a `YYYY-MM-DD` version: the legal pages' line under their title. */
export function legalEffective(version: string = LEGAL_VERSION): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
	const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
	if (!m || !month) throw new Error(`not a YYYY-MM-DD legal version: ${version}`);
	return `Effective ${Number(m[3])} ${month} ${m[1]}.`;
}
