<!--
	Sub-catchments from clicks on the rivers (docs/maps.md § Sub-catchments
	from clicks, docs/ui.md § Map). Beside the map in the side column (or above
	it on a narrow page, MapTab picks): each click (or Enter at the crosshair,
	or typed coordinates: the way that needs no pointer) is an outlet; the
	server works out every click's incremental catchment and the map draws
	them numbered by click. This panel is their key: one line per click under
	its badge (the same number and tint as on the map, PieceBadge), with its
	area, where its water goes and how it was placed, or why it is not a
	piece. Undo takes back the last change (without asking the server again),
	Clear drops them all, Save keeps each piece as an "other" polygon (routed
	again on the server), Done leaves the mode (asking first when unsaved
	clicks would be lost).
-->
<script lang="ts">
	import type { MapPosition } from '$lib/api/types';
	import { parseDegrees } from './mapData';
	import { pieceLine, savable, type ClickDivider } from './clickPieces.svelte';
	import { choiceText } from './largerChannel';
	import PieceBadge from './PieceBadge.svelte';
	import DelineateChoice from './DelineateChoice.svelte';
	import DelineationLines from './DelineationLines.svelte';
	import type { KeyItem } from './mapList';
	import type { ProposalPiece } from './pieces';

	let {
		divider,
		pieces = [],
		mapReady,
		placement = 'side',
		ondone,
		onsave,
		onlit,
		onone,
		lines = null
	}: {
		divider: ClickDivider;
		/** The map's pieces (clickShape), for each line's tint. */
		pieces?: readonly ProposalPiece[];
		/** false without WebGL: no clicks, so the panel leads with typed coordinates. */
		mapReady: boolean;
		/** side: the side column's panel; above: a bar over the map (a narrow page). */
		placement?: 'side' | 'above';
		ondone: () => void;
		onsave: () => void;
		/** A line with the focus or the pointer lights its piece on the map (null: none). */
		onlit: (key: string | null) => void;
		/** Switch to delineating one catchment (the choice in the panel). */
		onone: () => void;
		/** The lines on the map in words (mapList.ts delineationLines): the terrain channels, and the river network while it is on. */
		lines?: KeyItem[] | null;
	} = $props();

	const uid = $props.id();
	const phone = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 700px)').matches);
	const r = $derived(divider.result);
	const kept = $derived(savable(r));
	const totalKm2 = $derived(kept.reduce((s, p) => s + p.areaM2!, 0) / 1e6);
	const inflows = $derived(r ? r.pieces.filter((p) => p.open).length : 0);
	const tintOf = (i: number) => pieces.find((p) => p.key === String(i))?.tint ?? -1;

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
		// Folded again once it has added one (it stays open without a map: it is the only way in).
		if (mapReady && !divider.error) showCoords = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			ondone();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape leaves from any control inside; each control is itself interactive) -->
<section class="click-bar {placement}" aria-labelledby="{uid}-h" data-testid="map-click-bar" data-busy={divider.busy ?? undefined} {onkeydown}>
	<h2 class="bar-h" id="{uid}-h">Sub-catchments</h2>
	<DelineateChoice value="clicks" onchange={(v) => v === 'one' && onone()} />
	<p class="how small" data-testid="map-click-how">
		{mapReady
			? `${phone ? 'Tap' : 'Click'} a terrain channel for each outlet, or press Enter at the crosshair. Each gets the land that drains to it before any other ${phone ? 'tap' : 'click'}, following the terrain.`
			: 'The map can’t be drawn here: enter each outlet’s coordinates.'}
	</p>
	{#if lines?.length && mapReady}<DelineationLines {lines} />{/if}
	<p class="said small muted" role="status" data-testid="map-click-said">{divider.said}</p>
	{#if divider.error}<p class="problem small" role="alert" data-testid="map-click-error">{divider.error}</p>{/if}
	{#if divider.pendingChoice}
		{@const pc = divider.pendingChoice}
		<div class="choice-box" role="alert" data-testid="map-click-confluence">
			<p class="small">Click {pc.click + 1} is at a confluence. Which river do you mean? It goes on the channel whose area matches.</p>
			<div class="bar-actions">
				{#each pc.choices as c (`${c.dataset}:${c.reachId}`)}
					<button type="button" class="btn" disabled={!!divider.busy} onclick={() => divider.chooseReach(c)} data-testid="map-click-choice" data-reach={c.reachId}>{choiceText(c)}</button>
				{/each}
				<button type="button" class="btn btn-ghost" onclick={() => divider.cancelChoice()} data-testid="map-click-choice-cancel">Drop the click</button>
			</div>
		</div>
	{/if}

	{#if divider.clicks.length}
		<ol class="pieces small" data-testid="map-click-pieces">
			{#each divider.clicks as _, i (i)}
				{@const isPiece = r?.pieces.some((p) => p.click === i && !p.open)}
				{@const larger = r?.pieces.find((p) => p.click === i)?.larger}
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
					<PieceBadge label={String(i + 1)} tint={isPiece ? tintOf(i) : -1} />
					<span class="line" data-testid="map-click-line">{r ? pieceLine(r, i) : 'working it out…'}</span>{#if larger}<button
							type="button"
							class="btn btn-sm use"
							disabled={!!divider.busy}
							onclick={() => divider.replace(i, larger.at)}
							data-testid="map-click-use-larger">{larger.reachKm2 !== undefined ? 'Use that channel' : 'Use the larger channel'}</button
						>{/if}
				</li>
			{/each}
		</ol>
		{#if r && r.pieces.length}
			<p class="total small" data-testid="map-click-total">
				<strong>{totalKm2.toFixed(2)} km²</strong> in {kept.length === 1 ? '1 sub-catchment' : `${kept.length} sub-catchments`}{inflows
					? `, and ${inflows === 1 ? '1 inflow point' : `${inflows} inflow points`} (not saved: model what comes from above as an inflow)`
					: ''}. A proposal from {r.dataset.label}: check each piece against the map before you save.
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
			<button type="submit" class="btn" disabled={divider.busy === 'save'} data-testid="map-click-add">Add the outlet</button>
		</form>
		{#if tried && ('error' in lat || 'error' in lon)}
			<p class="problem small" role="alert">{'error' in lat ? lat.error : 'error' in lon ? lon.error : ''}</p>
		{/if}
	</details>

	<div class="bar-actions">
		<button type="button" class="btn btn-primary" onclick={onsave} disabled={!kept.length || !!divider.busy} data-testid="map-click-save">
			{divider.busy === 'save' ? 'Saving…' : kept.length > 1 ? `Save the ${kept.length} as areas` : 'Save as an area'}
		</button>
		<button type="button" class="btn" onclick={() => divider.undo()} disabled={!divider.canUndo} data-testid="map-click-undo">Undo</button>
		<button type="button" class="btn" onclick={() => divider.clear()} disabled={!divider.clicks.length || divider.busy === 'save'} data-testid="map-click-clear">Clear</button>
		<button type="button" class="btn" onclick={ondone} data-testid="map-click-done">Done</button>
	</div>
</section>

<style>
	.click-bar {
		display: grid;
		gap: 0.45rem;
		align-content: start;
		min-width: 0;
	}
	.click-bar.above {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.bar-h {
		margin: 0;
		font-size: 1rem;
	}
	.how,
	.said,
	.problem,
	.pieces,
	.total,
	.coords p {
		margin: 0;
	}
	.said:empty {
		display: none;
	}
	.problem {
		color: var(--danger);
	}
	.choice-box {
		display: grid;
		gap: 0.4rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius-sm);
		background: var(--warning-soft);
	}
	.choice-box p {
		margin: 0;
	}
	.pieces {
		display: grid;
		gap: 0.35rem;
		padding: 0;
		list-style: none;
	}
	.pieces li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
		align-items: center;
		border-radius: var(--radius-sm);
		padding: 0.15rem 0.25rem;
	}
	.pieces li[tabindex]:hover,
	.pieces li[tabindex]:focus-visible {
		background: var(--surface-2);
	}
	.pieces li.dropped {
		color: var(--text-muted);
	}
	.line {
		flex: 1 1 12rem;
		min-width: 0;
	}
	.use {
		flex: none;
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
		width: 8.5rem;
	}
	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
</style>
