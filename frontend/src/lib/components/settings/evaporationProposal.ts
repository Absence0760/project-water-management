// Settings → Flow calibration → "Evaporation from the map" (issue #326
// B-evap; docs/ui.md § Settings, docs/maps.md § Evaporation from the map):
// the catchment boundary's monthly evaporation from a grid, beside what the
// saved settings hold. What it goes into is the dataset's kind and nothing is
// converted: reference ET (FAO-56 ET₀) becomes GR4J's monthly PE, A-pan the
// A-pan row. For reference ET the panel also shows ET₀ ÷ A-pan per month, the
// pan coefficient the two rows imply, as a cross-check only.
import type { EvaporationAccepted, EvaporationProposals, EvaporationTarget } from '$lib/api';
import { fmtDate, fmtDay, fmtNum } from '$lib/format/number';

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

/**
 * The confirmation before an accept: what reads the 12 values, and what a
 * daily A-pan record still drives (persona-hydrologist, round 4). A daily
 * record replaces the monthly A-pan row on every day it covers, so an A-pan
 * accept changes only the days outside it; a monthly PE row replaces the
 * A-pan for GR4J altogether, the daily record too (engine runoff/simulate.ts).
 */
export function useMessage(target: EvaporationTarget, annualMm: number, settings: EvaporationProposals['settings']): string {
	const daily = settings.dailyApan ?? null;
	const span = daily ? `${fmtDay(daily.from)} to ${fmtDay(daily.to)}` : '';
	if (target === 'pe') {
		const head = `GR4J will run on these 12 monthly values (${fmtNum(annualMm)} mm a year of reference evapotranspiration) instead of ${settings.peKind === 'monthly' ? 'the monthly PE row it holds now' : 'pan coefficient × A-pan'}.`;
		const keep =
			daily && settings.peKind !== 'monthly'
				? `Irrigation demand and dam evaporation keep reading the A-pan row and the daily A-pan record (${span}); GR4J stops reading both.`
				: 'Irrigation demand and dam evaporation keep reading the A-pan row.';
		return `${head} ${keep} A GR4J fit made before is then marked “Forcing changed since fit”.`;
	}
	const base = `Irrigation demand, dam evaporation and, under pan coefficient × A-pan, GR4J will read these 12 monthly values (${fmtNum(annualMm)} mm a year) instead of the A-pan row it holds now.`;
	return daily ? `${base} The daily A-pan record (${span}) still replaces them on every day it covers, so only the days outside it change.` : base;
}
