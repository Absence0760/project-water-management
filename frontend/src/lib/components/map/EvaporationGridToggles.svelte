<!--
	The Map tab's A-pan and S-pan grid toggles (docs/maps.md § A-pan and S-pan
	grids), in the Layers box beside the MAP grid: each its own toggle
	(`layers=apangrid`, `spangrid`), and while on, what it draws in view: the
	year's total or a month picked under Show, the grid picked when more than
	one of the kind is loaded, the A-pan grid said to be modelled where it is
	and the S-pan grid a cross-check the model never uses, and a plain line
	when none is loaded. Its own chunk, with the layers' state class, which
	MapTab loads after the tab (the workspace tab chunk is at its budget,
	scripts/guards/check_web_bundle_budget.mjs); MapLayers renders it.
-->
<script lang="ts" module>
	import { EvaporationGridLayer } from './evaporationGridLayer.svelte';
	import type { Component } from 'svelte';
	import type { MapLayer } from './mapLayers';

	export { EvaporationGridLayer };
	export { EVAPORATION_GRID_LAYER } from './evaporationGrid';

	export interface TogglesProps {
		grids: readonly EvaporationGridLayer[];
		/** The map writes labels (glyphs are configured). */
		labels: boolean;
		ontoggle: (layer: MapLayer, on: boolean) => void;
		/** Try again after an error; the focus follows to `checkbox` once loaded (MapLayers retryLayer). */
		onretry: (e: MouseEvent, layer: { retry(): void }, checkbox: string) => void;
	}

	/** The layers' state and this component, as MapTab hands them to MapLayers. */
	export interface EvaporationGrids {
		grids: readonly EvaporationGridLayer[];
		Toggles: Component<TogglesProps>;
	}
</script>

<script lang="ts">
	import { fmtNum } from '#lib/format/number.js';
	import { EVAPORATION_GRID_LABEL, EVAPORATION_GRID_LAYER, EVAPORATION_GRID_MONTHS, evaporationGridWhat, evaporationMonthLabel, evaporationValueWords } from './evaporationGrid';
	import { MAP_GRID_BBOX_MAX_DEG, mapLabel } from './mapLayers';
	import { APAN_RAMP, SPAN_RAMP } from './mapStyle';

	let { grids, labels, ontoggle, onretry }: TogglesProps = $props();

	const degrees = (d: number) => fmtNum(d, d < 0.01 ? 4 : 3, true);
	/** Each grid's swatch: its ramp, lowest first. */
	const evapGradient = { apan: `linear-gradient(90deg, ${APAN_RAMP.map(([, c]) => c).join(', ')})`, span: `linear-gradient(90deg, ${SPAN_RAMP.map(([, c]) => c).join(', ')})` };
	/** A grid's summary: how many points from which grid, what they are, and their range. */
	function summary(layer: EvaporationGridLayer): string {
		const a = layer.answer;
		if (!a?.dataset) return '';
		const n = a.cells.length;
		const r = layer.range ? `: ${mapLabel(layer.range[0])} to ${mapLabel(layer.range[1])}` : '';
		return `${fmtNum(n, 0, true)} ${n === 1 ? 'point' : 'points'} in view from ${a.dataset.dataset} (${degrees(a.dataset.cellDeg)}° cells, ${a.dataset.firstYear !== null && a.dataset.lastYear !== null ? `${a.dataset.firstYear}–${a.dataset.lastYear} means` : 'means for no stated period'}), ${evaporationValueWords(a.month)}${r}.`;
	}
</script>

{#each grids as eg (eg.kind)}
	{@const id = EVAPORATION_GRID_LAYER[eg.kind]}
	{@const word = EVAPORATION_GRID_LABEL[eg.kind]}
	{@const ea = eg.answer}
	<label class="check">
		<input type="checkbox" checked={eg.on} onchange={(e) => ontoggle(id, e.currentTarget.checked)} data-testid="map-layer-{id}" />
		<span class="ramp-swatch" style:--ramp={evapGradient[eg.kind]} aria-hidden="true"></span>
		{word}
	</label>
	{#if eg.on}
		<div class="qt small" data-testid="map-{id}">
			{#if eg.zoomIn}
				<p class="muted" data-testid="map-{id}-zoom">Zoom in to see the {word} (to about {MAP_GRID_BBOX_MAX_DEG}° across).</p>
			{:else if eg.error}
				<p class="err" role="alert">The {word} couldn’t be loaded: {eg.error} <button type="button" class="btn btn-sm" data-retry onclick={(e) => onretry(e, eg, `map-layer-${id}`)}>Try again</button></p>
			{:else if !ea}
				<p class="muted" data-loading>Loading the {word}…</p>
			{:else if !ea.dataset}
				<p class="muted" data-testid="map-{id}-none">
					There’s no {word} on this server yet, so there is nothing to draw.
				</p>
			{:else}
				{#if ea.datasets.length > 1}
					<label class="pick">
						Grid
						<select value={ea.dataset.dataset} onchange={(e) => eg.pick(e.currentTarget.value)} data-testid="map-{id}-dataset">
							{#each ea.datasets as d (d.dataset)}<option value={d.dataset}>{d.dataset} ({degrees(d.cellDeg)}°){d.synthetic ? ', synthetic' : ''}</option>{/each}
						</select>
					</label>
				{/if}
				<label class="pick">
					Show
					<select value={eg.month === null ? '' : String(eg.month)} onchange={(e) => eg.pickMonth(e.currentTarget.value ? Number(e.currentTarget.value) : null)} data-testid="map-{id}-month">
						{#each EVAPORATION_GRID_MONTHS as m (m ?? 0)}<option value={m === null ? '' : String(m)}>{evaporationMonthLabel(m)}</option>{/each}
					</select>
				</label>
				{#if ea.tooDense}
					<p class="muted" data-testid="map-{id}-dense">This view holds more than {fmtNum(ea.max, 0, true)} of the grid’s points: zoom in to see them.</p>
				{:else if !ea.cells.length}
					<p class="muted" data-testid="map-{id}-empty">The grid has no point in this view.</p>
				{:else}
					<p class="muted" data-testid="map-{id}-summary">
						{summary(eg)}{#if ea.dataset.synthetic}{' '}<strong>Synthetic test data, never real evaporation.</strong>{/if}{labels ? ' Each point’s value shows beside it once you zoom in far enough.' : ' The map has no fonts for labels here, so it shows the points without their values.'}
					</p>
				{/if}
				<p class="muted" data-testid="map-{id}-source">
					{evaporationGridWhat(ea.dataset)} Source: {ea.dataset.source}{!ea.dataset.synthetic && ea.dataset.attribution && ea.dataset.attribution !== ea.dataset.source ? `${/[.!?]$/.test(ea.dataset.source) ? '' : '.'} Credit: ${ea.dataset.attribution}` : ''}
				</p>
			{/if}
		</div>
	{/if}
{/each}

<style>
	.check {
		min-height: 24px;
	}
	/* The grid's ramp, lowest to highest (mapStyle.ts APAN_RAMP, SPAN_RAMP), as MapLayers draws the MAP grid's. */
	.ramp-swatch {
		width: 1.6rem;
		height: 0.8rem;
		flex: none;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
		background: var(--ramp);
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.25rem 0;
	}
	.qt p {
		margin: 0;
	}
	.err {
		color: var(--danger);
	}
</style>
