// Settings → Flow calibration → "Evaporation from the map" (issue #326
// B-evap; docs/ui.md § Settings, docs/maps.md § Evaporation from the map):
// the catchment boundary's monthly evaporation from a grid, beside what the
// saved settings hold. What it goes into is the dataset's kind and nothing is
// converted: reference ET (FAO-56 ET₀) becomes GR4J's monthly PE, A-pan the
// A-pan row. For reference ET the panel also shows ET₀ ÷ A-pan per month, the
// pan coefficient the two rows imply, as a cross-check only.
import type { EvaporationAccepted, EvaporationProposals, EvaporationTarget } from '$lib/api';
import { fmtDate, fmtNum } from '$lib/format/number';

/** Where an accepted row goes, in words. */
export const TARGET_LABEL: Record<EvaporationTarget, string> = {
	pe: 'GR4J’s monthly PE',
	apan: 'the A-pan evaporation row'
};

/** What the panel can show: why there is nothing to use, or the rows. */
export type ProposalState =
	| { kind: 'no-dataset' }
	| { kind: 'no-boundary' }
	| { kind: 'problem'; problem: string }
	| { kind: 'ready'; target: EvaporationTarget; proposed: number[]; annualMm: number; coverage: number; cells: number };

export function proposalState(p: EvaporationProposals): ProposalState {
	if (!p.dataset || !p.target) return { kind: 'no-dataset' };
	if (!p.boundary || !p.proposal) return { kind: 'no-boundary' };
	if ('problem' in p.proposal) return { kind: 'problem', problem: p.proposal.problem };
	return { kind: 'ready', target: p.target, proposed: p.proposal.monthlyMm, annualMm: p.proposal.annualMm, coverage: p.proposal.coverage, cells: p.proposal.cells };
}

/** The saved row the proposal would replace: the A-pan row, or the monthly PE row (null under pan coefficient × A-pan). */
export const savedRow = (p: EvaporationProposals, target: EvaporationTarget): number[] | null => (target === 'apan' ? p.settings.apanMm : p.settings.peMm);

/** The proposal is what the settings hold already (to 0.05 mm a month). */
export const sameAsSaved = (saved: readonly number[] | null, proposed: readonly number[]) =>
	!!saved && saved.length === 12 && saved.every((v, i) => Math.abs(v - proposed[i]!) < 0.05);

/** ET₀ ÷ A-pan per month, to 2 decimals; null where the A-pan row is 0. */
export const impliedPanCoefficient = (et0: readonly number[], apan: readonly number[]): (number | null)[] =>
	et0.map((v, i) => (apan[i]! > 0 ? Math.round((v / apan[i]!) * 100) / 100 : null));

/** The FAO-56 Table 5 Class A range the Settings warning uses (engine PAN_COEFFICIENT_TYPICAL_MIN/MAX). */
export const outsidePanRange = (k: readonly (number | null)[], min: number, max: number): number[] =>
	k.flatMap((v, i) => (v !== null && (v < min || v > max) ? [i] : []));

/** The coverage and cell count, in a phrase. */
export const coverageText = (coverage: number, cells: number) => `${cells} grid cell${cells === 1 ? '' : 's'}; ${fmtNum(Math.round(coverage * 100))} % of the boundary has values`;

/** Where an accepted row came from, in a line. */
export function acceptedText(a: EvaporationAccepted): string {
	const what = TARGET_LABEL[a.target];
	const when = fmtDate(a.acceptedAt);
	return a.current
		? `${what[0]!.toUpperCase()}${what.slice(1)} came from the map (${a.dataset}, ${a.version}) on ${when}.`
		: `Typed over since: ${what} came from the map (${a.dataset}, ${a.version}) on ${when}.`;
}
