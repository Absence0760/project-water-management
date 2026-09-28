// The alert emails' liability lines, in English and Afrikaans, are quoted in
// the legal review pack (docs/legal/disclaimer-review.md § 3, issue #47), so
// the adviser reviews the words a farmer actually gets.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { af } from './af.js';
import { en } from './en.js';

const PACK = readFileSync(new URL('../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');

describe('alert email liability lines in the legal review pack', () => {
	it.each(['mail.alert.model', 'mail.alert.model.dam.staff', 'mail.alert.model.staff', 'mail.alert.restriction.wua'] as const)('quotes %s in English and Afrikaans', (key) => {
		expect(PACK).toContain(`\`${key}\``);
		expect(PACK).toContain(`> ${en[key]}\n`);
		expect(af[key], key).toBeTruthy();
		expect(PACK).toContain(`> ${af[key]}\n`);
	});
});
