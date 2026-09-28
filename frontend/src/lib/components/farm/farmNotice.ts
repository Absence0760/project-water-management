// "Before you look at your farm" (issue #47; the CPA s49 research's R2): a
// notice every farm page shows instead of the figures until the account has
// pressed "I understand" on the version in force (FARMER_NOTICE_VERSION,
// app_user.farm_notice_version, 093). Quoted in docs/legal/disclaimer-review.md
// § 3. Changing any of these words, or the estimate line (cards.ts
// `disclaimer()`), means bumping FARMER_NOTICE_VERSION (farmNotice.test.ts).
import { t } from '$lib/i18n/locale.svelte';

// i18n-section: farm.ack
export const farmNoticeTitle = () => t('Before you look at your farm');

/** The four points, in order. The last ends "See the {terms}, section 13."; the page makes {terms} a link. */
export const farmNoticePoints = () => [
	t('The figures here come from a computer model of the catchment, run for your WUA. Nobody measures your dam or your water use for this app.'),
	t('They are estimates, and they can be wrong. Check your dam and your water yourself before you act on them.'),
	t('Only a notice from your WUA or from the Department of Water and Sanitation (DWS) is a restriction. Nothing else on these pages is.'),
	t('The people who run this app don’t check the WUA’s figures and, as far as the law allows, accept no responsibility for losses from relying on them. See the {terms}, section 13.')
];

export const farmNoticeButton = () => t('I understand');

/** Everything the notice and the estimate line say, in English: what FARMER_NOTICE_VERSION is bound to. */
export const farmNoticeEnglish = (disclaimer: string) => [farmNoticeTitle(), ...farmNoticePoints(), farmNoticeButton(), disclaimer].join('\n');
