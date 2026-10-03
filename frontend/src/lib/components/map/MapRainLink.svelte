<!--
	Whether a rain feed reads the Map's catchment boundary (issue #326 B-rain;
	docs/ui.md § Map): for editors, while the map has a boundary, it reads the
	feed list and says (`reads`) whether a CHIRPS feed reads the boundary
	(`current`), read it before it was redrawn (`changed`), none does (`none`)
	or the list couldn't be read (`error`). The Map's Getting started pill
	(MapSetupPill) shows the step and its link to Settings → Data feeds; until
	2026-10-02 this drew its own line above the map.
-->
<script lang="ts">
	import { api, type MapFeature } from '$lib/api';
	import { boundaryFeedState } from '../feeds/boundaryState';
	import type { RainReads } from './mapSetup';

	let { projectId, boundary, reads = $bindable(null) }: { projectId: string; boundary: Pick<MapFeature, 'id' | 'updatedAt'>; reads?: RainReads } = $props();

	type Feeds = { feeds: { source: string; config: { boundary?: { featureId: string; updatedAt: string } } }[] };

	$effect(() => {
		const b = { id: boundary.id, updatedAt: boundary.updatedAt };
		let live = true;
		reads = null;
		api
			.request<Feeds>('GET', `/projects/${encodeURIComponent(projectId)}/feeds`)
			.then((r) => live && (reads = boundaryFeedState(r.feeds, b)))
			// No step is better than a wrong one; the feeds panel says what failed.
			.catch(() => live && (reads = 'error'));
		return () => (live = false);
	});
</script>

<!-- data-state says when the feed list is in (loading, current, changed, none): tests wait on it, not on time. Draws nothing. -->
<span class="rain" data-testid="map-rain" data-state={reads ?? 'loading'} hidden></span>
