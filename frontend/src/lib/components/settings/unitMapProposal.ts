// Settings → Rain for each unit → "MAP from the grid" (issue #482 follow-up;
// docs/ui.md § Settings, docs/maps.md § MAP for each unit): each land unit's
// area-weighted MAP from one MAP grid, beside what its form holds. One grid
// for the whole project, never a mix; a unit the grid doesn't cover is listed,
// not filled from another grid.
import type { UnitMapApplied, UnitMapCandidate, UnitMapProposal } from '$lib/api';
import { fmtNum } from '$lib/format/number';

/** What the panel can show: why there is nothing to use, or the rows. */
export type UnitMapView =
	| { kind: 'no-dataset' }
	| { kind: 'no-units' }
	| { kind: 'none-covered' }
	| { kind: 'ready' };

export function unitMapView(p: UnitMapProposal): UnitMapView {
	if (!p.candidates.length) return { kind: 'no-dataset' };
	if (!p.units.length && !p.uncovered.length) return { kind: 'no-units' };
	if (!p.dataset || !p.units.length) return { kind: 'none-covered' };
	return { kind: 'ready' };
}

const units = (n: number) => (n === 1 ? '1 unit' : `${fmtNum(n)} units`);

/** A grid's cell size in words: "0.01° cells". */
export const cellText = (cellDeg: number) => `${fmtNum(cellDeg, 4, true)}° cells`;

/** How much of the project the proposed grid covers, in a sentence. */
export function coverageLine(p: UnitMapProposal): string {
	if (!p.dataset) return '';
	const placed = p.units.length + p.uncovered.length;
	const grid = `${p.dataset.label} (${cellText(p.dataset.cellDeg)})`;
	if (p.coversAll) return `${grid} covers ${placed === 1 ? 'the unit' : `all ${units(placed)}`} with a parcel on the map.`;
	return `${grid} covers ${fmtNum(p.units.length)} of the ${units(placed)} with a parcel on the map; the rest keep what they have.`;
}

/** A grid in the picker: its label, cell size and how many units it covers. */
export const candidateLabel = (c: UnitMapCandidate, placed: number) =>
	`${c.label} (${cellText(c.cellDeg)}, ${c.version}): covers ${fmtNum(c.covered)} of ${fmtNum(placed)}`;

/** The units whose MAP would change (the rest hold this MAP from this grid already). */
export const toChange = (p: UnitMapProposal) => p.units.filter((u) => !u.same);

/** The share of a parcel with values, as a percentage. */
export const pctText = (share: number) => `${fmtNum(Math.floor(share * 1000) / 10, 1, true)} %`;

/** What the unit's form holds now, in a cell. */
export function currentText(u: UnitMapProposal['units'][number]): string {
	if (u.current.mapMm === null) return 'None';
	return `${fmtNum(u.current.mapMm)} mm`;
}

/** The confirmation before Use. */
export function useMessage(p: UnitMapProposal): string {
	const n = toChange(p).length;
	const d = p.dataset!;
	const left = p.uncovered.length + p.withoutPolygon.length + p.refused.length;
	return [
		`${units(n)} ${n === 1 ? 'gets its' : 'get their'} MAP and source from ${d.label} ${d.version}, replacing what ${n === 1 ? 'its form holds' : 'their forms hold'}, saved straight to the model as one change in History.`,
		left ? `${units(left)} without a MAP from this grid keep${left === 1 ? 's' : ''} what ${left === 1 ? 'it has' : 'they have'}.` : '',
		'The MAP sets the level of each unit’s rain while Rain for each unit is on: run and refit afterwards.'
	]
		.filter(Boolean)
		.join(' ');
}

/** What Use did, for the live notice. */
export const appliedNotice = (a: UnitMapApplied, label: string) =>
	a.changed
		? `${units(a.changed)} now ${a.changed === 1 ? 'has its' : 'have their'} MAP from ${label}, saved as one model change (History).`
		: `Every unit already had its MAP from ${label}: nothing changed.`;
