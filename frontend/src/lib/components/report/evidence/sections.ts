// The evidence report's fixed section list (issue #71, docs/design/evidence-report.md
// §4, G6): page 1, the numbered sections in the order an assessor's questions
// come, then the lettered appendices. Fixed, so a section can't be left out
// because it looks bad; a section with nothing to show prints "Not assessed"
// inside it instead (rule 3). Only Appendix C, the applicant's own words,
// depends on the mode: a baseline-evidence report has no applicant.
import type { EvidenceReport } from '@water-management/engine';

export type EvidenceSectionId = 'summary' | 'river' | 'uncertainty' | 'credibility' | 'users' | 'allocations' | 'appendixInputs' | 'appendixVerify' | 'applicantStatement';

export interface EvidenceSection {
	id: EvidenceSectionId;
	/** "1", "2" … for the sections, "A", "B", "C" for the appendices, "" for page 1. */
	number: string;
	/** "Section" or "Appendix", or "" for page 1. */
	kind: string;
	title: string;
}

export function evidenceSections(r: Pick<EvidenceReport, 'mode'>): EvidenceSection[] {
	const app = r.mode === 'application';
	const out: EvidenceSection[] = [
		{ id: 'summary', number: '', kind: '', title: 'Summary' },
		{ id: 'river', number: '1', kind: 'Section', title: 'The river' },
		{ id: 'uncertainty', number: '2', kind: 'Section', title: 'Uncertainty' },
		{ id: 'credibility', number: '3', kind: 'Section', title: 'Model and data' },
		{ id: 'users', number: '4', kind: 'Section', title: app ? 'Other users' : 'Every user’s supply' },
		// WP-3.10: modelled use against the registered volumes (WARMS registrations, licences); "Not assessed" when the runs carry none.
		{ id: 'allocations', number: '5', kind: 'Section', title: 'Registered water use' },
		{ id: 'appendixInputs', number: 'A', kind: 'Appendix', title: 'Inputs and assumptions' },
		{ id: 'appendixVerify', number: 'B', kind: 'Appendix', title: 'Limitations, sign-off and verification' }
	];
	if (app) out.push({ id: 'applicantStatement', number: 'C', kind: 'Appendix', title: 'Applicant’s statement' });
	return out;
}

/** A section's heading as printed: "1. The river", "Appendix A. Inputs and assumptions", "Summary". */
export const sectionHeading = (s: EvidenceSection) => (!s.number ? s.title : s.kind === 'Appendix' ? `Appendix ${s.number}. ${s.title}` : `${s.number}. ${s.title}`);

/** Where a report is refused, the page shows only the refusal board: which checks failed and the way out (board 2). */
export const refusedChecks = (r: Pick<EvidenceReport, 'checks'>) => r.checks.filter((c) => c.refuses && !c.passed);

/** The checks the preview bar lists (board 1): every one, failures first, then those that block issue. */
export function boardChecks(r: Pick<EvidenceReport, 'checks'>) {
	const rank = (c: EvidenceReport['checks'][number]) => (c.passed ? 3 : c.refuses ? 0 : c.blocksIssue ? 1 : 2);
	return r.checks.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
}

/** Every page's stamp until a pack issues the report (G12). */
export const DRAFT_STAMP = 'Draft · not issued';
