// The farm view's liability line, in English and Afrikaans, is quoted in the
// legal review pack (docs/legal/disclaimer-review.md § 3, issue #47), so the
// adviser reviews the words a farmer actually sees.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messageId } from '$lib/i18n/msg';
import { af } from '$lib/i18n/messages/af';
import { disclaimer } from './cards';

const PACK = readFileSync(new URL('../../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');

describe('farm view disclaimer in the legal review pack', () => {
	it('quotes the English and the Afrikaans', () => {
		const english = disclaimer();
		const afrikaans = af[messageId(english)];
		expect(typeof afrikaans).toBe('string');
		expect(PACK).toContain(`> ${english}\n`);
		expect(PACK).toContain(`> ${afrikaans as string}\n`);
	});
});
