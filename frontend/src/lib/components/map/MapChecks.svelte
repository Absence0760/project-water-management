<script lang="ts">
	// The Map tab's Checks panel (issue #326 A4; docs/maps.md § Checks):
	// consistency warnings for the hydrologist, from mapChecks.ts. Warnings
	// only: nothing here blocks a save or a run. Each warning names the
	// features it is about as buttons that pick them on the map and in the
	// list (`onpick`); without `onpick` the names are plain text.
	import type { MapFeature, MapNodeArea } from '$lib/api/types';
	import { KIND_LABEL } from './mapData';
	import { mapChecks } from './mapChecks';

	let { features, nodes, onpick }: { features: MapFeature[]; nodes: MapNodeArea[]; onpick?: (featureId: string) => void } = $props();

	const uid = $props.id();
	const checks = $derived(mapChecks(features, nodes));
	const byId = $derived(new Map(features.map((f) => [f.id, f])));
	const nameOf = (id: string) => {
		const f = byId.get(id);
		return f ? f.name || KIND_LABEL[f.kind] : id;
	};
</script>

<section class="panel" aria-labelledby="{uid}-h" data-testid="map-checks">
	<div class="panel-head">
		<h2 id="{uid}-h">Checks</h2>
		{#if checks.length}
			<span class="small muted" data-testid="map-checks-count">{checks.length} {checks.length === 1 ? 'warning' : 'warnings'}</span>
		{/if}
	</div>
	{#if checks.length}
		<p class="small muted intro">Warnings only: none of them stops you saving or running the model.</p>
		<ul class="checks">
			{#each checks as c (c.id)}
				<li class="check" data-check={c.id}>
					<span class="text">{c.text}</span>
					{#if c.featureIds.length}
						<span class="picks small">
							{#if onpick}
								{#each c.featureIds as id (id)}
									<button type="button" class="link" onclick={() => onpick(id)} aria-label="Show {nameOf(id)} on the map">{nameOf(id)}</button>
								{/each}
							{:else}
								{c.featureIds.map(nameOf).join(', ')}
							{/if}
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="muted" data-testid="map-checks-none">No problems found.</p>
	{/if}
</section>

<style>
	.intro {
		margin: 0 0 0.5rem;
	}
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.35rem;
	}
	.check {
		display: grid;
		gap: 0.15rem;
		padding: 0.4rem 0.6rem;
		border-left: 3px solid var(--warning);
		background: var(--warning-soft);
		border-radius: 0 6px 6px 0;
	}
	.text {
		color: var(--text);
	}
	.picks {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.75rem;
	}
	.link {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
		text-align: left;
		min-height: 24px;
	}
</style>
