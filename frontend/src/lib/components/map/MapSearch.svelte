<!--
	The Map's search box (issue #523 C5, #90 Q23; docs/ui.md § Map, docs/maps.md
	§ Search): over the map's top edge (MapTab.svelte's .search-at), for finding
	the area before Start from the map.
	Find (or Enter) asks our own backend (GET …/map/search, never a
	third-party geocoder): the map's layers first (gauge codes and names, the
	register's dams, quaternary codes), then the gazetteer's towns, farms and
	rivers. One match moves the view at once; several are listed, each a button
	that moves the view to it (`onpick`) and closes the list. Whenever the
	answer holds places, listed or picked at once, their credit (GeoNames, CC BY
	4.0) shows under the box, linking to the Data sources page. The state is
	mapSearchState.svelte.ts.
	Escape closes the list. Nothing is saved, nothing is drawn: the view moves.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { api, type MapSearchHit } from '#lib/api/index.js';
	import { hitDetail, hitName } from './mapSearch';
	import { MapSearchState } from './mapSearchState.svelte';

	let {
		projectId,
		onpick,
		listHeight = $bindable(0)
	}: {
		projectId: string;
		onpick: (hit: MapSearchHit) => void;
		/** The open list's height (0 while closed): over a map it covers what's under it, so the caller's insets leave it out. */
		listHeight?: number;
	} = $props();

	const uid = $props.id();
	let q = $state('');
	let input: HTMLInputElement;
	let listH = $state(0);
	const s = new MapSearchState(
		(text) => api.map.search(projectId, text),
		(h) => onpick(h)
	);

	$effect(() => {
		listHeight = s.open && s.answer ? listH : 0;
	});

	function find(e: SubmitEvent) {
		e.preventDefault();
		void s.find(q);
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape' && s.close()) {
			e.preventDefault();
			input.focus();
		}
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="map-search" onkeydown={key} data-testid="map-search">
	<form role="search" aria-label="Search the map" onsubmit={find}>
		<label class="visually-hidden" for="{uid}-q">Find a place on the map</label>
		<input
			id="{uid}-q"
			type="search"
			maxlength="100"
			autocomplete="off"
			placeholder="Find a town, farm, river, gauge, dam or quaternary"
			bind:value={q}
			bind:this={input}
			aria-describedby="{uid}-said"
			data-testid="map-search-input"
		/>
		<button type="submit" class="btn btn-sm" disabled={s.busy} data-testid="map-search-submit">Find</button>
	</form>
	<p class="said small" id="{uid}-said" role="status" data-testid="map-search-status">{s.said}</p>
	{#if s.error}<p class="err small" role="alert" data-testid="map-search-error">{s.error}</p>{/if}
	{#if s.open && s.answer}
		<ul class="hits" aria-label="Matches" data-testid="map-search-results" bind:offsetHeight={listH}>
			{#each s.answer.hits as h, i (`${h.kind}:${h.dataset}:${h.code ?? h.name}:${i}`)}
				<li>
					<button type="button" class="hit" onclick={() => s.pick(h)} data-testid="map-search-hit" data-kind={h.kind}>
						<span class="name">{hitName(h)}</span>
						<span class="detail small">{hitDetail(h)}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	<!-- Not inside the list's block: a single place is picked at once and never listed, and its credit still shows (CC BY 4.0). -->
	{#if s.credits.length}
		<p class="credit small" data-testid="map-search-credit">
			Place names: {s.credits.map((c) => c.source).join('; ')}{#if s.credits.some((c) => !c.synthetic)}
				(<a href={resolve('data-sources#geonames')}>data sources</a>){/if}.
		</p>
	{/if}
</div>

<style>
	/* Over the map (MapTab.svelte places it): each piece on the surface with the map controls' edge and shadow, so it reads on any basemap. */
	.map-search {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.3rem;
		max-width: 34rem;
	}
	form {
		display: flex;
		gap: 0.3rem;
		width: 100%;
		padding: 0.2rem;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
	}
	input {
		flex: 1;
		min-width: 0;
	}
	button[type='submit'] {
		flex: none;
	}
	.said,
	.err,
	.credit {
		margin: 0;
		padding: 0.1rem 0.45rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
	}
	.said:empty {
		display: none;
	}
	.said,
	.credit {
		color: var(--text-muted);
	}
	.err {
		color: var(--danger, #b3261e);
	}
	.hits {
		list-style: none;
		margin: 0;
		padding: 0;
		width: 100%;
		max-height: 16rem;
		overflow-y: auto;
		border: 1px solid var(--border-strong);
		border-radius: 0.4rem;
		background: var(--surface);
		box-shadow: var(--shadow);
	}
	.hits li + li {
		border-top: 1px solid var(--border);
	}
	.hit {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		min-height: 2.75rem;
		padding: 0.35rem 0.7rem;
		border: 0;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
		font: inherit;
	}
	.hit:hover,
	.hit:focus-visible {
		background: var(--accent-soft);
	}
	.name {
		font-weight: 600;
	}
	.detail {
		color: var(--text-muted);
	}
</style>
