// The disclaimer's draft/agreed state, and the legal review pack
// (docs/legal/disclaimer-review.md, issue #47) quoting the current wording:
// a changed word fails here until the pack sent to the adviser says it too.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER } from './disclaimer';
import { SIGNOFF_STATEMENT_VERSION, signoffStatement } from './signoff';

const PACK = readFileSync(new URL('../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');

describe('DISCLAIMER', () => {
	it('carries a draft- version exactly while its status is draft', () => {
		// Flipping to agreed without a new version (or the reverse) would let
		// a sign-off record a draft version for agreed words.
		expect(DISCLAIMER.version.startsWith('draft-')).toBe(DISCLAIMER.status === 'draft');
	});
});

describe('the legal review pack (docs/legal/disclaimer-review.md)', () => {
	it('quotes every disclaimer paragraph, its version and status', () => {
		DISCLAIMER.paragraphs.forEach((p, i) => expect(PACK, `paragraph ${i + 1}`).toContain(`> ${i + 1}. ${p}\n`));
		expect(PACK).toContain(`Version \`${DISCLAIMER.version}\`, status \`${DISCLAIMER.status}\``);
	});

	it('quotes every sign-off confirmation (both works variants) and note, and the statement version', () => {
		const baseline = signoffStatement({ id: 'r', engineVersion: 'e', scenario: false });
		const scenario = signoffStatement({ id: 'r', engineVersion: 'e', scenario: true });
		for (const c of [...baseline.confirmations, ...scenario.confirmations]) expect(PACK, c.id).toContain(`${c.text}\n`);
		for (const n of baseline.notes) expect(PACK).toContain(`> - ${n}\n`);
		expect(PACK).toContain(`Version \`${SIGNOFF_STATEMENT_VERSION}\``);
	});
});
