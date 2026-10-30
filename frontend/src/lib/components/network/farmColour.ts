// What the schematic colours its farms by (issue #17: the Network map's
// "Colour farms by"): supply in the latest run, or how full each dam was at
// the end of it. Pure. (Irrigated area, banded in thirds of the largest farm,
// was removed in issue #174: the bands were arbitrary, and Crops & demand and
// the node card show the areas.) Each mode gives every farm
// a band and the words for its label line, the legend entries and a caption,
// so the drawing is never colour-only.
import type { NetworkNode, RunSummary } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { LOW_PCT, type DamLevel } from '#lib/components/overview/damLevels.js';
import { BAND_LABEL, bandsPresent, supplyByNode, type SupplyBand } from './supplyColour';
import { keyEntryText, unitPlacement, unitZoneText, zoneByUnit, zoneKeyEntries, type ZoneGroup } from '#lib/calibration/zoneGroups.js';

export type ColourMode = 'supply' | 'dam' | 'zone';

/**
 * Supply and dam level share the three good / mid / bad bands (and their colours); `none` and `absent` as for supply.
 * `zone` (issue #555): a calibration zone's colour, carried by the node's or the legend entry's `swatch`.
 */
export type ColourBand = SupplyBand | 'zone';

export interface NodeColour {
	band: ColourBand;
	/** The node's label line, e.g. "82% supplied", "64% full", "Weir zone". */
	text: string;
	/** The fill for band `zone` (a CSS colour, `var(--series-N)`). */
	swatch?: string;
	/** Band `zone`: the unit takes another location's parameters by Parameters from (issue #659), drawn with an outline. */
	marker?: 'borrowed';
}

export interface Colouring {
	mode: ColourMode;
	byNode: ReadonlyMap<string, NodeColour>;
	/** The bands present, in order, with their words (band `zone`: one entry per zone, with its swatch; `marker` its borrowed units). */
	legend: { band: ColourBand; label: string; swatch?: string; marker?: 'borrowed' }[];
	/** One sentence: what the colours show, and from which run. */
	caption: string;
	/** The colours are a run's, and the model has unsaved edits they don't reflect. */
	unsaved: boolean;
	/**
	 * Units whose dam's own settings have been edited since that run (dams/dams.ts damChanges,
	 * issue #444), each with its sentence and whether its capacity changed: the drawing marks them, since their
	 * colour and figure are the run's. Absent = none, or the run's model isn't known.
	 */
	changed?: ReadonlyMap<string, { text: string; capacity: boolean }>;
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

/**
 * Units by calibration zone (issue #555; locations, issue #659, docs/model.md §2.10n): each ticked location's group
 * in its own colour, upstream first and the headline's last, then the units on the catchment parameters. A unit
 * borrowed by Parameters from takes its donor's colour with an outline, and its label line says "borrowed from G";
 * a unit the rest rule placed says so ("nearest upstream: G"). From the model as edited and the saved settings, by
 * the engine's rule (calibration/zoneGroups.ts), so it is live, not a run's. A unit with no land area isn't in a zone.
 */
export function zoneColouring(nodes: readonly NetworkNode[], groups: readonly ZoneGroup[]): Colouring {
	const of = zoneByUnit(groups);
	const byNode = new Map<string, NodeColour>();
	for (const n of nodes) {
		if (n.kind !== 'farm') continue;
		const g = of.get(n.id);
		if (!g) {
			byNode.set(n.id, { band: 'none', text: 'no land area, in no zone' });
			continue;
		}
		const borrowed = unitPlacement(g, n.id) === 'borrowed';
		byNode.set(n.id, { band: 'zone', text: unitZoneText(g, n.id), swatch: `var(${g.token})`, ...(borrowed ? { marker: 'borrowed' as const } : {}) });
	}
	const legend: Colouring['legend'] = zoneKeyEntries(groups).map((e) => ({ band: 'zone', label: keyEntryText(e), swatch: `var(${e.token})`, ...(e.marker ? { marker: 'borrowed' as const } : {}) }));
	if ([...byNode.values()].some((c) => c.band === 'none')) legend.push({ band: 'none', label: 'No land area, in no zone' });
	return {
		mode: 'zone',
		byNode,
		legend,
		caption: `Hydrological units coloured by the calibration location whose parameters they run on: each ticked location’s units, upstream first, the headline’s last${groups.some((g) => g.borrowed.length) ? '; a unit in a dotted ring runs on another location’s parameters' : ''} (Calibration → Calibration record, as saved).`,
		unsaved: false
	};
}
