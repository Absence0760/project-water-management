// The sign-off dialog's rules (WP-3.13, docs/ui.md § Report): every
// statement ticked on its own, the whole limitations list scrolled through,
// and the signer's name, registration (body, category and field, as fixed
// choices; issue #47) and scope filled in. Pure, so the rules are tested
// without a browser.
import { registrationCategory, registrationCheck } from '@water-management/engine';

export interface SignoffFields {
	fullName: string;
	/** 'sacnasp' or 'ecsa' (engine liability/registration.ts). */
	registrationBody: string;
	/** '' until chosen. */
	registrationCategory: string;
	registrationField: string;
	registrationNo: string;
	scope: string;
}

/** The registration body most signers use (SACNASP, Water Resources Science); a choice. */
export const DEFAULT_REGISTRATION_BODY = 'sacnasp';

/** Any field of the body, to check a category on its own (a block doesn't depend on the field). */
const firstField = (body: string) => (body === 'ecsa' ? 'civil' : 'water_resources');

/**
 * What the chosen registration says: why it can't sign (a candidate,
 * certificated or specified category, or a stale choice of the other body),
 * or what the signer should weigh before signing. Nothing until both a
 * category and a field are chosen, except a blocked category, which says so
 * as soon as it is picked.
 */
export function registrationAdvice(f: Pick<SignoffFields, 'registrationBody' | 'registrationCategory' | 'registrationField'>): { block?: string; warnings: string[] } {
	const { registrationBody: body, registrationCategory: category, registrationField: field } = f;
	if (!category) return { warnings: [] };
	const c = registrationCategory(body, category);
	// Until a field is chosen, a category is checked against any field of its body.
	const r = registrationCheck(body, category, field || firstField(body));
	if (!c || r.invalid) return { block: r.invalid, warnings: [] };
	if (c.status === 'blocked') return r;
	return field ? r : { warnings: [] };
}

/** What still stops the sign-off, in words; empty when it can be submitted. */
export function signoffBlockers(fields: SignoffFields, confirmationIds: readonly string[], ticked: ReadonlySet<string>, readAll: boolean): string[] {
	const out: string[] = [];
	const unticked = confirmationIds.filter((id) => !ticked.has(id)).length;
	if (unticked) out.push(unticked === 1 ? 'Tick the last statement.' : `Tick each of the ${unticked} statements still open.`);
	if (!readAll) out.push('Scroll to the end of the known limitations.');
	const missing = [
		!fields.fullName.trim() && 'your full name',
		!fields.registrationBody.trim() && 'the registration body',
		!fields.registrationCategory && 'your registration category',
		!fields.registrationField && (fields.registrationBody === 'ecsa' ? 'your discipline' : 'your field of practice'),
		!fields.registrationNo.trim() && 'your registration number',
		!fields.scope.trim() && 'what the sign-off covers'
	].filter((x): x is string => !!x);
	if (missing.length) out.push(`Fill in ${missing.join(', ')}.`);
	const { block } = registrationAdvice(fields);
	if (block) out.push(block);
	return out;
}

/**
 * The list has been read to the end: its bottom is in view (within a couple
 * of pixels, for fractional zoom). A list short enough not to scroll counts
 * as read as soon as it is shown.
 */
export function scrolledToEnd(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
	return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
}

/** The first 12 hex digits of a hash: enough to compare by eye, with the full hash in its title. */
export const shortHash = (sha256: string) => sha256.slice(0, 12);

/** What a sign-off is of (WP-3.13 a run; WP-3.14 an evidence pack, issue #71). */
export type SignoffTarget = { kind: 'run'; id: string } | { kind: 'pack'; id: string };

/** The engines a statement is about, in words: one run's, or a pack's two runs' ("1.20.0", or "1.20.0 (baseline) and 1.21.0 (application)"). */
export function statementEngines(s: { engineVersion: string } | { baseline: { engineVersion: string }; application: { engineVersion: string } | null }): string {
	if ('engineVersion' in s) return s.engineVersion;
	if (!s.application || s.application.engineVersion === s.baseline.engineVersion) return s.baseline.engineVersion;
	return `${s.baseline.engineVersion} (baseline) and ${s.application.engineVersion} (application)`;
}

/**
 * What a pack's signer is told before signing: their name and registration
 * are printed on the pack and answered publicly by its verify page (GET
 * /verify/:code returns them to anyone holding the code, evidence-pack.md §
 * Verification).
 */
export const PACK_SIGNER_PUBLIC =
	'Your full name, your registration (body, category, field and number) and the date you sign are printed on the pack and shown publicly, to anyone holding its code, on its verify page. They stay there for as long as the pack exists, even if it is withdrawn.';

/**
 * What an in-app sign-off is, and isn't (licensing positions item 9, build
 * item 17; provisional position, pre-counsel research, 2026-10-01): ECTA
 * s13(1) asks for an advanced electronic signature wherever a law requires a
 * signature, so the app's sign-off doesn't stand in for one. Said in the
 * dialog and in Terms §3.
 */
export const SIGNOFF_NOT_A_SIGNATURE =
	'This sign-off is an electronic professional statement in this app. It is not your signature on any form or report the authority requires; sign those as the authority asks.';

/** Who signed a pack as what (167_signers), as the sign-off lists and the verify page print it. */
export const SIGNOFF_KIND_LABEL: Record<'specialist' | 'review', string> = {
	specialist: 'Specialist for the applicant',
	review: 'Reviewed for the responsible authority'
};

/** The registration line's heading: checked against the register by the host, or the signer's own declaration (167). */
export function registrationHeading(check: { checkedAt: string; checkedByOrg: string } | null, fmt: (iso: string) => string): string {
	return check ? `Registration (checked against the register by ${check.checkedByOrg}, ${fmt(check.checkedAt)})` : 'Registration (self-declared)';
}
