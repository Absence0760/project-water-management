// A unit's "Source of the MAP" choice on its form (docs/ui.md § Network,
// docs/maps.md § MAP for each unit): a loaded MAP grid (the WAAS 2007 MAP or
// the CCWR MAP) or typed by hand. A grid's MAP comes from the MAP for each
// unit proposal for that grid and is written by its apply (GET/POST
// …/map/unit-map), exactly as Settings → Flow generation → MAP from the grid
// writes it. One grid for the whole project, never a mix: picking a grid while
// other units hold another grid's MAP switches them too, after asking, and a
// grid that can't take every such unit over can't be picked.
import { unitMapGridCitation, unitMapGridOfSource, type NetworkNode } from '@water-management/engine';
import type { UnitMapApplied, UnitMapCandidate, UnitMapProposal, UnitRef } from '#lib/api/index.js';
import { MAP_GRID_NAMES, mapGridName } from '#lib/components/map/mapGridNames.js';
import { coveredText, pctText } from '#lib/components/settings/unitMapProposal.js';
import { fmtNum } from '#lib/format/number.js';

/** Where a unit's MAP comes from, read from its source line: a grid (its dataset label and the citation the line names), or typed by hand. */
export type MapChoice = { kind: 'grid'; label: string; citation: string } | { kind: 'typed' };

/** Every grid label a source line may name: the named grids and the loaded ones. */
export const gridLabels = (candidates: readonly Pick<UnitMapCandidate, 'label'>[]): string[] => [
	...Object.keys(MAP_GRID_NAMES),
	...candidates.map((c) => c.label).filter((l) => !(l in MAP_GRID_NAMES))
];

/**
 * The choice a MAP source line stands for. A grid's line is recognised as the
 * backend's one-grid rule recognises it (the engine's unitMapGridOfSource);
 * its label is the known label the citation starts with (the longest, so one
 * label that begins another can't take its lines), else the whole citation (a
 * grid no longer loaded). Anything else is typed by hand.
 */
export function choiceOf(source: string | null | undefined, labels: readonly string[]): MapChoice {
	const citation = unitMapGridOfSource(source);
	if (citation === null) return { kind: 'typed' };
	const label = [...labels].sort((a, b) => b.length - a.length).find((l) => citation.startsWith(`${l} `)) ?? citation;
	return { kind: 'grid', label, citation };
}

/** One grid's proposal as the form read it: still reading, read, or why it couldn't be. */
export type GridLoad = { kind: 'reading' } | { kind: 'read'; proposal: UnitMapProposal } | { kind: 'error'; message: string };

/** A grid in the choice, for one unit. */
export interface GridOption {
	label: string;
	/** Its short name (MAP_GRID_NAMES). */
	name: string;
	/** The unit's MAP from this grid, whole mm; null when it gives none. */
	mapMm: number | null;
	/** "93.3 % covered" when the grid has values over only part of the unit's parcel; else null. */
	covered: string | null;
	/** Why the grid can't be picked for this unit; null when it can. */
	reason: string | null;
	/** The unit holds this MAP from this grid already (over the same outline). */
	same: boolean;
	/** The other units holding another grid's MAP, which picking this grid switches too (with the name of the grid each is on). */
	switches: (UnitRef & { from: string })[];
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
const names = (us: readonly { name: string }[]) => {
	const n = us.map((u) => u.name || '(unnamed)');
	return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
};
const unitsWord = (n: number) => (n === 1 ? '1 unit' : `${fmtNum(n)} units`);

/**
 * Each grid the choice offers this unit: the named grids first (offered even
 * when not loaded, saying so), then any other loaded grid (a dev or test
 * grid). `loads` holds each loaded grid's proposal, read with `?dataset=`.
 */
export function gridOptions(nodeId: string, candidates: readonly UnitMapCandidate[], loads: ReadonlyMap<string, GridLoad>): GridOption[] {
	const labels = gridLabels(candidates);
	return labels.map((label): GridOption => {
		const opt: GridOption = { label, name: mapGridName(label), mapMm: null, covered: null, reason: null, same: false, switches: [] };
		if (!candidates.some((c) => c.label === label)) return { ...opt, reason: 'Not loaded on this server.' };
		const load = loads.get(label) ?? { kind: 'reading' };
		if (load.kind === 'reading') return { ...opt, reason: 'Reading the grid…' };
		if (load.kind === 'error') return { ...opt, reason: `Couldn’t be read: ${load.message}` };
		const p = load.proposal;
		const unit = p.units.find((u) => u.nodeId === nodeId);
		if (!unit) {
			const un = p.uncovered.find((u) => u.nodeId === nodeId);
			const refused = p.refused.find((u) => u.nodeId === nodeId);
			const reason = un
				? `${sentence(un.reason).replace(/\.$/, '')}${un.coveredShare > 0 ? ` (${pctText(un.coveredShare)} with values)` : ''}.`
				: refused
					? sentence(refused.reason)
					: p.withoutPolygon.some((u) => u.nodeId === nodeId)
						? 'The unit has no polygon on the map: draw or link its parcel on the Map first.'
						: 'Only a unit with land (an area above 0) takes a MAP from a grid.';
			return { ...opt, reason };
		}
		const cite = p.dataset ? unitMapGridCitation({ dataset: p.dataset.label, version: p.dataset.version }) : '';
		const fromOther = (source: string | null) => {
			const c = choiceOf(source, labels);
			return c.kind === 'grid' && c.citation !== cite ? c : null;
		};
		// The units this grid can't cover that hold another grid's MAP: an apply would leave them on it (grid_mixed).
		const blockers = p.otherGrid.filter((u) => u.nodeId !== nodeId);
		if (blockers.length) {
			const on = blockers.map((u) => `${u.name || '(unnamed)'} (${mapGridName((fromOther(u.mapSource) ?? { label: u.mapSource }).label)})`);
			return {
				...opt,
				mapMm: unit.mapMm,
				reason: `It would mix two grids: ${on.length === 1 ? on[0] : `${on.slice(0, -1).join(', ')} and ${on.at(-1)}`} ${blockers.length === 1 ? 'has a MAP' : 'have MAPs'} from another grid that this one doesn’t cover. Type ${blockers.length === 1 ? 'its' : 'their'} MAP by hand, or clear it, on ${blockers.length === 1 ? 'its' : 'their'} form first.`
			};
		}
		const switches = p.units.flatMap((u) => {
			if (u.nodeId === nodeId || u.current.mapMm === null) return [];
			const c = fromOther(u.current.mapSource);
			return c ? [{ nodeId: u.nodeId, name: u.name, from: mapGridName(c.label) }] : [];
		});
		return { ...opt, mapMm: unit.mapMm, covered: coveredText(unit), same: unit.same, switches };
	});
}

/** The units an apply of `opt` for this unit sends (POST …/map/unit-map `nodeIds`): this unit and the ones it switches. */
export const pickNodeIds = (nodeId: string, opt: GridOption): string[] => [nodeId, ...opt.switches.map((s) => s.nodeId)];

/** The question before picking `opt`, or null when there is nothing to ask (no other unit switches, and no typed MAP is replaced). */
export function pickQuestion(node: Pick<NetworkNode, 'name' | 'mapMm' | 'mapSource'>, choice: MapChoice, opt: GridOption): { title: string; message: string; confirmLabel: string } | null {
	const unit = node.name || 'This unit';
	const typed = choice.kind === 'typed' && node.mapMm !== null && node.mapMm !== undefined;
	const replaced = typed ? `${unit}’s typed ${fmtNum(node.mapMm, 6, true)} mm${node.mapSource ? ` (“${node.mapSource}”)` : ''} is replaced by ${fmtNum(opt.mapMm)} mm.` : '';
	if (opt.switches.length) {
		const n = opt.switches.length;
		const from = [...new Set(opt.switches.map((s) => s.from))];
		return {
			title: `Switch every unit to ${opt.name}?`,
			message: [
				`${unitsWord(n)} ${n === 1 ? 'uses' : 'use'} ${from.join(' and ')} now: ${names(opt.switches)}.`,
				`${n === 1 ? 'It' : 'They'} and ${node.name || 'this unit'} get their MAP from ${opt.name}, so the project keeps to one grid, saved straight to the model as one change in History.`,
				replaced,
				'Units whose MAP is typed by hand, or that have none, keep what they have.'
			]
				.filter(Boolean)
				.join(' '),
			confirmLabel: `Switch to ${opt.name}`
		};
	}
	if (typed) {
		return {
			title: 'Replace the typed MAP?',
			message: `${replaced.replace(/\.$/, '')} from ${opt.name}, saved straight to the model as one change in History.`,
			confirmLabel: `Use ${opt.name}`
		};
	}
	return null;
}

/** What a pick did, for the live notice. */
export function pickedNotice(a: UnitMapApplied, nodeId: string, unitName: string, name: string): string {
	const mine = a.units.find((u) => u.nodeId === nodeId);
	if (!a.changed) return `${unitName} already had its MAP from ${name}: nothing changed.`;
	const others = a.units.length - 1;
	if (!others) return `${unitName}’s MAP is now ${fmtNum(mine?.mapMm)} mm from ${name}, saved as one model change (History).`;
	return `${unitName} and ${others === 1 ? '1 other unit' : `${fmtNum(others)} other units`} now have their MAP from ${name}, saved as one model change (History).`;
}

/**
 * Typed by hand chosen while the unit's MAP is a grid's: the MAP stays, and
 * the grid's source line goes (the source field then asks for one), since a
 * grid's line on a MAP someone now vouches for would say the grid gave it.
 */
export function toTyped(n: Pick<NetworkNode, 'mapMm' | 'mapSource'>): void {
	if (unitMapGridOfSource(n.mapSource) === null) return;
	n.mapSource = n.mapMm === null || n.mapMm === undefined ? null : '';
}
