// The mitigation alternatives as the evidence report prints them (evidence-26,
// 298_scenario_alternatives; docs/evidence-pack.md § Mitigation alternatives):
// page 1's column per alternative (its value and its change against the
// baseline, or why it isn't assessed) and A.2's heading per alternative. Pure,
// so the wording is tested without the components.
import type { EvidenceAlternative, EvidenceAlternativeCell, EvidenceRow } from '@water-management/engine';
import { changeText, valueText } from './format';

/** One page-1 cell under an alternative: the value, its change (as the application's Change cell words it), or why not. */
export function alternativeCellText(
	row: Pick<EvidenceRow, 'unit' | 'id'>,
	cell: EvidenceAlternativeCell | null | undefined
): { value: string; change: string | null; sub: string | null; notAssessed: string | null; note: string | null } {
	if (!cell) return { value: '–', change: null, sub: null, notAssessed: 'Not in this report', note: null };
	if (cell.notAssessed) return { value: '–', change: null, sub: null, notAssessed: cell.notAssessed, note: cell.note };
	const c = cell.change ? changeText(row, cell.change) : null;
	return { value: valueText(row, cell.value), change: c?.main ?? null, sub: c?.sub ?? null, notAssessed: null, note: cell.note };
}

/** A column's heading: the applicant's label, and which of the applicant's scenarios it is. */
export const alternativeHeading = (a: Pick<EvidenceAlternative, 'label' | 'scenarioName'>, i: number) => ({ label: a.label, sub: `Alternative ${i + 1}: “${a.scenarioName}”` });

/** A.2's line about an alternative: its run, its engine and its ops' count by class. */
export function alternativeLine(a: Pick<EvidenceAlternative, 'runId' | 'runLabel' | 'engineVersion' | 'proposals' | 'assumptions' | 'scenarioName'>): string {
	const run = a.runLabel ? `run “${a.runLabel}”` : `run ${a.runId.slice(0, 8)}`;
	const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
	return `“${a.scenarioName}”, ${run}, engine ${a.engineVersion}: ${plural(a.proposals, 'proposal')}, ${plural(a.assumptions, 'baseline assumption')}`;
}
