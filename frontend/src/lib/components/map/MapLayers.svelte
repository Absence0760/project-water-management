<!--
	The Map tab's layers (issue #326 A6; docs/ui.md § Map): a toggle per
	optional layer, in the URL (`layers=quaternaries`, a history entry, so Back
	undoes it and a view can be shared). With the quaternary outlines on, the
	codes drawn are listed here as buttons (the map is never the only place to
	read them; a code picked here or on the map is drawn heavier), with the
	dataset they come from and, for the repo's invented one, that it is
	synthetic. The map labels them only when glyphs are configured. With a DEM
	configured (PUBLIC_TERRAIN_URL, docs/maps.md § Relief) a Relief toggle
	shades the land (`layers=relief`); without one it isn't offered. The River
	network (`layers=rivers`, issue #345, docs/maps.md § River network) lists
	the reaches around the catchment, biggest first; a reach picked here or on
	the map shows its facts and source, and an editor adds it to the project
	as a river (one reach at a time: the layer proposes, the modeller decides).
	Hydrological units (`layers=units`, docs/maps.md § Hydrological units
	layer) outlines each unit's polygon and writes its name on it, listed here
	too; the MAP grid (`layers=mapgrid`, § MAP grid) draws one loaded mean
	annual precipitation grid's points in view, each labelled with its MAP,
	with a dataset picker when more than one is loaded; the CHIRPS grid
	(`layers=chirps`, § CHIRPS grid) draws CHIRPS v3's 0.05° cells and their
	centres, where its daily rainfall values sit.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { MapFeature } from '$lib/api';
	import { fmtNum } from '$lib/format/number';
	import {
		CHIRPS_CELL_DEG,
		CHIRPS_MAX_POINTS,
		type ChirpsCell,
		MAP_GRID_BBOX_MAX_DEG,
		type MapLayer,
		layersStatus,
		mapLabel,
		reachFacts,
		reachKey,
		reachLabel,
		RIVER_BBOX_MAX_DEG,
		type UnitLabel,
		withLayer
	} from './mapLayers';
	import { chirpsColour, MAP_RAMP, overlayColours, quaternaryColour, riverNetworkColour } from './mapStyle';
	import type { MapGridLayer } from './mapGridLayer.svelte';
	import { AREA_FILL_STEP, type AreaFill } from './areaFill.svelte';
	import type { QuaternaryLayer } from './quaternaryLayer.svelte';
	import type { RiverLayer } from './riverLayer.svelte';

	let {
		quaternaries,
		rivers,
		dark,
		canEdit = false,
		onriveradded,
		onshowfeature,
		relief = null,
		units = null,
		mapGrid = null,
		chirps = null,
		labels = true,
		areaFill = null
	}: {
		quaternaries: QuaternaryLayer;
		rivers: RiverLayer;
		dark: boolean;
		/** An editor adds reaches to the project; a viewer reads them. */
		canEdit?: boolean;
		/** A reach was added as the project's river feature. */
		onriveradded?: (feature: MapFeature) => void;
		/** Show a feature (an added reach's) on the map and in the card. */
		onshowfeature?: (id: string) => void;
		/** The Relief layer: whether it is on and whether its DEM failed to load. Null: no DEM configured, no toggle. */
		relief?: { on: boolean; failed: boolean } | null;
		/** The Hydrological units layer: whether it is on, and the units it labels. Null: no toggle. */
		units?: { on: boolean; labels: readonly UnitLabel[] } | null;
		/** The MAP grid layer's state. Null: no toggle. */
		mapGrid?: MapGridLayer | null;
		/** The CHIRPS grid layer: whether it is on, and the cells in view (null: the view is too wide). Null: no toggle. */
		chirps?: { on: boolean; cells: readonly ChirpsCell[] | null } | null;
		/** The map writes labels (glyphs are configured); without, the lists here are the only place to read them. */
		labels?: boolean;
		/** The Area fill slider's state (areaFill.svelte.ts): how strongly the polygons are filled. Null: no slider. */
		areaFill?: AreaFill | null;
	} = $props();
	const uid = $props.id();

	function toggle(layer: MapLayer, on: boolean) {
		void goto(withLayer(page.url.search, layer, on), { noScroll: true, keepFocus: true });
	}

	const answer = $derived(quaternaries.answer);
	const synthetic = $derived(!!answer?.quaternaries.some((q) => q.synthetic));
	const datasets = $derived([...new Set(answer?.quaternaries.map((q) => q.dataset) ?? [])]);
	const summary = $derived.by(() => {
		const n = answer?.quaternaries.length ?? 0;
		return `${n} ${n === 1 ? 'quaternary' : 'quaternaries'} around the catchment${answer?.truncated ? ' (the first by code; there are more)' : ''}, from ${datasets.join(', ')}.`;
	});

	/** How many reaches the list shows before "Show all": the biggest rivers, which come first. */
	const REACHES_SHOWN = 12;
	let allReaches = $state(false);
	const rv = $derived(rivers.answer);
	const rvSynthetic = $derived(!!rv?.reaches.some((r) => r.synthetic));
	const rvSummary = $derived.by(() => {
		const n = rv?.reaches.length ?? 0;
		const sets = [...new Set(rv?.reaches.map((r) => r.dataset) ?? [])];
		return `${n} ${n === 1 ? 'reach' : 'reaches'} around the catchment, the biggest first${rv?.truncated ? ' (the smallest streams left out; there are more)' : ''}, from ${sets.join(', ')}.`;
	});
	const shownReaches = $derived(rv ? (allReaches ? rv.reaches : rv.reaches.slice(0, REACHES_SHOWN)) : []);
	const pickedReach = $derived(rivers.pickedReach);
	const pickedFeature = $derived(pickedReach ? rivers.featureFor(pickedReach) : null);

	const mg = $derived(mapGrid?.answer ?? null);
	const mgRange = $derived(mapGrid?.range ?? null);
	const degrees = (d: number) => fmtNum(d, d < 0.01 ? 4 : 3, true);
	const mgSummary = $derived.by(() => {
		if (!mg?.dataset) return '';
		const n = mg.cells.length;
		const r = mgRange ? `: ${mapLabel(mgRange[0])} to ${mapLabel(mgRange[1])}` : '';
		return `${fmtNum(n, 0, true)} ${n === 1 ? 'point' : 'points'} in view from ${mg.dataset.dataset} (${degrees(mg.dataset.cellDeg)}° cells)${r}.`;
	});
	/** The ramp's swatch: the MAP colours left to right, lowest first. */
	const rampGradient = `linear-gradient(90deg, ${MAP_RAMP.map(([, c]) => c).join(', ')})`;

	const status = $derived(
		layersStatus(
			{ on: quaternaries.on, idle: quaternaries.nothingAround, failed: !!quaternaries.error, count: answer ? answer.quaternaries.length : null },
			{ on: rivers.on, idle: rivers.nothingAround, failed: !!rivers.error, count: rv ? rv.reaches.length : null },
			pickedReach ? reachLabel(pickedReach) : null,
			[
				units?.on ? `${units.labels.length} ${units.labels.length === 1 ? 'hydrological unit' : 'hydrological units'} labelled.` : null,
				mapGrid?.on && !mapGrid.zoomIn && !mapGrid.error
					? mg
						? mg.tooDense
							? 'Too many MAP grid points in view: zoom in.'
							: `${mg.cells.length} MAP grid ${mg.cells.length === 1 ? 'point' : 'points'} shown.`
						: 'Loading the MAP grid…'
					: null,
				chirps?.on && chirps.cells ? `${chirps.cells.length} CHIRPS grid ${chirps.cells.length === 1 ? 'point' : 'points'} shown.` : null
			]
		)
	);

	async function addPicked() {
		if (!pickedReach) return;
		const f = await rivers.add(pickedReach);
		if (f) onriveradded?.(f);
	}
</script>

<section class="layers" aria-labelledby="{uid}-h" data-testid="map-layers">
	<h2 class="layers-h" id="{uid}-h">Layers</h2>
	<p class="visually-hidden" role="status" data-testid="map-layers-status">{status}</p>
	{#if areaFill}
		<div class="fill-row" data-testid="map-area-fill">
			<label for="{uid}-fill">Area fill</label>
			<input
				id="{uid}-fill"
				type="range"
				min="0"
				max="100"
				step={AREA_FILL_STEP}
				value={areaFill.percent}
				aria-valuetext={`${areaFill.percent} %`}
				aria-describedby="{uid}-fill-note"
				oninput={(e) => areaFill.set(e.currentTarget.value)}
				data-testid="map-area-fill-slider"
			/>
			<!-- Not an <output>: that is a live region, and the box keeps one (WCAG 4.1.3); the slider says its value itself (aria-valuetext). -->
			<span class="fill-value" aria-hidden="true" data-testid="map-area-fill-value">{areaFill.percent} %</span>
			<p class="muted small" id="{uid}-fill-note">How strongly units, dams and results colours are filled; outlines stay. Lower it to see the map, relief and grids through them.</p>
		</div>
	{/if}
	<div class="tip-row">
		<label class="toggle">
			<input type="checkbox" checked={quaternaries.on} onchange={(e) => toggle('quaternaries', e.currentTarget.checked)} data-testid="map-layer-quaternaries" />
			<span class="swatch" style:--qt={quaternaryColour(dark)} aria-hidden="true"></span>
			Quaternary catchments
		</label>
		<HelpTip key="quaternary-lookup" label="About the quaternary catchments" />
	</div>
	{#if quaternaries.on}
		<div class="qt small" data-testid="map-quaternaries">
			{#if quaternaries.nothingAround}
				<p class="muted">Nothing on the map yet to show the quaternaries around.</p>
			{:else if quaternaries.error}
				<p class="err" role="alert">The quaternaries couldn’t be loaded: {quaternaries.error} <button type="button" class="btn btn-sm" onclick={() => quaternaries.retry()}>Try again</button></p>
			{:else if !answer}
				<p class="muted">Loading the quaternaries…</p>
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
	<div class="tip-row">
		<label class="toggle">
			<input type="checkbox" checked={rivers.on} onchange={(e) => toggle('rivers', e.currentTarget.checked)} data-testid="map-layer-rivers" />
			<span class="swatch rn-swatch" style:--rn={riverNetworkColour(dark)} aria-hidden="true"></span>
			River network
		</label>
		<HelpTip key="river-network" />
	</div>
	{#if rivers.on}
		<div class="qt small" data-testid="map-rivers">
			{#if rivers.nothingAround}
				<p class="muted">Zoom in to see the river network here (to about {RIVER_BBOX_MAX_DEG}° across), or draw the catchment.</p>
			{:else if rivers.error}
				<p class="err" role="alert">The river network couldn’t be loaded: {rivers.error} <button type="button" class="btn btn-sm" onclick={() => rivers.retry()}>Try again</button></p>
			{:else if !rv}
				<p class="muted">Loading the river network…</p>
			{:else if !rv.reaches.length}
				<p class="muted" data-testid="map-rivers-none">
					{rv.datasets.length ? (rivers.aroundFeatures ? 'No reach of the loaded river network is near this catchment.' : 'No reach of the loaded river network is in view.') : 'No river network is loaded (docs/maps.md § River network).'}
				</p>
			{:else}
				<p class="muted" data-testid="map-rivers-summary">{rvSummary}{#if rvSynthetic}{' '}<strong>Synthetic test data, never real rivers.</strong>{/if}</p>
				{#if pickedReach}
					<div class="reach" data-testid="map-reach-picked">
						<p class="reach-h"><strong>{reachLabel(pickedReach)}</strong>{#if reachFacts(pickedReach).length}: {reachFacts(pickedReach).join(', ')}{/if}.</p>
						<p class="muted">Source: {pickedReach.source}</p>
						{#if pickedFeature}
							<p>
								On the map as a river.
								{#if onshowfeature}<button type="button" class="btn btn-sm" onclick={() => onshowfeature(pickedFeature.id)} data-testid="map-reach-show">Show it</button>{/if}
							</p>
						{:else if canEdit}
							<p>
								<button type="button" class="btn btn-sm btn-primary" disabled={rivers.adding !== null} onclick={addPicked} data-testid="map-reach-add">
									{rivers.adding ? 'Adding…' : 'Add to the map as a river'}
								</button>
							</p>
							<p class="muted">It becomes one of this project’s rivers, which the map’s checks measure the gauges against.</p>
						{/if}
						{#if rivers.addError}<p class="err" role="alert">{rivers.addError}</p>{/if}
					</div>
				{/if}
				<ul class="codes reaches" aria-label="River reaches shown" data-testid="map-reach-list">
					{#each shownReaches as r (reachKey(r))}
						<li>
							<button type="button" class="code" aria-pressed={rivers.picked === reachKey(r)} onclick={() => rivers.pick(reachKey(r))}>
								{reachLabel(r)}{#if r.strahler !== null}<span class="order">{` · order ${r.strahler}`}</span>{/if}{#if r.upstreamKm2 !== null}<span class="order">{` · ${fmtNum(r.upstreamKm2, r.upstreamKm2 < 100 ? 1 : 0, true)} km²`}</span>{/if}{#if rivers.featureFor(r)}<span class="on-map">{' · on the map'}</span>{/if}
							</button>
						</li>
					{/each}
				</ul>
				{#if rv.reaches.length > REACHES_SHOWN}
					<button type="button" class="btn btn-sm btn-ghost" aria-expanded={allReaches} onclick={() => (allReaches = !allReaches)} data-testid="map-reach-all">
						{allReaches ? 'Show the biggest only' : `Show all ${rv.reaches.length}`}
					</button>
				{/if}
			{/if}
		</div>
	{/if}
	{#if units}
		<label class="toggle">
			<input type="checkbox" checked={units.on} onchange={(e) => toggle('units', e.currentTarget.checked)} data-testid="map-layer-units" />
			<span class="swatch units-swatch" style:--un={overlayColours(dark).parcel} aria-hidden="true"></span>
			Hydrological units
		</label>
		{#if units.on}
			<div class="qt small" data-testid="map-units">
				{#if !units.labels.length}
					<p class="muted" data-testid="map-units-none">No hydrological unit polygons on the map yet: upload or draw each unit’s sub-catchment as a farm parcel linked to its unit.</p>
				{:else}
					<p class="muted" data-testid="map-units-summary">
						{units.labels.length} {units.labels.length === 1 ? 'unit' : 'units'}, each outlined and named on the map{labels ? '' : ' (the map has no fonts for labels here, so read the names below)'}.
					</p>
					<ul class="codes reaches" aria-label="Hydrological units on the map" data-testid="map-unit-list">
						{#each units.labels as u (u.featureId)}
							<li>
								{#if onshowfeature}
									<button type="button" class="code" onclick={() => onshowfeature(u.featureId)}>
										{u.label}{#if u.polygonName}<span class="order">{` · “${u.polygonName}”`}</span>{/if}{#if u.areaKm2 !== null}<span class="order">{` · ${fmtNum(u.areaKm2, 2, true)} km²`}</span>{/if}
									</button>
								{:else}
									<span class="code">{u.label}</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
	{/if}
	{#if mapGrid}
		<label class="toggle">
			<input type="checkbox" checked={mapGrid.on} onchange={(e) => toggle('mapgrid', e.currentTarget.checked)} data-testid="map-layer-mapgrid" />
			<span class="swatch ramp-swatch" style:--ramp={rampGradient} aria-hidden="true"></span>
			MAP grid
		</label>
		{#if mapGrid.on}
			<div class="qt small" data-testid="map-mapgrid">
				{#if mapGrid.zoomIn}
					<p class="muted" data-testid="map-mapgrid-zoom">Zoom in to see the MAP grid (to about {MAP_GRID_BBOX_MAX_DEG}° across).</p>
				{:else if mapGrid.error}
					<p class="err" role="alert">The MAP grid couldn’t be loaded: {mapGrid.error} <button type="button" class="btn btn-sm" onclick={() => mapGrid.retry()}>Try again</button></p>
				{:else if !mg}
					<p class="muted">Loading the MAP grid…</p>
				{:else if !mg.dataset}
					<p class="muted" data-testid="map-mapgrid-none">No MAP grid is loaded (<code>pnpm import:map-grid</code>, docs/maps.md § MAP grid).</p>
				{:else}
					{#if mg.datasets.length > 1}
						<label class="pick">
							Grid
							<select value={mg.dataset.dataset} onchange={(e) => mapGrid.pick(e.currentTarget.value)} data-testid="map-mapgrid-dataset">
								{#each mg.datasets as d (d.dataset)}<option value={d.dataset}>{d.dataset} ({degrees(d.cellDeg)}°){d.synthetic ? ', synthetic' : ''}</option>{/each}
							</select>
						</label>
					{/if}
					{#if mg.tooDense}
						<p class="muted" data-testid="map-mapgrid-dense">This view holds more than {fmtNum(mg.max, 0, true)} of the grid’s points: zoom in to see them.</p>
					{:else if !mg.cells.length}
						<p class="muted" data-testid="map-mapgrid-empty">The grid has no point in this view.</p>
					{:else}
						<p class="muted" data-testid="map-mapgrid-summary">
							{mgSummary}{#if mg.dataset.synthetic}{' '}<strong>Synthetic test data, never real rainfall.</strong>{/if}{labels ? '' : ' The map has no fonts for labels here, so it shows the points without their values.'}
						</p>
					{/if}
					<p class="muted" data-testid="map-mapgrid-source">Mean annual precipitation, mm a year. Source: {mg.dataset.source}</p>
				{/if}
			</div>
		{/if}
	{/if}
	{#if chirps}
		<label class="toggle">
			<input type="checkbox" checked={chirps.on} onchange={(e) => toggle('chirps', e.currentTarget.checked)} data-testid="map-layer-chirps" />
			<span class="swatch chirps-swatch" style:--ch={chirpsColour(dark)} aria-hidden="true"></span>
			CHIRPS grid
		</label>
		{#if chirps.on}
			<div class="qt small" data-testid="map-chirps">
				{#if !chirps.cells}
					<p class="muted" data-testid="map-chirps-zoom">Zoom in to see the CHIRPS grid (at most {fmtNum(CHIRPS_MAX_POINTS, 0, true)} points in view).</p>
				{:else}
					<p class="muted" data-testid="map-chirps-summary">
						{fmtNum(chirps.cells.length, 0, true)} CHIRPS v3 grid {chirps.cells.length === 1 ? 'point' : 'points'} in view, each the centre of a {CHIRPS_CELL_DEG}° cell (about 5 km): where CHIRPS gives its daily rainfall.
					</p>
				{/if}
			</div>
		{/if}
	{/if}
	{#if relief}
		<div class="tip-row">
			<label class="toggle">
				<input type="checkbox" checked={relief.on} onchange={(e) => toggle('relief', e.currentTarget.checked)} data-testid="map-layer-relief" />
				<span class="swatch relief-swatch" aria-hidden="true"></span>
				Relief
			</label>
			<HelpTip key="elevation-model" label="About the relief and the elevation model" />
		</div>
		{#if relief.on && relief.failed}
			<p class="err small" role="alert" data-testid="map-relief-error">The relief couldn’t be loaded, so the map is drawn without it.</p>
		{:else if relief.on}
			<p class="muted small" data-testid="map-relief-note">Hills shaded from the Copernicus 30 m elevation model.</p>
		{/if}
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
	/* The river network as the map draws it: a dashed line in its colour (mapStyle.ts riverNetworkColour). */
	.rn-swatch {
		border-top: 2px dashed var(--rn);
	}
	.reach {
		display: grid;
		gap: 0.25rem;
		margin: 0.35rem 0;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.reach p {
		margin: 0;
	}
	.reaches {
		max-height: 14rem;
		overflow-y: auto;
	}
	.order,
	.on-map {
		color: var(--text-muted);
	}
	.fill-row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 0.25rem 0.5rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--border);
	}
	.fill-row input {
		min-height: 24px;
		width: 100%;
	}
	.fill-row .fill-value {
		min-width: 3.2em;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.fill-row p {
		grid-column: 1 / -1;
		margin: 0;
	}
	/* A unit's outline as the layer draws it: a solid line in the parcels' green. */
	.units-swatch {
		border-top: 3px solid var(--un);
	}
	/* The MAP ramp, lowest to highest (mapStyle.ts MAP_RAMP). */
	.ramp-swatch {
		height: 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
		background: var(--ramp);
	}
	/* A CHIRPS cell: dashed, in its orange. */
	.chirps-swatch {
		border-top: 2px dashed var(--ch);
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.25rem 0;
	}
	/* A light-to-dark ramp: the shading the relief draws. */
	.relief-swatch {
		height: 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
		background: linear-gradient(135deg, var(--surface) 20%, var(--text-muted) 100%);
	}
	.layers > p {
		margin: 0;
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
	/* A label and its help tip on one line: the tip sits outside the label (a label holds only its own control). */
	.tip-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
</style>
