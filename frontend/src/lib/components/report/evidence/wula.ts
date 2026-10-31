// The WULA reference as the evidence report prints it (evidence-26,
// 294_wula_reference; docs/evidence-pack.md § The WULA reference): page 1's
// lines (the number, the works' refs, how the changes meet them; never the
// works in words, which are the applicant's and A.2's, G13) and A.2's word on
// each change. Pure, so the wording is tested without the components.
import type { EvidenceWula, OpClass } from '@water-management/engine';

/** Page 1's WULA lines. */
export function wulaPage1(w: EvidenceWula): { number: string | null; works: string; tie: string[] } {
	const n = w.refs.length;
	const works = n ? `${n} works applied for: ${w.refs.join(', ')}` : 'No works listed';
	const tie: string[] = [];
	const untied = w.untiedProposals.length;
	if (untied) tie.push(`${untied} ${untied === 1 ? 'proposal models' : 'proposals model'} none of the works applied for (A.2)`);
	if (w.unmodelled.length) tie.push(`No change models ${w.unmodelled.join(', ')} (A.2)`);
	if (n && !tie.length) tie.push('Every proposal models works applied for, and every works is modelled');
	return { number: w.number, works, tie };
}

/**
 * A.2's word on change `index` against the WULA, and whether it ties the change to listed works
 * (null: nothing to say, as for a baseline assumption naming no works).
 */
export function opWorksText(w: EvidenceWula, index: number, works: string | undefined, cls: OpClass): { text: string; tied: boolean } | null {
	if (works !== undefined && w.refs.includes(works)) return { text: `Models ${works}`, tied: true };
	if (works !== undefined) return { text: `Names “${works}”, which the WULA doesn’t list`, tied: false };
	return cls === 'proposal' || w.untiedProposals.includes(index) ? { text: 'Models none of the works applied for', tied: false } : null;
}
