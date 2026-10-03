<!--
	The Map tab's tools, on the map's left edge (docs/ui.md § Map): Measure
	(anyone, while the map draws), and for editors Draw a shape, Place a point,
	Delineate (with a DEM on the server; its bar chooses one catchment or
	sub-catchments) and Trace a dam (with water occurrence data on the server).
	They were identical buttons in the section header until 2026-10-02; on the
	map they sit where they act, each with its own icon and a short visible
	word, and the header keeps the page's actions. Each button's accessible
	name is the tool's full name, which starts with or contains the visible
	word (WCAG 2.5.3); pressed (`aria-pressed`) while its tool is on. A group,
	not a toolbar: Tab reaches each tool in order, as the header's did.
	The icons are drawn here (no icon set), in the text colour.
-->
<script lang="ts">
	let {
		canEdit,
		showMeasure,
		measuring,
		measureDisabled,
		drawing,
		placing,
		delineate,
		trace,
		onmeasure,
		ondraw,
		onplace,
		ondelineate,
		ontrace
	}: {
		canEdit: boolean;
		/** The map draws (WebGL): Measure needs it. */
		showMeasure: boolean;
		measuring: boolean;
		/** A drawing is open: Measure waits for it. */
		measureDisabled: boolean;
		drawing: boolean;
		placing: boolean;
		/** Offered (the server has a DEM), and whether it (or its Sub-catchments) is on. */
		delineate: { on: boolean } | null;
		/** Offered (the server has water occurrence data), and whether it is on. */
		trace: { on: boolean } | null;
		onmeasure: () => void;
		ondraw: () => void;
		onplace: () => void;
		ondelineate: () => void;
		ontrace: () => void;
	} = $props();
</script>

{#snippet icon(name: 'measure' | 'draw' | 'place' | 'delineate' | 'trace')}
	<svg class="ic" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
		{#if name === 'measure'}
			<!-- A ruler laid across. -->
			<path d="M2.8 13.6 13.6 2.8l3.6 3.6L6.4 17.2z" />
			<path d="M6.2 10.2l1.6 1.6M8.6 7.8l1.1 1.1M11 5.4l1.6 1.6" />
		{:else if name === 'draw'}
			<!-- A polygon with its corners. -->
			<path d="M4 15.5 3 7.5l6.5-4.2 7 4.4-2.8 7.8z" />
			<circle class="dot" cx="4" cy="15.5" r="1.6" />
			<circle class="dot" cx="3" cy="7.5" r="1.6" />
			<circle class="dot" cx="9.5" cy="3.3" r="1.6" />
			<circle class="dot" cx="16.5" cy="7.7" r="1.6" />
			<circle class="dot" cx="13.7" cy="15.5" r="1.6" />
		{:else if name === 'place'}
			<!-- A map pin. -->
			<path d="M10 18s-5.2-5.3-5.2-9.4a5.2 5.2 0 0 1 10.4 0C15.2 12.7 10 18 10 18z" />
			<circle cx="10" cy="8.6" r="1.9" />
		{:else if name === 'delineate'}
			<!-- A catchment's divide (dashed) round a river that gathers to its outlet. -->
			<path class="dash" d="M10 18.2C5 15.6 2.2 11 3.2 6.6 4 3.4 7 1.8 10 1.8s6 1.6 6.8 4.8c1 4.4-1.8 9-6.8 11.6z" />
			<path d="M10 18V11M10 11 6.6 6.2M10 11l3.6-4.4M8 8.2 5.6 8.8" />
		{:else}
			<!-- A dam's water inside the outline traced round it. -->
			<path class="dash" d="M3.5 4.5h13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14V6a1.5 1.5 0 0 1 1.5-1.5z" />
			<path d="M5 9c1.2-1 2.2-1 3.3 0s2.1 1 3.3 0 2.1-1 3.4 0M5 12.2c1.2-1 2.2-1 3.3 0s2.1 1 3.3 0 2.1-1 3.4 0" />
		{/if}
	</svg>
{/snippet}

<div class="tools" role="group" aria-label="Map tools" data-testid="map-tools">
	{#if showMeasure}
		<button type="button" class="tool" onclick={onmeasure} aria-pressed={measuring} disabled={measureDisabled} title="Measure a distance or an area" data-testid="map-start-measure">
			{@render icon('measure')}<span class="word">Measure</span>
		</button>
	{/if}
	{#if canEdit}
		<button type="button" class="tool" onclick={ondraw} aria-pressed={drawing} aria-label="Draw a shape" title="Draw a shape: a boundary, parcel, dam, river or other" data-testid="map-start-draw">
			{@render icon('draw')}<span class="word" aria-hidden="true">Draw</span>
		</button>
		<button type="button" class="tool" onclick={onplace} aria-pressed={placing} aria-label="Place a point" title="Place a point: a gauge, dam or other" data-testid="map-start-place">
			{@render icon('place')}<span class="word" aria-hidden="true">Point</span>
		</button>
		{#if delineate}
			<button type="button" class="tool" onclick={ondelineate} aria-pressed={delineate.on} title="Delineate a catchment from its outlet, or sub-catchments one per click" data-testid="map-start-delineate">
				{@render icon('delineate')}<span class="word">Delineate</span>
			</button>
		{/if}
		{#if trace}
			<button type="button" class="tool" onclick={ontrace} aria-pressed={trace.on} aria-label="Trace a dam" title="Trace a dam’s outline from the water seen in satellite images" data-testid="map-start-trace">
				{@render icon('trace')}<span class="word" aria-hidden="true">Trace</span>
			</button>
		{/if}
	{/if}
</div>

<style>
	/* A column of tools over the map's left edge, on the map's own surface so it reads on any basemap. */
	.tools {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 3px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
	}
	.tool {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		width: 4.4rem;
		min-height: 46px;
		padding: 4px 2px;
		border: 1px solid transparent;
		border-radius: calc(var(--radius-sm) - 1px);
		background: none;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.tool:hover:not(:disabled) {
		background: var(--surface-2, var(--bg));
	}
	.tool[aria-pressed='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.tool:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
	}
	.tool:focus-visible {
		outline: 3px solid var(--focus);
		outline-offset: -1px;
	}
	.word {
		font-size: 0.78rem;
		line-height: 1.1;
		font-weight: 500;
	}
	.ic {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.ic .dot {
		fill: var(--surface);
	}
	.ic .dash {
		stroke-dasharray: 2.4 2;
	}
</style>
