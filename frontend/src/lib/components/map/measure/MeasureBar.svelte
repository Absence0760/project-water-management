<!--
	The measure bar (issue #326 A7; docs/ui.md § Map, docs/maps.md § Measure):
	above the map while measuring. The result is in words here, never only on
	the canvas: the running distance as points are added, the area and
	perimeter once the shape is closed, in a polite live region. The points
	themselves are listed (by coordinates) under it. Undo, Close the shape,
	Start again and Done are the buttons the clicks and keys also reach;
	Escape anywhere in the bar (or on the map) ends the measurement.
-->
<script lang="ts">
	import { positionText } from '../mapData';
	import type { MeasureDraft } from './measureDraft.svelte';

	let { measure, ondone }: { measure: MeasureDraft; ondone: () => void } = $props();
	const uid = $props.id();
	const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	const how = $derived(
		measure.closed
			? `Drag a point to move it, ${phone ? 'tap' : 'click'} an edge’s middle to add one.`
			: `${phone ? 'Tap' : 'Click'} the map to add each point (or press Enter at the crosshair); ${phone ? 'tap' : 'click'} the first point, or Close the shape, for its area.`
	);

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			ondone();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape ends the measurement from any control inside; each control is itself interactive) -->
<section class="measure-bar" aria-labelledby="{uid}-h" data-testid="map-measure-bar" data-closed={measure.closed ? 'true' : 'false'} {onkeydown}>
	<h2 class="bar-h" id="{uid}-h">Measuring</h2>
	<p class="how small">{how}</p>
	<p class="result" role="status" data-testid="map-measure-result">{measure.result}</p>
	{#if measure.points.length}
		<details class="points small">
			<summary>The {measure.points.length === 1 ? 'point' : `${measure.points.length} points`}</summary>
			<ol data-testid="map-measure-points">
				{#each measure.points as p, i (i)}<li>{positionText(p)}</li>{/each}
			</ol>
		</details>
	{/if}
	<div class="bar-actions">
		<button type="button" class="btn btn-sm" onclick={() => measure.undo()} disabled={!measure.canUndo}>Undo</button>
		{#if !measure.closed}
			<button type="button" class="btn btn-sm" onclick={() => measure.finish()} disabled={!measure.canFinish}>Close the shape</button>
		{/if}
		<button type="button" class="btn btn-sm" onclick={() => measure.start()} disabled={!measure.points.length}>Start again</button>
		<button type="button" class="btn btn-sm btn-primary" onclick={ondone} data-testid="map-measure-done">Done</button>
	</div>
</section>

<style>
	.measure-bar {
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
	.result {
		margin: 0;
	}
	.result {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.points ol {
		margin: 0.25rem 0 0;
		padding-left: 1.4rem;
	}
	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
</style>
