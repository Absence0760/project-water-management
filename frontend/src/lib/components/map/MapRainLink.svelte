<!--
	The Map tab's way to the rain feed from the boundary (issue #326 B-rain;
	docs/ui.md § Map): one line, for editors, when the map has a catchment
	boundary and no CHIRPS feed reads it (or one read it before it was
	redrawn). The link opens Settings → Data feeds with the proposal showing.
	It reads the feed list itself, and only when there is a boundary.
-->
<script lang="ts">
	import { api, type MapFeature } from '$lib/api';
	import { boundaryFeedState } from '../feeds/boundaryState';

	let { projectId, boundary }: { projectId: string; boundary: Pick<MapFeature, 'id' | 'updatedAt'> } = $props();

	type Feeds = { feeds: { source: string; config: { boundary?: { featureId: string; updatedAt: string } } }[] };
	let reads = $state<'current' | 'changed' | 'none' | 'error' | null>(null);

	$effect(() => {
		const b = { id: boundary.id, updatedAt: boundary.updatedAt };
		let live = true;
		api
			.request<Feeds>('GET', `/projects/${encodeURIComponent(projectId)}/feeds`)
			.then((r) => live && (reads = boundaryFeedState(r.feeds, b)))
			// No line is better than a wrong one; the feeds panel says what failed.
			.catch(() => live && (reads = 'error'));
		return () => (live = false);
	});
</script>

<!-- data-state says when the feed list is in (loading, current, changed, none): tests wait on it, not on time. -->
<div class="rain" data-testid="map-rain" data-state={reads ?? 'loading'}>
	{#if reads === 'none' || reads === 'changed'}
		<p class="alert alert-info slim" data-testid="map-rain-link">
			{reads === 'none' ? 'No rain feed reads this catchment boundary yet.' : 'The boundary changed since the rain feed took its cells.'}
			<a href="?tab=settings&rain=boundary#set-feeds">{reads === 'none' ? 'Set up the rain feed from the boundary' : 'Propose its cells again'}</a>
		</p>
	{/if}
</div>

<style>
	/* Takes no place in the page's layout of its own: only the line, when there is one. */
	.rain {
		display: contents;
	}
</style>
