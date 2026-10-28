// The Map tab's "Getting started" pill (docs/ui.md § Map): the setup steps the
// map is the place for, which used to stack as full-width lines above the map
// ("No catchment boundary yet…", "No rain feed reads this catchment boundary
// yet…"). They fold into one pill in the section header, the Summary's Setup
// pill's pattern (overview/SetupPill.svelte), so the map keeps its height; the
// pill goes once every step is done (ui-playbook § 2, "Finished work leaves
// the page"). Pure: MapTab passes in what it knows.
//
// A model started from the map (issue #646 F2) keeps its data step here once
// the Start sheet is closed: the pill lists startData.ts's to-do items, each
// with its status and link, until every item a run needs is done.
import { dataDone, type DataItem, type DataStatus } from './startData';

/** What MapRainLink read from the feed list: null while it loads; `error` says nothing (the feeds panel says what failed). */
export type RainReads = 'current' | 'changed' | 'none' | 'error' | null;

export interface MapSetupStep {
	/** 'boundary', 'rain', or a data item's id (startData.ts). */
	id: string;
	title: string;
	done: boolean;
	/** One line: what is there, or what to do. */
	detail: string;
	/** A data item's: its status (a step without one is done or to do), its link, the place in words, a second way in. */
	status?: DataStatus;
	href?: string;
	where?: string;
	more?: { href: string; text: string };
	optional?: boolean;
}

/** A data item as a step of the pill. */
const dataStep = (i: DataItem): MapSetupStep => ({ id: i.id, title: i.title, done: i.status === 'done', detail: i.detail, status: i.status, href: i.href, where: i.where, more: i.more, optional: i.optional });

/**
 * The steps, or null when there is nothing to nag about: every step done, or
 * the one left still being read (the rain feeds loading or failing to load),
 * so the pill never flashes up and goes again.
 */
export function mapSetupSteps(s: { boundaryName: string | null; rain: RainReads; canDelineate?: boolean; data?: readonly DataItem[] | null }): MapSetupStep[] | null {
	// Started from the map: the data step's items (their rain item is the boundary's rain step), until a run has what it needs.
	if (s.data) return dataDone(s.data) ? null : s.data.map(dataStep);
	const hasBoundary = s.boundaryName !== null;
	const boundary: MapSetupStep = hasBoundary
		? { id: 'boundary', title: 'Catchment boundary', done: true, detail: `${s.boundaryName || 'The catchment boundary'} is on the map.` }
		: {
				id: 'boundary',
				title: 'Catchment boundary',
				done: false,
				detail: s.canDelineate
					? 'No catchment boundary yet. Delineate it from its outlet on the river, draw it on the map, or upload it as a GeoJSON file (WGS84).'
					: 'No catchment boundary yet. Draw it on the map, or upload it as a GeoJSON file (WGS84).'
			};
	const rain: MapSetupStep = !hasBoundary
		? { id: 'rain', title: 'Rain from the boundary', done: false, detail: 'Once the boundary is on the map, a rain feed can read the cells inside it.' }
		: s.rain === 'none'
			? { id: 'rain', title: 'Rain from the boundary', done: false, detail: 'No rain feed reads this catchment boundary yet.' }
			: s.rain === 'changed'
				? { id: 'rain', title: 'Rain from the boundary', done: false, detail: 'The boundary changed since the rain feed took its cells.' }
				: { id: 'rain', title: 'Rain from the boundary', done: true, detail: 'A rain feed reads the cells inside the boundary.' };
	if (hasBoundary && s.rain !== 'none' && s.rain !== 'changed') return null;
	return [boundary, rain];
}

/** "1 of 2": the steps done, of all. */
export const setupCount = (steps: readonly MapSetupStep[]) => `${steps.filter((x) => x.done).length} of ${steps.length}`;
