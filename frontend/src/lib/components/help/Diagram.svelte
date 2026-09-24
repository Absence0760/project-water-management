<script lang="ts">
	// A guide diagram: inline SVG (./diagrams), drawn with the app's colour
	// tokens so it follows the light and dark themes, in a box that scrolls
	// sideways on a phone rather than shrinking the text to nothing. Each SVG
	// is role="img" with a full text description as its aria-label; the
	// caption is visible to everyone.
	//
	// The shared vocabulary below (box, t, s, m, wire, head, …) is the only
	// styling the diagrams use, so a diagram needs no style block of its own.
	import type { Component } from 'svelte';
	import type { DiagramId } from '$lib/help/guides';
	import CalibrationLoop from './diagrams/CalibrationLoop.svelte';
	import FarmDay from './diagrams/FarmDay.svelte';
	import Gr4j from './diagrams/Gr4j.svelte';
	import Network from './diagrams/Network.svelte';
	import Pipeline from './diagrams/Pipeline.svelte';
	import RainSources from './diagrams/RainSources.svelte';
	import Validation from './diagrams/Validation.svelte';
	import Workflow from './diagrams/Workflow.svelte';

	const DIAGRAMS: Record<DiagramId, Component> = {
		workflow: Workflow,
		network: Network,
		pipeline: Pipeline,
		'farm-day': FarmDay,
		gr4j: Gr4j,
		'calibration-loop': CalibrationLoop,
		validation: Validation,
		'rain-sources': RainSources
	};

	let { id, caption }: { id: DiagramId; caption: string } = $props();
	const Body = $derived(DIAGRAMS[id]);
</script>

<figure class="diagram" data-diagram={id}>
	<div class="scroll" data-scroll-region data-scroll-label="Diagram">
		<Body />
	</div>
	{#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
	.diagram {
		margin: 1rem 0 1.25rem;
		padding: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.scroll {
		overflow-x: auto;
	}
	figcaption {
		margin-top: 0.5rem;
		color: var(--text-2);
		font-size: 0.875rem;
	}
	/* --- diagram vocabulary (begin) --- */
	.diagram :global(svg) {
		display: block;
		width: 100%;
		min-width: 600px;
		height: auto;
		font-family: var(--font-sans);
	}
	.diagram :global(.box) {
		fill: var(--surface-2);
		stroke: var(--border-strong);
		stroke-width: 1;
	}
	.diagram :global(.box.key) {
		fill: var(--accent-soft);
		stroke: var(--accent);
	}
	.diagram :global(.box.opt) {
		stroke-dasharray: 5 4;
	}
	.diagram :global(.box.fit) {
		fill: var(--accent-soft);
		stroke: var(--accent);
	}
	.diagram :global(.box.test) {
		fill: var(--warning-soft);
		stroke: var(--warning);
	}
	.diagram :global(.box.band) {
		fill: var(--row-hover);
		stroke: var(--accent);
	}
	.diagram :global(.t) {
		fill: var(--text);
		font-size: 13px;
		font-weight: 600;
	}
	.diagram :global(.s) {
		fill: var(--text-2);
		font-size: 11.5px;
	}
	.diagram :global(.m) {
		fill: var(--text-muted);
		font-size: 11px;
	}
	.diagram :global(.wire) {
		fill: none;
		stroke: var(--text-2);
		stroke-width: 1.5;
	}
	.diagram :global(.wire.loop) {
		stroke: var(--accent);
		stroke-dasharray: 6 4;
	}
	.diagram :global(.wire.transfer) {
		stroke: var(--warning);
		stroke-dasharray: 6 4;
	}
	.diagram :global(.river) {
		fill: none;
		stroke: var(--brand-outlet);
		stroke-linecap: round;
	}
	.diagram :global(.head) {
		fill: var(--text-2);
	}
	.diagram :global(.head.loop) {
		fill: var(--accent);
	}
	.diagram :global(.head.transfer) {
		fill: var(--warning);
	}
	.diagram :global(.node) {
		fill: var(--brand-node);
	}
	.diagram :global(.node-open) {
		fill: var(--surface);
		stroke: var(--brand-node);
		stroke-width: 2;
	}
	.diagram :global(.outlet) {
		fill: var(--brand-outlet);
	}
	.diagram :global(.bar) {
		fill: var(--series-1);
	}
	.diagram :global(.water) {
		fill: var(--accent);
		opacity: 0.3;
	}
	.diagram :global(.excl) {
		fill: var(--danger-soft);
		stroke: var(--danger);
		stroke-dasharray: 3 2;
	}
	/* --- diagram vocabulary (end) --- */
</style>
