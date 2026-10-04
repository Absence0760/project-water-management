<!--
	The two kinds of line a delineation shows, said where the eye is while
	clicking (the delineate bar and the Sub-catchments panel; docs/ui.md § Map):
	the elevation model's terrain channels, where a click goes and what the
	outline follows, and, while the River network layer is on, the mapped
	rivers, which are reference only. The operator asked "why orange and blue
	lines?" and "does the catchment follow the orange or the blue?": the Key
	listed neither the channels nor what either line is for. The same items
	(mapList.ts delineationLines) lead the Key's lines, so the words agree.
	Swatches are drawn as the map draws each line, in its colour; the words
	carry the meaning, so colour is never the only cue.
-->
<script lang="ts">
	import type { KeyItem } from './mapList';

	let { lines }: { lines: KeyItem[] } = $props();
</script>

<ul class="lines small" aria-label="Lines on the map" data-testid="map-delineation-lines">
	{#each lines as l (l.label)}
		<li data-line={l.label}>
			<span class="sw" class:dashed={l.swatch === 'dashed'} style:--c={l.colour} aria-hidden="true"></span>
			<span><strong>{l.label.charAt(0).toUpperCase() + l.label.slice(1)}</strong>{#if l.note}: {l.note}{/if}</span>
		</li>
	{/each}
</ul>

<style>
	.lines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 1.25rem;
		color: var(--text-2);
	}
	li {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
	}
	strong {
		font-weight: 600;
		color: var(--text);
	}
	/* Drawn as the map draws the line: the channels solid, the river network dashed, each in its own colour (--c). */
	.sw {
		flex: none;
		align-self: center;
		width: 1.4rem;
		height: 0;
		border-top: 3px solid var(--c);
	}
	.sw.dashed {
		border-top-style: dashed;
	}
</style>
