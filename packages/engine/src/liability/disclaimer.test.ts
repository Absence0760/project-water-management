// The disclaimer's draft/agreed state, and the legal review pack
// (docs/legal/disclaimer-review.md, issue #47) quoting the current wording:
// a changed word fails here until the pack sent to the adviser says it too.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISCLAIMER, FORECAST_RAIN_NOTE } from './disclaimer';
import { SIGNOFF_STATEMENT_VERSION, signoffStatement } from './signoff';

const PACK = readFileSync(new URL('../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');

describe('DISCLAIMER', () => {
	it('carries a draft- version exactly while its status is draft', () => {
		// Flipping to agreed without a new version (or the reverse) would let
		// a sign-off record a draft version for agreed words.
		expect(DISCLAIMER.version.startsWith('draft-')).toBe(DISCLAIMER.status === 'draft');
	});
});

describe('FORECAST_RAIN_NOTE', () => {
	it('credits CHIRPS-GEFS, with its citation, only for a CHIRPS-GEFS forecast', () => {
		expect(FORECAST_RAIN_NOTE('2026-09-29', 'chirps_gefs')).toBe(
			'From 2026-09-29, this run uses forecast rain (CHIRPS-GEFS, Climate Hazards Center, doi:10.15780/G2PH2M), not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.'
		);
	});

	it('names no product for any other or unknown source (an uploaded forecast)', () => {
		const plain =
			'From 2026-09-29, this run uses forecast rain, not recorded rain. Rain forecasts are often wrong, more so further ahead, and each new forecast replaces the last.';
		expect(FORECAST_RAIN_NOTE('2026-09-29', 'other')).toBe(plain);
		expect(FORECAST_RAIN_NOTE('2026-09-29', null)).toBe(plain);
		expect(FORECAST_RAIN_NOTE('2026-09-29')).toBe(plain);
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
