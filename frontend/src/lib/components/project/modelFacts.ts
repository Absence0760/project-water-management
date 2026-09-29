// The Project page's "The model" facts (ProjectTab.svelte): the model as
// edited, counted the way the tab each fact links to counts it, so the two
// never disagree (issue #177). Gauges and other water users are split as the
// Network's header line splits them (kind 'gauge', kind 'user'); dams are the
// Dams page's (`modelDams`: farms with at least 1 m³, a capacity on any other
// kind is inert in the engine). Pure, no DOM.
import type { ProjectModel } from '@water-management/engine';
import { modelDams } from '$lib/components/dams/dams';

export interface ModelFacts {
	/** Hydrological units (kind 'farm'). */
	farms: number;
	/** Measuring points (kind 'gauge'), the outflow gauge included. */
	gauges: number;
	/** Other water users (kind 'user'): a town, industry or unlisted irrigator. */
	users: number;
	areaKm2: number;
	/** The Dams page's dams and their total capacity. */
	dams: number;
	damM3: number;
	crops: number;
	irrigatedHa: number;
	/** Enabled transfer rules. */
	transfers: number;
	/** The node that drains nowhere, by name; null without one (or unnamed, as the Network writes it). */
	outlet: string | null;
}

type ModelLike = Pick<ProjectModel, 'nodes' | 'crops' | 'cropAreas' | 'transfers'>;

export function modelFacts(m: ModelLike): ModelFacts {
	const dams = modelDams(m.nodes);
	return {
		farms: m.nodes.filter((n) => n.kind === 'farm').length,
		gauges: m.nodes.filter((n) => n.kind === 'gauge').length,
		users: m.nodes.filter((n) => n.kind === 'user').length,
		areaKm2: m.nodes.reduce((s, n) => s + (n.areaKm2 || 0), 0),
		dams: dams.length,
		damM3: dams.reduce((s, d) => s + d.capacityM3, 0),
		crops: m.crops.length,
		irrigatedHa: m.cropAreas.reduce((s, a) => s + (a.areaM2 || 0), 0) / 10_000,
		transfers: m.transfers.filter((t) => t.enabled).length,
		outlet: m.nodes.find((n) => n.downstreamNodeId === null)?.name || null
	};
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The Hydrological units tile's small line: "+ 1 gauge", and the other water users when there are any. */
export function otherNodesLine(f: Pick<ModelFacts, 'gauges' | 'users'>): string {
	const gauges = `+ ${count(f.gauges, 'gauge', 'gauges')}`;
	return f.users ? `${gauges}, ${count(f.users, 'other user', 'other users')}` : gauges;
}
