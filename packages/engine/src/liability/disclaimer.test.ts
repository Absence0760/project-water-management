// The disclaimer's draft/agreed state, and the legal review pack
// (docs/legal/disclaimer-review.md, issue #47) quoting the current wording:
// a changed word fails here until the pack sent to the adviser says it too.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CSV_DISCLAIMER_COMMENT,
	DISCLAIMER,
	FORECAST_RAIN_NOTE,
	REPORT_FOOTER,
	REPORT_NOT_EVIDENCE,
	REPORT_NOT_SIGNED,
	REPORT_READ_FIRST,
	REPORT_SIGNED_BY,
	withSite
} from './disclaimer';
import { SIGNOFF_STATEMENT_VERSION, signoffStatement } from './signoff';

const PACK = readFileSync(new URL('../../../../docs/legal/disclaimer-review.md', import.meta.url), 'utf8');

describe('DISCLAIMER', () => {
	it('carries a draft- version exactly while its status is draft', () => {
		// Flipping to agreed without a new version (or the reverse) would let
		// a sign-off record a draft version for agreed words.
		expect(DISCLAIMER.version.startsWith('draft-')).toBe(DISCLAIMER.status === 'draft');
	});
});

describe('the cover, footer and export lines', () => {
	it('fills in the site address, so the Terms URL prints in full', () => {
		expect(withSite(DISCLAIMER.paragraphs[4]!, 'https://water.example.com/')).toMatch(/Terms of use: https:\/\/water\.example\.com\/terms\.$/);
		expect(DISCLAIMER.paragraphs.every((p, i) => i === 4 || !p.includes('{site}'))).toBe(true);
	});

	it('names the Disclaimer section, and every signer on the cover (a body code by its short name, an older free-text body as typed)', () => {
		expect(REPORT_READ_FIRST(12)).toContain('(see the Disclaimer, section 12)');
		expect(REPORT_SIGNED_BY([{ fullName: 'A Person', registrationBody: 'ecsa', registrationNo: '123' }, { fullName: 'B Person', registrationBody: 'SACNASP', registrationNo: '9' }])).toBe(
			'Signed off by A Person (ECSA 123); B Person (SACNASP 9).'
		);
		expect(REPORT_FOOTER('Twee', 'Run 1', 12)).toBe(
			`Twee · Run 1 · Model estimates; see the Disclaimer (section 12, version ${DISCLAIMER.version}). The operator of this software accepts no responsibility to anyone who relies on this report.`
		);
	});

	it('keeps the CSV comment one harmless text cell: no comma, quote or =', () => {
		expect(CSV_DISCLAIMER_COMMENT.startsWith('# ')).toBe(true);
		expect(CSV_DISCLAIMER_COMMENT).not.toMatch(/[,"=\r\n]/);
		expect(CSV_DISCLAIMER_COMMENT).toContain(DISCLAIMER.version);
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

	it('quotes the report cover box, its sign-off lines, the PDF footer and the CSV line', () => {
		for (const line of [REPORT_READ_FIRST('{n}'), REPORT_SIGNED_BY([{ fullName: '{name}', registrationBody: '{body}', registrationNo: '{number}' }]), REPORT_NOT_SIGNED, REPORT_NOT_EVIDENCE, REPORT_FOOTER('{project}', '{run}', '{n}'), CSV_DISCLAIMER_COMMENT])
			expect(PACK).toContain(`> ${line}\n`);
	});

	it('quotes every sign-off confirmation (both works variants) and note, and the statement version', () => {
		const baseline = signoffStatement({ id: 'r', engineVersion: 'e', scenario: false });
		const scenario = signoffStatement({ id: 'r', engineVersion: 'e', scenario: true });
		for (const c of [...baseline.confirmations, ...scenario.confirmations]) expect(PACK, c.id).toContain(`${c.text}\n`);
		for (const n of baseline.notes) expect(PACK).toContain(`> - ${n}\n`);
		expect(PACK).toContain(`Version \`${SIGNOFF_STATEMENT_VERSION}\``);
	});
});
