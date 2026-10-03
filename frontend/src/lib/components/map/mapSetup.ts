// The Map tab's "Getting started" pill (docs/ui.md § Map): the setup steps the
// map is the place for, which used to stack as full-width lines above the map
// ("No catchment boundary yet…", "No rain feed reads this catchment boundary
// yet…"). They fold into one pill in the section header, the Summary's Setup
// pill's pattern (overview/SetupPill.svelte), so the map keeps its height; the
// pill goes once every step is done (ui-playbook § 2, "Finished work leaves
// the page"). Pure: MapTab passes in what it knows.

/** What MapRainLink read from the feed list: null while it loads; `error` says nothing (the feeds panel says what failed). */
export type RainReads = 'current' | 'changed' | 'none' | 'error' | null;

export interface MapSetupStep {
	id: 'boundary' | 'rain';
	title: string;
	done: boolean;
	/** One line: what is there, or what to do. */
	detail: string;
}

/**
 * The steps, or null when there is nothing to nag about: every step done, or
 * the one left still being read (the rain feeds loading or failing to load),
 * so the pill never flashes up and goes again.
 */
export function mapSetupSteps(s: { boundaryName: string | null; rain: RainReads }): MapSetupStep[] | null {
	const hasBoundary = s.boundaryName !== null;
	const boundary: MapSetupStep = hasBoundary
		? { id: 'boundary', title: 'Catchment boundary', done: true, detail: `${s.boundaryName || 'The catchment boundary'} is on the map.` }
		: { id: 'boundary', title: 'Catchment boundary', done: false, detail: 'No catchment boundary yet. Draw it on the map, or upload it as a GeoJSON file (WGS84).' };
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
