<!--
	The Map's search box (issue #523 C5, #90 Q23; docs/ui.md § Map, docs/maps.md
	§ Search): above the map, for finding the area before Start from the map.
	Find (or Enter) asks our own backend (GET …/map/search, never a
	third-party geocoder): the map's layers first (gauge codes and names, the
	register's dams, quaternary codes), then the gazetteer's towns, farms and
	rivers. One match moves the view at once; several are listed, each a button
	that moves the view to it (`onpick`) and closes the list. A list with places
	carries their credit (GeoNames, CC BY 4.0), linking to the Data sources page.
	Escape closes the list. Nothing is saved, nothing is drawn: the view moves.
-->
<script lang="ts">
	import { base } from '$app/paths';
	import { api, type MapSearchAnswer, type MapSearchHit } from '$lib/api';
	import { hitDetail, hitName, placeCredits, resultLine } from './mapSearch';

	let { projectId, onpick }: { projectId: string; onpick: (hit: MapSearchHit) => void } = $props();

	const uid = $props.id();
	let q = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let answer = $state<MapSearchAnswer | null>(null);
	/** The list is showing (a search with several matches, until one is picked or Escape). */
	let open = $state(false);
	/** The match the view moved to. */
	let shown = $state<MapSearchHit | null>(null);
	let input: HTMLInputElement;
	const credits = $derived(answer ? placeCredits(answer.hits) : []);
	/** Said to assistive technology after each search and each pick. */
	const said = $derived(
		error ? '' : busy ? 'Searching…' : shown ? `Showing ${hitName(shown)} on the map.` : answer ? resultLine(answer.q, answer.hits, answer.truncated) : ''
	);

	function pick(h: MapSearchHit) {
		shown = h;
		open = false;
		onpick(h);
	}

	async function find(e: SubmitEvent) {
		e.preventDefault();
		const text = q.trim();
		error = null;
		shown = null;
		if (text.length < 2) {
			error = 'Type at least 2 letters or digits.';
			return;
		}
		busy = true;
		try {
			answer = await api.map.search(projectId, text);
			if (answer.hits.length === 1) pick(answer.hits[0]!);
			else open = answer.hits.length > 0;
		} catch (err) {
			answer = null;
			open = false;
			error = `The search failed: ${(err as Error).message}`;
		} finally {
			busy = false;
		}
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.preventDefault();
			open = false;
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
		<button type="submit" class="btn btn-sm" disabled={busy} data-testid="map-search-submit">Find</button>
	</form>
	<p class="said small" id="{uid}-said" role="status" data-testid="map-search-status">{said}</p>
	{#if error}<p class="err small" role="alert" data-testid="map-search-error">{error}</p>{/if}
	{#if open && answer}
		<ul class="hits" aria-label="Matches" data-testid="map-search-results">
			{#each answer.hits as h, i (`${h.kind}:${h.dataset}:${h.code ?? h.name}:${i}`)}
				<li>
					<button type="button" class="hit" onclick={() => pick(h)} data-testid="map-search-hit" data-kind={h.kind}>
						<span class="name">{hitName(h)}</span>
						<span class="detail small">{hitDetail(h)}</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if credits.length}
			<p class="credit small" data-testid="map-search-credit">
				Place names: {credits.map((c) => c.source).join('; ')}{#if credits.some((c) => !c.synthetic)}
					(<a href="{base}/data-sources#geonames">data sources</a>){/if}.
			</p>
		{/if}
	{/if}
</div>

<style>
	.map-search {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	form {
		display: flex;
		gap: 0.4rem;
		max-width: 34rem;
	}
	input {
		flex: 1;
		min-width: 0;
	}
	.said,
	.err,
	.credit {
		margin: 0;
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
		max-width: 34rem;
		max-height: 16rem;
		overflow-y: auto;
		border: 1px solid var(--border-strong);
		border-radius: 0.4rem;
		background: var(--surface);
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
