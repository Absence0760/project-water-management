// The one-node form's sections (NodeDetail.svelte), in the order water moves
// through a unit: its area and flow share, its dam with the dam's survey and
// releases, how water reaches the dam, where the unit's supply comes from,
// how it irrigates, its other demands, its groundwater (the combined
// boreholes, then the individual ones) and its land cover. The node sheet's
// jump row (NetworkTab.svelte) lists the same sections, so the two never
// disagree.
import type { NetworkNode } from '@water-management/engine';
import { GROUPS, hasDam, hasDamDevelopment, NODE_FIELDS, type NodeField } from './fields';
import { hasSupplySettings } from './supply';

/** A field group of NODE_FIELDS, or one of the form's own sections. */
export type NodeSection = NodeField['group'] | 'damSurvey' | 'supply' | 'demand' | 'boreholes' | 'cover';

export const SECTION_ORDER: readonly NodeSection[] = ['area', 'share', 'dam', 'damSurvey', 'routing', 'supply', 'irrigation', 'demand', 'groundwater', 'boreholes', 'cover'];

/** Each section's legend in the form. */
export const SECTION_TITLE: Record<NodeSection, string> = {
	...GROUPS,
	damSurvey: 'Dam survey and releases',
	supply: 'Supply',
	demand: 'Demand objects',
	boreholes: 'Individual boreholes',
	cover: 'Land cover'
};

/** Each section's name on the jump row, where room is short. */
export const SECTION_SHORT: Record<NodeSection, string> = {
	...SECTION_TITLE,
	groundwater: 'Combined boreholes',
	damSurvey: 'Dam survey'
};

/** Whether one of NODE_FIELDS shows on this kind of node (a gauge passes flow through; a user has only groundwater). */
export function fieldShows(f: NodeField, kind: NetworkNode['kind']): boolean {
	if (f.farmOnly && kind !== 'farm') return false;
	if (f.notGauge && kind === 'gauge') return false;
	// An other water user has no land, dam or routing of its own (WP-1.33), but may have boreholes (WP-1.34).
	if (kind === 'user' && f.group !== 'groundwater') return false;
	return true;
}

/**
 * The sections the form shows for a node, in order. Demand objects, supply
 * and the dam's development fields also show on a node that isn't a unit (or
 * has no dam) while it still carries them, so they can be cleared (the save
 * refuses them there).
 */
export function nodeSections(node: NetworkNode, demandObjects: number): NodeSection[] {
	const groups = new Set(NODE_FIELDS.filter((f) => fieldShows(f, node.kind)).map((f) => f.group));
	const farm = node.kind === 'farm';
	const own: Record<Exclude<NodeSection, NodeField['group']>, boolean> = {
		damSurvey: hasDam(node) || hasDamDevelopment(node),
		supply: farm || hasSupplySettings(node),
		demand: farm || demandObjects > 0,
		boreholes: node.kind !== 'gauge',
		cover: farm
	};
	return SECTION_ORDER.filter((s) => (s in own ? own[s as keyof typeof own] : groups.has(s as NodeField['group'])));
}

/** The id of a section's fieldset in a node's form (the jump row scrolls to it). */
export const sectionId = (nodeId: string, s: NodeSection) => `nd-sec-${s}-${nodeId}`;
