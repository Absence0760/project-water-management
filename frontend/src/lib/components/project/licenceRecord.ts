// The Project page's Licence record panel (161_licence_record, docs/ui.md
// § Project): what the record's dates say, in words, and the owner's form
// turned into the API's body. Provisional position (pre-counsel research,
// 2026-10-01): the names an issued pack or a sign-off keeps are kept until
// three years after the licence expires, or three years after any other
// outcome; until the outcome is recorded, an owner confirms every five years
// that the record is still needed. The outcomes are the authority's words
// (D14, as an application's decision records them) and the applicant's
// withdrawal (233_licence_record_outcome_words, issue #523 G9 (b)).
import type { LicenceOutcome, LicenceOutcomeInput, LicenceRecord } from '#lib/api/index.js';
import { fmtDay } from '#lib/format/number.js';

export const OUTCOME_LABEL: Record<LicenceOutcome, string> = {
	licence_issued: 'Licence issued',
	licence_refused: 'Licence refused',
	application_rejected: 'Application rejected (formal requirements)',
	not_considered: 'Not considered: use already authorised',
	application_withdrawn: 'Application withdrawn'
};

/** One sentence on where the record stands, as of `today` (YYYY-MM-DD), its days day first ("1 Mar 2026", issue #586). */
export function recordStatus(r: LicenceRecord, today: string): { text: string; due: boolean } {
	if (r.outcome) {
		const what =
			r.outcome === 'licence_issued'
				? `Licence issued on ${fmtDay(r.outcomeOn ?? '')}; it expires on ${fmtDay(r.expiresOn ?? '')}.`
				: `${OUTCOME_LABEL[r.outcome] ?? r.outcome} on ${fmtDay(r.outcomeOn ?? '')}.`;
		const closes = r.closesOn ?? '';
		const due = closes !== '' && closes <= today;
		return {
			text: `${what} ${due ? `The record could be deleted from ${fmtDay(closes)}: ask the operator, in writing, when the organisation no longer needs it.` : `The record is kept until ${fmtDay(closes)}.`}`,
			due
		};
	}
	if (!r.reviewDueOn) return { text: 'No evidence pack is issued and no run is nominated yet, so there is no licence record to keep.', due: false };
	const due = r.reviewDueOn <= today;
	return {
		text: due
			? `The review was due on ${fmtDay(r.reviewDueOn)}: record the licence outcome, or confirm that the record is still needed.`
			: `No outcome is recorded. Next review: ${fmtDay(r.reviewDueOn)}.`,
		due
	};
}

export interface OutcomeForm {
	outcome: LicenceOutcome | '';
	outcomeOn: string;
	expiresOn: string;
	reason: string;
}

export const formOf = (r: LicenceRecord): OutcomeForm => ({ outcome: r.outcome ?? '', outcomeOn: r.outcomeOn ?? '', expiresOn: r.expiresOn ?? '', reason: '' });

/** What is missing before Save, or null; the server checks it again. */
export function formProblem(f: OutcomeForm): string | null {
	if (!f.reason.trim()) return 'Say why: the decision letter or its reference.';
	if (f.outcome === '') return null;
	if (!f.outcomeOn) return 'Give the date of the decision.';
	if (f.outcome === 'licence_issued') {
		if (!f.expiresOn) return 'Give the date the licence expires.';
		if (f.expiresOn < f.outcomeOn) return 'The licence expires before it was issued.';
	}
	return null;
}

export function outcomeBody(f: OutcomeForm): LicenceOutcomeInput {
	const reason = f.reason.trim();
	if (f.outcome === '') return { outcome: null, reason };
	if (f.outcome === 'licence_issued') return { outcome: 'licence_issued', outcomeOn: f.outcomeOn, expiresOn: f.expiresOn, reason };
	return { outcome: f.outcome, outcomeOn: f.outcomeOn, reason };
}
