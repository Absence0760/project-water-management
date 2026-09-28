// "Before you look at your farm" (farmNotice.ts): quoted in the legal pack
// (docs/legal/disclaimer-review.md § 3) in English and Afrikaans with its
// version, and bound to that version: changing its words, or the estimate
// line, without bumping FARMER_NOTICE_VERSION fails here, so an "I
// understand" on record always names the words the farmer saw.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FARMER_NOTICE_VERSION } from '@water-management/engine/legal';
import { messageId } from '$lib/i18n/msg';
import { af } from '$lib/i18n/messages/af';
import { disclaimer } from './cards';
import { farmNoticeButton, farmNoticeEnglish, farmNoticePoints, farmNoticeTitle } from './farmNotice';

const PACK = readFileSync(new URL('../../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');
const TERMS = readFileSync(new URL('../../../routes/terms/+page.svelte', import.meta.url), 'utf8');

/** The English each version was agreed with (sha256, first 16 hex). A new version adds a line; never edit one. */
const BOUND: Record<string, string> = {
	'2026-09-28': '61a1137ee48acc3e'
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const afOf = (english: string) => af[messageId(english)] as string;

describe('the farm notice', () => {
	it('is bound to FARMER_NOTICE_VERSION: new words need a new version', () => {
		expect(hash(farmNoticeEnglish(disclaimer())), `bump FARMER_NOTICE_VERSION and add it to BOUND`).toBe(BOUND[FARMER_NOTICE_VERSION]);
	});

	it('is quoted in the legal pack with its version, in English and Afrikaans', () => {
		expect(PACK).toContain(`version \`${FARMER_NOTICE_VERSION}\``);
		expect(PACK).toContain(`> ${farmNoticeTitle()}\n`);
		expect(PACK).toContain(`> [${farmNoticeButton()}]\n`);
		for (const point of farmNoticePoints()) expect(PACK).toContain(`> - ${point}\n`);
		expect(PACK).toContain(`> ${afOf(farmNoticeTitle())}\n`);
		expect(PACK).toContain(`> [${afOf(farmNoticeButton())}]\n`);
		for (const point of farmNoticePoints()) {
			expect(typeof afOf(point)).toBe('string');
			expect(PACK).toContain(`> - ${afOf(point)}\n`);
		}
	});

	it('points to section 13 of the Terms, which is still the liability section', () => {
		expect(farmNoticePoints().at(-1)).toMatch(/See the \{terms\}, section 13\.$/);
		expect(TERMS).toMatch(/<h2 id="liability">13\. Limitation of liability<\/h2>/);
	});
});
