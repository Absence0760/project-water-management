// How a new project starts (the New project dialog, WP-4.10 "Fast catchment
// onboarding"; docs/ui.md § Project list). The guided way opens the new
// project's Map on the Start sheet (`?tab=map&start=1`, docs/maps.md § Start
// from the map): the boundary, the units' boundaries and points, the proposed
// network, then the data to-do list up to a first calibrated run
// (map/startData.ts). The other way is the empty workspace, where the
// network is typed in on the Network (the Summary's checklist leads there).

export type StartHow = 'map' | 'network';

/** The guided way is the default: a new catchment is usually set up from its map. */
export const DEFAULT_START: StartHow = 'map';

export const START_CHOICES: readonly { value: StartHow; label: string; hint: string }[] = [
	{
		value: 'map',
		label: 'Guided, from the map',
		hint: 'Put the catchment and its units on the map: the network is proposed, then a to-do list takes you through the data to a first calibrated run.'
	},
	{
		value: 'network',
		label: 'An empty model',
		hint: 'Type the network in on the Network page. While the model is empty you can still start it from the map.'
	}
];

/** Where the new project opens, from the root (put the app's base, basePath(), before it): its Map on the Start sheet, or its Summary. */
export function newProjectPath(id: string, how: StartHow): string {
	const path = `/projects/${encodeURIComponent(id)}`;
	return how === 'map' ? `${path}?tab=map&start=1` : path;
}
