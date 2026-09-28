// What the schematic colours its farms by (issue #17: the Network map's
// "Colour farms by"): supply in the latest run, how full each dam was at the
// end of it, or the irrigated area as edited. Pure. Each mode gives every farm
// a band and the words for its label line, the legend entries and a caption,
// so the drawing is never colour-only.
import type { NetworkNode, ProjectModel, RunSummary } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { LOW_PCT, type DamLevel } from '$lib/components/overview/damLevels';
import { BAND_LABEL, bandsPresent, supplyByNode, type SupplyBand } from './supplyColour';

export type ColourMode = 'supply' | 'dam' | 'area';

/**
 * Supply and dam level share the three good / mid / bad bands (and their
 * colours); irrigated area is a single-hue scale, since more area is neither
 * good nor bad. `none` and `absent` as for supply.
 */
export type ColourBand = SupplyBand | 'area1' | 'area2' | 'area3';

export interface NodeColour {
	band: ColourBand;
	/** The node's label line, e.g. "82% supplied", "64% full", "20.0 ha planted". */
	text: string;
}

export interface Colouring {
	mode: ColourMode;
	byNode: ReadonlyMap<string, NodeColour>;
	/** The bands present, in order, with their words. */
	legend: { band: ColourBand; label: string }[];
	/** One sentence: what the colours show, and from which run. */
	caption: string;
	/** The colours are a run's, and the model has unsaved edits they don't reflect. */
	unsaved: boolean;
}

const present = <B extends ColourBand>(byNode: ReadonlyMap<string, NodeColour>, order: readonly B[], label: Record<B, string>) => {
	const seen = new Set([...byNode.values()].map((c) => c.band));
	return order.filter((b) => seen.has(b)).map((b) => ({ band: b, label: label[b] }));
};

export function supplyColouring(nodes: readonly NetworkNode[], summary: Pick<RunSummary, 'farms'>, run: { name: string; ago: string }, unsaved: boolean): Colouring {
	const byNode = supplyByNode(nodes, summary);
	return {
		mode: 'supply',
		byNode,
		legend: bandsPresent(byNode).map((b) => ({ band: b, label: BAND_LABEL[b] })),
		caption: `Hydrological units coloured by share of irrigation demand supplied in run “${run.name}”, ran ${run.ago}.`,
		unsaved
	};
}

/** At or above this share of capacity at the end of the run a dam is in the top band. */
export const DAM_FULL_PCT = 60;

const DAM_LABEL: Record<SupplyBand, string> = {
	met: `${DAM_FULL_PCT}% full or more`,
	short: `${LOW_PCT}–${DAM_FULL_PCT}% full`,
	low: `Under ${LOW_PCT}%, or at its minimum`,
	none: 'No dam',
	absent: 'Not in this run'
};

/** Farms by how full their dam was at the end of the run (`levels`: overview/damLevels.ts). */
export function damColouring(nodes: readonly NetworkNode[], levels: readonly DamLevel[], run: { name: string; ago: string }, unsaved: boolean): Colouring {
	const byId = new Map(levels.map((l) => [l.nodeId, l]));
	const byNode = new Map<string, NodeColour>();
	for (const n of nodes) {
		if (n.kind !== 'farm') continue;
		if (!(n.damCapacityM3 >= 1)) {
			byNode.set(n.id, { band: 'none', text: 'no dam' });
			continue;
		}
		const l = byId.get(n.id);
		if (!l) {
			byNode.set(n.id, { band: 'absent', text: 'not in this run' });
			continue;
		}
		const atMin = l.minPct > 0 && l.endPct <= l.minPct + 1e-6;
		const band: SupplyBand = atMin || l.endPct < LOW_PCT ? 'low' : l.endPct < DAM_FULL_PCT ? 'short' : 'met';
		byNode.set(n.id, { band, text: atMin ? `${fmtNum(l.endPct, 0)}%, at its minimum` : `${fmtNum(l.endPct, 0)}% full` });
	}
	return {
		mode: 'dam',
		byNode,
		legend: present(byNode, ['met', 'short', 'low', 'none', 'absent'] as const, DAM_LABEL),
		caption: `Hydrological units coloured by how full their dam was at the end of run “${run.name}”, ran ${run.ago}.`,
		unsaved
	};
}

/** Farms by their planted area (ha, the model as edited): nothing, then thirds of the largest. */
export function areaColouring(model: Pick<ProjectModel, 'nodes' | 'cropAreas'>): Colouring {
	const ha = new Map<string, number>();
	for (const a of model.cropAreas) ha.set(a.nodeId, (ha.get(a.nodeId) ?? 0) + (a.areaM2 || 0) / 10_000);
	const farms = model.nodes.filter((n) => n.kind === 'farm');
	const most = Math.max(0, ...farms.map((f) => ha.get(f.id) ?? 0));
	const b1 = most / 3;
	const b2 = (2 * most) / 3;
	const byNode = new Map<string, NodeColour>();
	for (const f of farms) {
		const v = ha.get(f.id) ?? 0;
		const band: ColourBand = v <= 0 ? 'none' : v <= b1 ? 'area1' : v <= b2 ? 'area2' : 'area3';
		byNode.set(f.id, { band, text: v > 0 ? `${fmtNum(v, 1)} ha planted` : 'nothing planted' });
	}
	const label: Record<'area1' | 'area2' | 'area3' | 'none', string> = {
		area1: `Up to ${fmtNum(b1, 0)} ha`,
		area2: `${fmtNum(b1, 0)}–${fmtNum(b2, 0)} ha`,
		area3: `Over ${fmtNum(b2, 0)} ha`,
		none: 'Nothing planted'
	};
	return {
		mode: 'area',
		byNode,
		legend: present(byNode, ['area3', 'area2', 'area1', 'none'] as const, label),
		caption: 'Hydrological units coloured by their irrigated (planted) area, as edited.',
		unsaved: false
	};
}
