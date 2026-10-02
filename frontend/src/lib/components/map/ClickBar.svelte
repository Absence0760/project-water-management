<!--
	Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
	from clicks, docs/ui.md § Map): the bar above the map while the mode is on,
	in the draw bar's place. Each click (or Enter at the crosshair, or typed
	coordinates: the way that needs no pointer) is an outlet on a river; the
	server works out every click's incremental catchment and the map draws them
	numbered by click. The bar is their key: one line per click with its area
	and where its water goes, a dropped click with why. Undo takes back the
	last click (without asking the server again), Clear drops them all, Save as
	areas saves each piece as an "other" polygon (routed again on the server),
	Done leaves the mode (asking first when unsaved clicks would be lost).
-->
<script lang="ts">
	import type { MapPosition } from '$lib/api/types';
	import { parseDegrees } from './mapData';
	import { pieceLine, savable, type ClickDivider } from './clickPieces.svelte';

	let {
		divider,
		mapReady,
		ondone,
		onsave,
		onlit
	}: {
		divider: ClickDivider;
		/** false without WebGL: no clicks, so the bar leads with typed coordinates. */
		mapReady: boolean;
		ondone: () => void;
		onsave: () => void;
		/** A line with the focus or the pointer lights its piece on the map (null: none). */
		onlit: (key: string | null) => void;
	} = $props();

	const uid = $props.id();
	const phone = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 700px)').matches);
	const r = $derived(divider.result);
	const kept = $derived(savable(r));
	const totalKm2 = $derived(kept.reduce((s, p) => s + p.areaM2!, 0) / 1e6);
	const inflows = $derived(r ? r.pieces.filter((p) => p.open).length : 0);

	// svelte-ignore state_referenced_locally
	let showCoords = $state(!mapReady);
	let latText = $state('');
	let lonText = $state('');
	let tried = $state(false);
	const lat = $derived(parseDegrees(latText, 'lat'));
	const lon = $derived(parseDegrees(lonText, 'lon'));
	async function addTyped(e: SubmitEvent) {
		e.preventDefault();
		tried = true;
		if ('error' in lat || 'error' in lon) return;
		const at: MapPosition = [lon.value, lat.value];
		tried = false;
		latText = '';
		lonText = '';
		await divider.add(at);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			ondone();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape leaves from any control inside; each control is itself interactive) -->
<section class="click-bar" aria-labelledby="{uid}-h" data-testid="map-click-bar" data-busy={divider.busy ?? undefined} {onkeydown}>
	<h2 class="bar-h" id="{uid}-h">Sub-catchments from clicks</h2>
	<p class="how small" data-testid="map-click-how">
		{mapReady
			? `${phone ? 'Tap' : 'Click'} a river (or press Enter at the crosshair) for each outlet. Each one gets the land that drains to it before any other ${phone ? 'tap' : 'click'}.`
			: 'The map can’t be drawn here: enter each outlet’s coordinates.'}
	</p>
	<p class="said small muted" role="status" data-testid="map-click-said">{divider.said}</p>
	{#if divider.error}<p class="problem small" role="alert" data-testid="map-click-error">{divider.error}</p>{/if}

	{#if divider.clicks.length}
		<ol class="pieces small" data-testid="map-click-pieces">
			{#each divider.clicks as _, i (i)}
				{@const isPiece = r?.pieces.some((p) => p.click === i && !p.open)}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (focusable so a keyboard user can light its piece; it says the same in words) -->
				<li
					class:dropped={r && !isPiece}
					tabindex={isPiece ? 0 : undefined}
					onmouseenter={() => isPiece && onlit(String(i))}
					onmouseleave={() => onlit(null)}
					onfocus={() => isPiece && onlit(String(i))}
					onblur={() => onlit(null)}
					data-testid="map-click-piece"
					data-click={i}
				>
					<span class="num" aria-hidden="true">{i + 1}</span>
					<span><span class="visually-hidden">Sub-catchment {i + 1}:</span> {r ? pieceLine(r, i) : 'working it out…'}</span>
				</li>
			{/each}
		</ol>
		{#if r && r.pieces.length}
			<p class="small muted" data-testid="map-click-total">
				{kept.length === 1 ? '1 sub-catchment' : `${kept.length} sub-catchments`}, {totalKm2.toFixed(2)} km² in all{inflows
					? `, and ${inflows === 1 ? '1 inflow point' : `${inflows} inflow points`} (not saved: model what comes from above as an inflow)`
					: ''}, from {r.dataset.label}. A proposal from the elevation model: check each piece against the map before you save.
			</p>
		{/if}
	{/if}

	<details class="coords" bind:open={showCoords}>
		<summary>Enter coordinates</summary>
		<form class="coord-row" onsubmit={addTyped} novalidate data-testid="map-click-coords">
			<label>
				Latitude
				<input inputmode="decimal" placeholder="-33.54" bind:value={latText} aria-invalid={tried && 'error' in lat ? 'true' : undefined} data-testid="map-click-lat" />
			</label>
			<label>
				Longitude
				<input inputmode="decimal" placeholder="20.74" bind:value={lonText} aria-invalid={tried && 'error' in lon ? 'true' : undefined} data-testid="map-click-lon" />
			</label>
			<button type="submit" class="btn btn-sm" disabled={divider.busy === 'save'} data-testid="map-click-add">Add the outlet</button>
		</form>
		{#if tried && ('error' in lat || 'error' in lon)}
			<p class="problem small" role="alert">{'error' in lat ? lat.error : 'error' in lon ? lon.error : ''}</p>
		{/if}
	</details>

	<div class="bar-actions">
		<button type="button" class="btn btn-sm" onclick={() => divider.undo()} disabled={!divider.canUndo} data-testid="map-click-undo">Undo the last click</button>
		<button type="button" class="btn btn-sm" onclick={() => divider.clear()} disabled={!divider.clicks.length || divider.busy === 'save'} data-testid="map-click-clear">Clear</button>
		<button type="button" class="btn btn-sm btn-ghost" onclick={ondone} data-testid="map-click-done">Done</button>
		<button type="button" class="btn btn-sm btn-primary" onclick={onsave} disabled={!kept.length || !!divider.busy} data-testid="map-click-save">
			{divider.busy === 'save' ? 'Saving…' : kept.length > 1 ? `Save the ${kept.length} as areas` : 'Save as an area'}
		</button>
	</div>
</section>

<style>
	.click-bar {
		display: grid;
		gap: 0.3rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.bar-h {
		margin: 0;
		font-size: 0.95rem;
	}
	.how,
	.said,
	.problem,
	.pieces,
	.coords p {
		margin: 0;
	}
	.problem {
		color: var(--danger);
	}
	.pieces {
		display: grid;
		gap: 0.15rem;
		padding: 0;
		list-style: none;
		max-height: 9.5rem;
		overflow-y: auto;
	}
	.pieces li {
		display: flex;
		gap: 0.45rem;
		align-items: baseline;
		border-radius: var(--radius-sm);
		padding: 0.05rem 0.2rem;
	}
	.pieces li[tabindex]:hover,
	.pieces li[tabindex]:focus-visible {
		background: var(--surface-2);
	}
	.pieces li.dropped {
		color: var(--text-muted);
	}
	.num {
		flex: none;
		min-width: 1.4rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
	.coord-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		align-items: end;
		margin-top: 0.3rem;
	}
	.coord-row label {
		display: grid;
		gap: 0.1rem;
		font-size: 0.85rem;
	}
	.coord-row input {
		width: 9rem;
	}
	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
</style>
