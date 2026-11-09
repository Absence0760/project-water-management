<script lang="ts">
	// EWR → "On the map" (docs/ui.md § EWR): each hydrological unit's area on the
	// Map tab shaded by how the flow passing it compares with the EWR required at
	// it, for the run on the page (RunSummary.unitEwr, engine ≥ 1.116.0, docs/model.md
	// §2.11c; rules in ewrMap.ts). Folded until asked for (`ewrMap=1`, so Back
	// closes it); only then are the Map tab's features fetched and the map's code
	// loaded (the Allocations map's own component, allocations/AllocationMap.svelte,
	// a chunk of its own, and MapLibre after it). Shade by (`ewrMapMeasure=ratio`;
	// the default, Requirement met, is left out) is a step Back returns from. The
	// key names every band in words with its count, every unit carries its % as a
	// label, and every unit's figures are in the table under the key, so colour is
	// never the only cue and no unit is silently missing. A click on a unit opens
	// it on Hydrological units.
	import { PUBLIC_TILES_GLYPHS_URL, PUBLIC_TILES_URL } from '$app/env/public';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { RunSummary } from '@water-management/engine';
	import { api, type MapFeature } from '#lib/api/index.js';
	import ChunkFailed from '#lib/components/common/ChunkFailed.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { appIsDark, watchAppTheme } from '#lib/components/map/appTheme.js';
	import { glyphsUrl } from '#lib/components/map/mapStyle.js';
	import { EWR_MAP_ANCHOR, EWR_MAP_HEADING } from '#lib/components/river/links.js';
	import { supplyHref } from '#lib/components/supply/links.js';
	import { fmtNum } from '#lib/format/number.js';
	import { withoutParam, withParam } from '#lib/workspace/overlays.js';
	import {
		byConcern,
		ewrColours,
		ewrCounts,
		ewrMapMeasure,
		ewrScheme,
		ewrShading,
		EWR_BAND_LABEL,
		EWR_BAND_SHORT,
		EWR_BANDS,
		EWR_MAP_MEASURE_PARAM,
		EWR_MAP_MEASURES,
		EWR_MAP_PARAM,
		EWR_MEASURE_RATIO,
		type EwrBand
	} from './ewrMap';

	let {
		projectId,
		runId,
		summary
	}: {
		projectId: string;
		/** The run on the page: a unit picked opens on Hydrological units for it. */
		runId: string;
		summary: Pick<RunSummary, 'unitEwr' | 'withheld'>;
	} = $props();

	const url = $derived(page.url);
	const open = $derived(url.searchParams.get(EWR_MAP_PARAM) === '1');
	const measure = $derived(ewrMapMeasure(url.searchParams.get(EWR_MAP_MEASURE_PARAM)));
	const tilesUrl = PUBLIC_TILES_URL?.trim() || null;
	const glyphs = glyphsUrl(PUBLIC_TILES_GLYPHS_URL, typeof location === 'undefined' ? '' : location.origin);
	const units = $derived(summary.unitEwr ?? null);
	const withheld = $derived(!units && !!summary.withheld?.includes('unitEwr'));

	let features = $state.raw<MapFeature[] | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	async function loadFeatures() {
		loading = true;
		error = null;
		try {
			features = (await api.map.list(projectId)).features;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		if (open && units && features === null && !loading && !error) void loadFeatures();
	});

	/** Shade by: a push, so Back returns to the measure before; the default is left out of the URL. */
	function choose(m: string) {
		void goto(m === 'met' ? withoutParam(url, EWR_MAP_MEASURE_PARAM) : withParam(url, EWR_MAP_MEASURE_PARAM, m), { reset: false });
	}
	/** Hide the map: its measure goes with it. */
	function hide() {
		const q = new URLSearchParams(url.search);
		q.delete(EWR_MAP_PARAM);
		q.delete(EWR_MAP_MEASURE_PARAM);
		const s = q.toString();
		void goto(`${url.pathname}${s ? `?${s}` : ''}${url.hash}`, { reset: false });
	}
	function pick(nodeId: string) {
		void goto(supplyHref(runId, { unit: nodeId, hash: 'res-farm' }));
	}

	const shading = $derived(features && units ? ewrShading(units, features, measure) : null);
	const scheme = $derived(ewrScheme(measure));
	const counts = $derived(shading ? ewrCounts(shading) : null);
	const placed = $derived(new Set(shading?.drawn.map((u) => u.nodeId) ?? []));
	const figures = $derived(shading ? [...shading.drawn, ...shading.unplaced].sort(byConcern) : []);
	const n = (k: number) => (k ? `${k} unit${k === 1 ? '' : 's'}` : 'none');
	const secondHead = $derived(measure === 'met' ? 'EWR met' : 'Flow passing it');

	let dark = $state(false);
	$effect(() => {
		dark = appIsDark();
		return watchAppTheme(() => (dark = appIsDark()));
	});
	const colours = $derived(ewrColours(dark));
	const swatch = (b: EwrBand) => (b === 'none' ? 'transparent' : colours[b].fill);
</script>

<section class="panel" id={EWR_MAP_ANCHOR} aria-labelledby="ewr-map-h" data-testid="ewr-unit-map">
	<div class="panel-head">
		<h2 id="ewr-map-h">{EWR_MAP_HEADING}</h2>
		{#if open}
			<button type="button" class="btn btn-sm" aria-expanded="true" aria-controls="ewr-map-body" onclick={hide}>Hide the map</button>
		{:else}
			<a class="btn btn-sm" href={withParam(url, EWR_MAP_PARAM, '1')} data-sveltekit-noscroll data-sveltekit-keepfocus aria-expanded="false" aria-controls="ewr-map-body">Show the map</a>
		{/if}
	</div>
	<p class="small muted lead">
		Each hydrological unit’s area on the Map tab, shaded by how the flow passing it compares with the EWR required at it over this run. The EWR required at a
		unit is its own share of the EWR plus the shares of the units above it, so the flow leaving it is judged against everything the river still owes there.
		Modelled, not measured. A unit with no EWR share at or above it shows “No EWR share”.
	</p>
	<div id="ewr-map-body">
		{#if open}
			{#if !units}
				<p class="muted" data-testid="ewr-map-no-figures">
					{#if withheld}
						Each unit’s EWR figures aren’t shown to you for this run.
					{:else}
						This run was made before each unit’s EWR figures were recorded. Run the model again to see them on the map.
					{/if}
				</p>
			{:else}
				<fieldset class="seg-field">
					<legend class="small">Shade by</legend>
					<div class="seg">
						{#each EWR_MAP_MEASURES as m (m.id)}
							<label class:on={measure === m.id}>
								<input type="radio" name="ewr-map-measure" value={m.id} checked={measure === m.id} onchange={() => choose(m.id)} />
								{m.label}
							</label>
						{/each}
					</div>
				</fieldset>
				<p class="small muted note" data-testid="ewr-map-measure-note">
					{#if measure === 'met'}
						Requirement met: of the EWR required at the unit over the run, the share the flow passing it covered, day by day (a wet day’s extra flow doesn’t make
						up for a dry day’s shortfall). At most 100 %: green is met in full.
					{:else}
						Flow ÷ requirement: the unit’s outflow over the run against the EWR required at it. It can pass 100 %, and a wet year’s floods count, so a unit can be
						green here and still short on dry days; Requirement met shows those.
					{/if}
				</p>

				<LoadState loading={loading && !features} {error} retry={loadFeatures}>
					{#if shading && counts}
						{#if shading.drawn.length || shading.notInRun.length}
							{#await import('#lib/components/allocations/AllocationMap.svelte') then { default: AllocationMap }}
								<AllocationMap {shading} {tilesUrl} {glyphs} {scheme} onpick={pick} />
							{:catch}
								<ChunkFailed what="The map" />
							{/await}
						{:else}
							<p class="muted" data-testid="ewr-map-empty">
								No hydrological unit has an area on the Map tab yet, so there is nothing to shade. Draw or upload each unit’s area there and link it to the unit
								(<a href="?tab=map&layers=units">the Map tab’s Hydrological units layer</a>); every unit’s figures are listed below meanwhile.
							</p>
						{/if}

						<div class="legend" data-testid="ewr-map-legend" data-measure={measure}>
							<h3 class="sub-h">Key: {EWR_MEASURE_RATIO[measure]}, over the run</h3>
							<ul>
								{#each EWR_BANDS as b (b)}
									<li data-band={b}>
										<span class="sw" style:--sw={swatch(b)} aria-hidden="true"></span>
										<span>{EWR_BAND_LABEL[b]}</span>
										<span class="muted small">{n(counts[b])}</span>
									</li>
								{/each}
								<li data-band="none">
									<span class="sw" style:--sw="transparent" aria-hidden="true"></span>
									<span>{EWR_BAND_LABEL.none} (outline only)</span>
									<span class="muted small">{n(counts.none)}</span>
								</li>
								<li data-band="unplaced">
									<span class="sw sw-dashed" aria-hidden="true"></span>
									<span>No area on the map (listed below)</span>
									<span class="muted small">{n(counts.unplaced)}</span>
								</li>
							</ul>
							<p class="small muted">
								Each unit carries its share (“87 %”), rounded down so it never shows the next band’s edge. The counts add up to every unit in the run.
							</p>
						</div>

						<h3 class="sub-h" id="ewr-map-figures-h">Every hydrological unit’s figures</h3>
						<div class="table-stack">
						<div class="table-wrap figures-wrap">
							<table class="data" aria-labelledby="ewr-map-figures-h" data-testid="ewr-map-figures" data-measure={measure}>
								<thead>
									<tr>
										<th scope="col">Hydrological unit or user</th>
										<th scope="col" class="num">EWR required</th>
										<th scope="col" class="num">{secondHead}</th>
										<th scope="col" class="num">Share</th>
										<th scope="col">Band</th>
									</tr>
								</thead>
								<tbody>
									{#each figures as u (u.nodeId)}
										<tr data-node={u.nodeId} data-band={u.band}>
											<th scope="row"
												><a href={supplyHref(runId, { unit: u.nodeId, hash: 'res-farm' })}>{u.name}</a>{#if !placed.has(u.nodeId)}<span class="sub muted">no area on the map</span>{/if}</th
											>
											<td class="num" data-label="EWR required">{fmtNum(u.figures.requiredM3)} m³</td>
											<td class="num" data-label={secondHead}>{u.ratio === null ? '–' : `${fmtNum(measure === 'met' ? u.figures.metM3 : u.figures.outflowM3)} m³`}</td>
											<td class="num" data-label="Share">{u.label}</td>
											<td data-label="Band"
												><span class="sw" style:--sw={swatch(u.band)} aria-hidden="true"></span>
												{EWR_BAND_SHORT[u.band]}</td
											>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
						</div>

						{#if shading.unplaced.length}
							<h3 class="sub-h" id="ewr-map-unplaced-h">Hydrological units with no area on the map</h3>
							<ul class="unplaced" aria-labelledby="ewr-map-unplaced-h" data-testid="ewr-map-unplaced">
								{#each shading.unplaced as u (u.nodeId)}
									<li data-node={u.nodeId} data-band={u.band}>
										<a href={supplyHref(runId, { unit: u.nodeId, hash: 'res-farm' })}>{u.name}</a>
										<span class="chip" style:--sw={swatch(u.band)} style:color={u.band === 'none' ? undefined : colours[u.band].text} data-band={u.band}>{u.label}</span>
										<span class="small muted">{EWR_BAND_SHORT[u.band]}</span>
									</li>
								{/each}
							</ul>
						{/if}
						{#if shading.notInRun.length}
							<p class="small muted" data-testid="ewr-map-not-in-run">
								Drawn as a dashed outline, not in this run (added since it ran): {shading.notInRun.map((u) => u.name).join(', ')}.
							</p>
						{/if}
					{/if}
				</LoadState>
			{/if}
		{/if}
	</div>
</section>

<style>
	.lead {
		margin: 0 0 0.6rem;
		max-width: 100ch;
	}
	.seg-field {
		border: 0;
		margin: 0 0 0.6rem;
		padding: 0;
		min-width: 0;
	}
	.seg-field legend {
		padding: 0;
		margin-bottom: 0.2rem;
	}
	.seg {
		flex-wrap: wrap;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-sm);
	}
	.seg label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.75rem;
		min-height: 36px;
		cursor: pointer;
		font-size: 0.88rem;
	}
	.seg label + label {
		border-left: 1px solid var(--border-input);
	}
	.seg label.on {
		background: var(--accent-soft);
		font-weight: 600;
	}
	.note {
		margin: 0 0 0.6rem;
		max-width: 100ch;
	}
	.sub-h {
		margin: 0.9rem 0 0.4rem;
		font-size: 1rem;
	}
	.legend ul,
	.unplaced {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.3rem;
	}
	.legend li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.5rem;
		font-size: 0.85rem;
	}
	.legend p {
		margin: 0.5rem 0 0;
		max-width: 100ch;
	}
	.figures-wrap {
		max-height: none;
	}
	.figures-wrap .sub {
		display: block;
		font-weight: 400;
		font-size: var(--font-xs);
	}
	.figures-wrap td .sw {
		vertical-align: middle;
		margin-right: 0.3rem;
	}
	.sw {
		display: inline-block;
		width: 1.4rem;
		height: 0.9rem;
		border: 2px solid var(--text);
		border-radius: 3px;
		background: var(--sw);
		flex: none;
	}
	.sw-dashed {
		border-style: dashed;
		background: transparent;
	}
	.unplaced li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.6rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid var(--border);
	}
	.unplaced a {
		font-weight: 600;
		min-height: 24px;
		display: inline-flex;
		align-items: center;
		overflow-wrap: anywhere;
	}
	.chip {
		display: inline-block;
		padding: 0 0.45rem;
		border: 2px solid var(--text);
		border-radius: 999px;
		background: var(--sw);
		font-size: var(--font-xs);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.chip[data-band='none'] {
		color: var(--text);
		background: var(--surface);
	}
	@media (max-width: 640px) {
		.seg label {
			min-height: 44px;
		}
	}
</style>
