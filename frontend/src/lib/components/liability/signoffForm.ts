// The sign-off dialog's rules (WP-3.13, docs/ui.md § Report): every
// statement ticked on its own, the whole limitations list scrolled through,
// and the signer's name, registration and scope filled in. Pure, so the rules
// are tested without a browser.

export interface SignoffFields {
	fullName: string;
	registrationBody: string;
	registrationNo: string;
	scope: string;
}

/** The registration body most signers use (SACNASP, Water Resources Science); editable. */
export const DEFAULT_REGISTRATION_BODY = 'SACNASP';

/** What still stops the sign-off, in words; empty when it can be submitted. */
export function signoffBlockers(fields: SignoffFields, confirmationIds: readonly string[], ticked: ReadonlySet<string>, readAll: boolean): string[] {
	const out: string[] = [];
	const unticked = confirmationIds.filter((id) => !ticked.has(id)).length;
	if (unticked) out.push(unticked === 1 ? 'Tick the last statement.' : `Tick each of the ${unticked} statements still open.`);
	if (!readAll) out.push('Scroll to the end of the known limitations.');
	const missing = [
		!fields.fullName.trim() && 'your full name',
		!fields.registrationBody.trim() && 'the registration body',
		!fields.registrationNo.trim() && 'your registration number',
		!fields.scope.trim() && 'what the sign-off covers'
	].filter((x): x is string => !!x);
	if (missing.length) out.push(`Fill in ${missing.join(', ')}.`);
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
