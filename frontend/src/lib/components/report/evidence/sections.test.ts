// The evidence report's fixed sections (issue #71, design §4, G6) and its
// check boards (board 1 lists every check, failures first; board 2 only the
// refusing ones).
import type { EvidenceCheck } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { boardChecks, evidenceSections, refusedChecks, sectionHeading } from './sections';

const none = { notAssessed: 'Not assessed', objects: [], bySource: [], demandM3Day: 0 };

describe('evidenceSections', () => {
	it('is the same fixed list for every application, whatever its data', () => {
		expect(evidenceSections({ mode: 'application', demandObjects: none }).map((s) => s.id)).toEqual([
			'summary',
			'river',
			'uncertainty',
			'credibility',
			'users',
			'allocations',
			'demandObjects',
			'appendixInputs',
			'appendixVerify',
			'applicantStatement'
		]);
	});

	it('an application’s pack drafted before evidence-9 has no § 6, and its sections are as they were', () => {
		expect(evidenceSections({ mode: 'application' }).map((s) => s.id)).toEqual([
			'summary',
			'river',
			'uncertainty',
			'credibility',
			'users',
			'allocations',
			'appendixInputs',
			'appendixVerify',
			'applicantStatement'
		]);
	});

	it('leaves out § 6 and the applicant’s statement for baseline evidence', () => {
		expect(evidenceSections({ mode: 'baseline', demandObjects: null }).map((s) => s.id)).toEqual(['summary', 'river', 'uncertainty', 'credibility', 'users', 'allocations', 'appendixInputs', 'appendixVerify']);
	});

	it('numbers the sections and letters the appendices', () => {
		expect(evidenceSections({ mode: 'application', demandObjects: none }).map(sectionHeading)).toEqual([
			'Summary',
			'1. The river',
			'2. Uncertainty',
			'3. Model and data',
			'4. Other users',
			'5. Registered water use',
			'6. The applicant’s demand objects',
			'Appendix A. Inputs and assumptions',
			'Appendix B. Limitations, sign-off and verification',
			'Appendix C. Applicant’s statement'
		]);
	});
});

describe('the check boards', () => {
	const check = (id: EvidenceCheck['id'], passed: boolean, refuses: boolean, blocksIssue: boolean): EvidenceCheck => ({ id, label: id, passed, detail: '', refuses, blocksIssue, fix: passed ? null : 'fix' });
	const checks = [check('nominated', true, true, true), check('coverage', false, false, false), check('declaredRule', false, false, true), check('engine', false, true, true)];

	it('board 2 lists only the failed refusing checks', () => {
		expect(refusedChecks({ checks }).map((c) => c.id)).toEqual(['engine']);
		expect(refusedChecks({ checks: [checks[0]!] })).toEqual([]);
	});

	it('board 1 lists every check: refusals, then issue blockers, then warnings, then passes', () => {
		expect(boardChecks({ checks }).map((c) => c.id)).toEqual(['engine', 'declaredRule', 'coverage', 'nominated']);
	});
});
