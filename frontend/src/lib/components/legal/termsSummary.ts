// The plain-language summary of the terms of use (docs/legal-status.md): the
// four main points a person agrees to, shown at the top of /terms as "The
// short version" (English, the binding language), above the sign-up button,
// and on the re-acceptance notice after the terms change (both translated for
// farmers; TermsSummary.svelte). One list, so the three never disagree.
// Changing a point is changing the terms: bump LEGAL_VERSION
// (packages/engine/src/legal.ts), and run the new words through the
// translation sheet.
//
// Plain msg() (no runes), so the prerendered /terms page renders the English
// without loading the i18n module.
import { msg } from '$lib/i18n/msg';

// i18n-section: terms-summary
export const SUMMARY_TITLE = msg('The main things you agree to');
export const SUMMARY_POINTS = [
	msg('Results are model estimates and can be wrong. Check them before you rely on them.'),
	msg(
		'As far as the law allows, we are not responsible for losses from decisions made on the results, and our total liability to you is limited to the fees you paid in the last 12 months or US $100, whichever is more (Terms §13).'
	),
	msg('If someone claims against us because of what you put in or how you used the service, you cover that claim (Terms §14).'),
	msg(
		'If you live or are based in South Africa, South African law and South African courts apply; otherwise, Virginia law and courts. Either way, your rights under the consumer and data-protection law where you live still apply (Terms §15).'
	)
];
/** Under the summary when it is shown in another language: only the English Terms bind (Terms §17). */
export const SUMMARY_LANGUAGE_NOTE = msg('The Terms are in English; this summary is in your language.');
