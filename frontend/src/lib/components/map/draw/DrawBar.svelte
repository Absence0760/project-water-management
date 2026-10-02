<!--
	The draw bar (issue #326 C1, D1; docs/ui.md § Map): above the map while a
	shape is drawn, a point placed or a feature's shape edited. It says what is
	being made and how, names the last change (a polite live region), and holds
	the buttons the keys and clicks also reach: Undo, Finish, Save, Cancel,
	and the ways in that need no pointer: Paste a shape, Enter coordinates.
	Use my location shows on phones (asked only on the tap; the position goes
	no further than the point). Escape anywhere in the bar cancels (asking
	first when a drawing would be lost: Draft.escape); Cancel drops it at once.
-->
<script lang="ts">
	import type { MapPosition } from '$lib/api/types';
	import { KIND_LABEL, POINT_KINDS } from '../mapData';
	import type { Draft } from './draft.svelte';
	import { draftProblem, DRAW_CHOICES } from './shape';

	let {
		draft,
		mapReady,
		saving = false,
		error = null,
		onsave,
		onpaste,
		oncoords,
		onlocated,
		delineating = false
	}: {
		draft: Draft;
		/** false without WebGL: no clicks to place, so the bar leads with pasting and typed coordinates. */
		mapReady: boolean;
		saving?: boolean;
		error?: string | null;
		/** Save: a new shape opens its sheet, a new point the Place sheet, an edit saves at once. */
		onsave: () => void;
		onpaste: () => void;
		oncoords: () => void;
		onlocated: (at: MapPosition) => void;
		/** The point placed is a delineation's outlet (#326 B-delineate): no kind to pick, and Save asks the server to delineate. */
		delineating?: boolean;
	} = $props();

	const uid = $props.id();
	const problem = $derived(draft.whole ? null : draft.phase === 'review' || draft.shape === 'point' ? draftProblem(draft.shape, draft.coords) : null);
	const editing = $derived(draft.mode === 'edit');
	const name = $derived(draft.feature ? draft.feature.name || KIND_LABEL[draft.feature.kind] : '');
	const corner = $derived(draft.cornerWord);

	// Use my location: on a phone (a coarse pointer or a narrow window) with geolocation, asked only when tapped.
	const phone = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 700px)').matches);
	const canLocate = phone && typeof navigator !== 'undefined' && 'geolocation' in navigator;
	let locating = $state(false);
	let locateError = $state<string | null>(null);
	function locate() {
		locating = true;
		locateError = null;
		navigator.geolocation.getCurrentPosition(
			(p) => {
				locating = false;
				const at: MapPosition = [Math.round(p.coords.longitude * 1e7) / 1e7, Math.round(p.coords.latitude * 1e7) / 1e7];
				draft.add(at);
				onlocated(at);
			},
			(e) => {
				locating = false;
				locateError =
					e.code === e.PERMISSION_DENIED
						? 'The browser wasn’t allowed to share your location. Tap the map where the point goes, or enter its coordinates.'
						: 'Your location couldn’t be found. Tap the map where the point goes, or enter its coordinates.';
			},
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
		);
	}

	const howTo = $derived.by(() => {
		if (!mapReady) return draft.shape === 'point' ? 'The map can’t be drawn here: enter the point’s coordinates.' : 'The map can’t be drawn here: paste the shape as GeoJSON or WKT.';
		if (draft.whole) return 'A pasted shape of several parts: save it as it is, or paste another.';
		if (draft.shape === 'point' && delineating) {
			return draft.coords.length
				? `Drag the point onto the river if it missed, then Delineate…`
				: `${phone ? 'Tap' : 'Click'} the river at the catchment’s outlet, or just below a dam wall.`;
		}
		if (draft.shape === 'point') {
			return draft.coords.length
				? `Drag the point to adjust it, or ${phone ? 'tap' : 'click'} somewhere else to move it; then save.`
				: `${phone ? 'Tap' : 'Click'} the map where the ${KIND_LABEL[draft.kind].toLowerCase()} goes.`;
		}
		if (draft.phase === 'drawing') {
			return draft.shape === 'polygon'
				? `${phone ? 'Tap' : 'Click'} the map to add each corner; ${phone ? 'tap' : 'click'} the first corner (or Finish) to close the shape.`
				: `${phone ? 'Tap' : 'Click'} the map to add each point along it; ${phone ? 'tap' : 'click'} the last point again (or Finish) to end the line.`;
		}
		return `Drag a ${corner.one} to move it, ${phone ? 'tap' : 'click'} an edge’s middle to add one, pick a ${corner.one} and press Delete to remove it.`;
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !(e.target instanceof HTMLSelectElement)) {
			e.preventDefault();
			void draft.escape();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape cancels from any control inside; each control is itself interactive) -->
<section class="draw-bar" aria-labelledby="{uid}-h" data-testid="map-draw-bar" data-phase={draft.phase} {onkeydown}>
	<div class="bar-head">
		{#if draft.mode === 'draw'}
			<h2 class="bar-h" id="{uid}-h"><label for="{uid}-what">Drawing</label></h2>
			<select id="{uid}-what" class="cap" value={draft.choice} onchange={(e) => draft.choose(e.currentTarget.value)}>
				{#each DRAW_CHOICES as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
			</select>
		{:else if draft.mode === 'place' && delineating}
			<h2 class="bar-h" id="{uid}-h">Delineating a catchment</h2>
		{:else if draft.mode === 'place'}
			<h2 class="bar-h" id="{uid}-h"><label for="{uid}-what">Placing a point</label></h2>
			<select id="{uid}-what" class="cap" value={draft.kind} onchange={(e) => (draft.kind = e.currentTarget.value as typeof draft.kind)}>
				{#each POINT_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
			</select>
		{:else}
			<h2 class="bar-h" id="{uid}-h">{draft.shape === 'point' ? 'Moving' : 'Editing'} “{name}”</h2>
		{/if}
	</div>
	<p class="how small" data-testid="map-draw-how">{howTo}</p>
	<p class="said small muted" role="status" data-testid="map-draw-said">{draft.said}</p>
	{#if problem && (draft.phase === 'review' || draft.coords.length)}<p class="problem small" data-testid="map-draw-problem">{problem}</p>{/if}
	{#if locateError}<p class="problem small" role="alert">{locateError}</p>{/if}
	{#if error}<p class="problem small" role="alert" data-testid="map-draw-error">{error}</p>{/if}
	<div class="bar-actions">
		{#if canLocate && draft.mode === 'place'}
			<button type="button" class="btn btn-sm" onclick={locate} disabled={locating} data-testid="map-use-location">{locating ? 'Finding you…' : 'Use my location'}</button>
		{/if}
		{#if draft.shape === 'point'}
			<button type="button" class="btn btn-sm" onclick={oncoords} data-testid="map-enter-coordinates">Enter coordinates</button>
		{:else}
			<button type="button" class="btn btn-sm" onclick={onpaste} data-testid="map-paste-shape">Paste a shape</button>
		{/if}
		<button type="button" class="btn btn-sm" onclick={() => draft.undo()} disabled={!draft.canUndo}>Undo</button>
		{#if draft.phase === 'drawing' && draft.shape !== 'point'}
			<button type="button" class="btn btn-sm" onclick={() => draft.finish()} disabled={!draft.canFinish}>Finish</button>
		{/if}
		{#if draft.phase === 'review' && draft.corner !== null && draft.shape !== 'point'}
			<button type="button" class="btn btn-sm" onclick={() => draft.corner !== null && draft.removeCorner(draft.corner)}>Remove the picked {corner.one}</button>
		{/if}
		<button type="button" class="btn btn-sm btn-ghost" onclick={() => draft.cancel()}>Cancel</button>
		{#if draft.phase === 'review'}
			<button type="button" class="btn btn-sm btn-primary" onclick={onsave} disabled={!!problem || saving || !draft.geometry} data-testid="map-draft-save">
				{saving ? 'Saving…' : editing ? (draft.shape === 'point' ? 'Save the position' : 'Save the shape') : delineating ? 'Delineate…' : 'Save…'}
			</button>
		{/if}
	</div>
</section>

<style>
	.draw-bar {
		display: grid;
		gap: 0.3rem;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}
	.bar-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.bar-h {
		margin: 0;
		font-size: 0.95rem;
	}
	.cap {
		max-width: min(100%, 16rem);
	}
	.how,
	.said,
	.problem {
		margin: 0;
	}
	.problem {
		color: var(--danger);
	}
	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
</style>
