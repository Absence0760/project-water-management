<script lang="ts">
	// The Map tab's Checks panel (issue #326 A4; docs/maps.md § Checks):
	// consistency warnings for the hydrologist, from mapChecks.ts. Warnings
	// only: nothing here blocks a save or a run. Each warning names the
	// features it is about as buttons that pick them on the map and in the
	// list (`onpick`); without `onpick` the names are plain text.
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { MapFeature, MapNodeArea } from '$lib/api/types';
	import { KIND_LABEL } from './mapData';
	import { mapChecks } from './mapChecks';

	let {
		features,
		nodes,
		onpick,
		cap = Infinity,
		heading = true
	}: {
		features: MapFeature[];
		nodes: MapNodeArea[];
		onpick?: (featureId: string) => void;
		/** Show this many warnings until "Show all" (ui-playbook: fold every long list); every one by default. */
		cap?: number;
		/** Draw the panel's own "Checks" heading (off inside a sheet that has its title). */
		heading?: boolean;
	} = $props();

	const uid = $props.id();
	const checks = $derived(mapChecks(features, nodes));
	let all = $state(false);
	const shown = $derived(all ? checks : checks.slice(0, cap));
	const byId = $derived(new Map(features.map((f) => [f.id, f])));
	const nameOf = (id: string) => {
		const f = byId.get(id);
		return f ? f.name || KIND_LABEL[f.kind] : id;
	};
</script>

<section class={heading ? 'panel' : 'bare'} aria-labelledby={heading ? `${uid}-h` : undefined} data-testid="map-checks">
	{#if heading}
		<div class="panel-head">
			<h2 id="{uid}-h">Checks <HelpTip key="map-checks" /></h2>
			{#if checks.length}
				<span class="small muted" data-testid="map-checks-count">{checks.length} {checks.length === 1 ? 'warning' : 'warnings'}</span>
			{/if}
		</div>
	{/if}
	{#if checks.length}
		<p class="small muted intro">Warnings only: none of them stops you saving or running the model.{#if !heading}{' '}<HelpTip key="map-checks" />{/if}</p>
		<ul class="checks" id="{uid}-list">
			{#each shown as c (c.id)}
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
		{#if checks.length > cap}
			<button type="button" class="btn btn-sm more" aria-expanded={all} aria-controls="{uid}-list" onclick={() => (all = !all)} data-testid="map-checks-more">
				{all ? `Show the first ${cap} warnings` : `Show all ${checks.length} warnings`}
			</button>
		{/if}
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
