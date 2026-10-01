<!--
	The Map tab's layers (issue #326 A6; docs/ui.md § Map): a toggle per
	optional layer, in the URL (`layers=quaternaries`, a history entry, so Back
	undoes it and a view can be shared). With the quaternary outlines on, the
	codes drawn are listed here as buttons (the map is never the only place to
	read them; a code picked here or on the map is drawn heavier), with the
	dataset they come from and, for the repo's invented one, that it is
	synthetic. The map labels them only when glyphs are configured.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { withLayer } from './mapLayers';
	import { quaternaryColour } from './mapStyle';
	import type { QuaternaryLayer } from './quaternaryLayer.svelte';

	let { quaternaries, dark }: { quaternaries: QuaternaryLayer; dark: boolean } = $props();
	const uid = $props.id();

	function toggle(on: boolean) {
		void goto(withLayer(page.url.search, 'quaternaries', on), { noScroll: true, keepFocus: true });
	}

	const answer = $derived(quaternaries.answer);
	const synthetic = $derived(!!answer?.quaternaries.some((q) => q.synthetic));
	const datasets = $derived([...new Set(answer?.quaternaries.map((q) => q.dataset) ?? [])]);
	const summary = $derived.by(() => {
		const n = answer?.quaternaries.length ?? 0;
		return `${n} ${n === 1 ? 'quaternary' : 'quaternaries'} around the catchment${answer?.truncated ? ' (the first by code; there are more)' : ''}, from ${datasets.join(', ')}.`;
	});
</script>

<section class="layers" aria-labelledby="{uid}-h" data-testid="map-layers">
	<h2 class="layers-h" id="{uid}-h">Layers</h2>
	<label class="toggle">
		<input type="checkbox" checked={quaternaries.on} onchange={(e) => toggle(e.currentTarget.checked)} data-testid="map-layer-quaternaries" />
		<span class="swatch" style:--qt={quaternaryColour(dark)} aria-hidden="true"></span>
		Quaternary catchments
	</label>
	{#if quaternaries.on}
		<div class="qt small" data-testid="map-quaternaries">
			{#if quaternaries.nothingAround}
				<p class="muted">Nothing on the map yet to show the quaternaries around.</p>
			{:else if quaternaries.error}
				<p class="err" role="alert">The quaternaries couldn’t be loaded: {quaternaries.error} <button type="button" class="btn btn-sm" onclick={() => quaternaries.retry()}>Try again</button></p>
			{:else if !answer}
				<p class="muted" role="status">Loading the quaternaries…</p>
			{:else if !answer.quaternaries.length}
				<p class="muted" data-testid="map-quaternaries-none">
					{answer.datasets.length ? 'No quaternary catchment in the loaded dataset is near this catchment.' : 'No quaternary dataset is loaded (docs/maps.md § Quaternary dataset).'}
				</p>
			{:else}
				<p class="muted" data-testid="map-quaternaries-summary">{summary}{#if synthetic}{' '}<strong>Synthetic test data, never real outlines.</strong>{/if}</p>
				<ul class="codes" aria-label="Quaternary catchments shown" data-testid="map-quaternary-codes">
					{#each answer.quaternaries as q (q.code)}
						<li>
							<button type="button" class="code" aria-pressed={quaternaries.picked === q.code} onclick={() => (quaternaries.picked = quaternaries.picked === q.code ? null : q.code)}>{q.code}</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</section>

<style>
	.layers {
		display: grid;
		gap: 0.35rem;
	}
	.layers-h {
		margin: 0;
		font-size: 0.95rem;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 24px;
	}
	/* The outline as the map draws it: a dashed line in the layer's colour (mapStyle.ts quaternaryColour). */
	.swatch {
		width: 1.6rem;
		height: 0;
		border-top: 2px dashed var(--qt);
		flex: none;
	}
	.qt p {
		margin: 0;
	}
	.codes {
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.code {
		min-height: 24px;
		min-width: 24px;
		padding: 0.1rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.code[aria-pressed='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		font-weight: 600;
	}
	.code:focus-visible {
		outline: 3px solid var(--focus);
		outline-offset: 2px;
	}
	.err {
		color: var(--danger);
	}
</style>
