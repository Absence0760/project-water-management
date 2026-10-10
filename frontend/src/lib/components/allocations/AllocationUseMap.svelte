<script lang="ts">
	// "On the map" (issue #510, docs/allocations.md § The map, docs/ui.md §
	// Allocations): the compared run's modelled use against the registered
	// volumes, each hydrological unit's polygon shaded by band. Folded until
	// asked for (`map=1`, so Back closes it); only then are the Map tab's
	// features fetched and the map's code loaded (AllocationMap.svelte, a chunk
	// of its own, and MapLibre after it). The source (surface by default) and
	// the period (the mean of the whole water years, or one) are picked here;
	// the legend names every band in words, and every unit with no polygon is
	// listed under the map with its band, so none is silently missing. A
	// click on a unit opens its comparison above (`onpick`). It reads only
	// what the comparison already gives this reader: AllocationsTab doesn't
	// offer it to a viewer who sees totals only (D3), and no holder's name
	// is anywhere in it.
	import { PUBLIC_TILES_GLYPHS_URL, PUBLIC_TILES_URL } from '$env/static/public';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { withoutParam, withParam } from '$lib/workspace/overlays';
	import type { AllocationComparison } from '@water-management/engine';
	import { api, type MapFeature } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { appIsDark, watchAppTheme } from '$lib/components/map/appTheme';
	import { glyphsUrl } from '$lib/components/map/mapStyle';
	import { fmtNum } from '$lib/format/number';
	import { waterYearLabel } from './allocations';
	import { BAND_LABEL, BAND_SHORT, bandColours, useSentence, useShading, USE_BANDS, USE_SOURCES, wholeWaterYears, type UseBand, type UseSource } from './useMap';

	let {
		projectId,
		comparison,
		open,
		picked = null,
		onpick
	}: {
		projectId: string;
		comparison: AllocationComparison;
		open: boolean;
		picked?: string | null;
		onpick: (nodeId: string) => void;
	} = $props();

	const url = $derived(page.url);
	const tilesUrl = PUBLIC_TILES_URL?.trim() || null;
	const glyphs = glyphsUrl(PUBLIC_TILES_GLYPHS_URL, typeof location === 'undefined' ? '' : location.origin);

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
		if (open && features === null && !loading && !error) void loadFeatures();
	});

	let source = $state<UseSource>('surface');
	/** null: the mean of the whole water years. */
	let year = $state<number | null>(null);
	const years = $derived(wholeWaterYears(comparison));
	// A year the newly compared run doesn't cover falls back to the mean.
	const shownYear = $derived(year !== null && years.includes(year) ? year : null);
	const period = $derived(
		shownYear !== null ? `water year ${waterYearLabel(shownYear)}` : `the mean of ${years.length} whole water year${years.length === 1 ? '' : 's'}`
	);
	const shading = $derived(features ? useShading(comparison, features, source, shownYear) : null);
	const counts = $derived.by(() => {
		const c: Partial<Record<UseBand, number>> = {};
		for (const u of [...(shading?.drawn ?? []), ...(shading?.unplaced ?? [])]) if (u.band) c[u.band] = (c[u.band] ?? 0) + 1;
		return c;
	});
	let dark = $state(false);
	$effect(() => {
		dark = appIsDark();
		return watchAppTheme(() => (dark = appIsDark()));
	});
	const colours = $derived(bandColours(dark));
	const swatch = (b: UseBand) => (b === 'none' ? 'transparent' : colours[b].fill);
</script>

<section class="panel" aria-labelledby="alloc-map-h" data-testid="allocation-use-map">
	<div class="panel-head">
		<h2 id="alloc-map-h">On the map</h2>
		{#if open}
			<button type="button" class="btn btn-sm" aria-expanded="true" aria-controls="alloc-map-body" onclick={() => goto(withoutParam(url, 'map'), { noScroll: true, keepFocus: true })}>Hide the map</button>
		{:else}
			<a class="btn btn-sm" href={withParam(url, 'map', '1')} data-sveltekit-noscroll data-sveltekit-keepfocus aria-expanded="false" aria-controls="alloc-map-body">Show the map</a>
		{/if}
	</div>
	<p class="small muted lead">
		Each hydrological unit’s area on the Map tab, shaded by its modelled use as a share of its registered volume. Modelled, not metered: a difference is
		something to look into, not a finding.
	</p>
	<div id="alloc-map-body">
		{#if open}
			<div class="controls">
				<fieldset class="seg-field">
					<legend class="small">Water source</legend>
					<div class="seg">
						{#each USE_SOURCES as s (s.id)}
							<label class:on={source === s.id}>
								<input type="radio" name="alloc-map-source" value={s.id} checked={source === s.id} onchange={() => (source = s.id)} />
								{s.label}
							</label>
						{/each}
					</div>
				</fieldset>
				<label class="year">
					<span class="small">Water year</span>
					<select value={shownYear === null ? '' : String(shownYear)} onchange={(e) => (year = e.currentTarget.value ? Number(e.currentTarget.value) : null)} disabled={!years.length}>
						<option value="">Mean of the whole water years</option>
						{#each years as y (y)}<option value={String(y)}>{waterYearLabel(y)}</option>{/each}
					</select>
				</label>
			</div>
			{#if source === 'both'}<p class="small muted note">Both together: the unit’s total modelled use ÷ its total registered volume, surface and groundwater added.</p>{/if}

			<LoadState loading={loading && !features} {error} retry={loadFeatures}>
				{#if shading}
					{#if !years.length}
						<p class="alert alert-info slim" role="note">This run covers no whole water year (October–September), so the map has nothing to shade. Part years are left out, as in the comparison.</p>
					{/if}
					{#if shading.drawn.length || shading.notInRun.length}
						{#await import('./AllocationMap.svelte') then { default: AllocationMap }}
							<AllocationMap {shading} {tilesUrl} {glyphs} {picked} {period} {onpick} />
						{:catch}
							<ChunkFailed what="The map" />
						{/await}
					{:else}
						<p class="muted" data-testid="allocation-map-empty">
							No hydrological unit has an area on the Map tab yet, so there is nothing to shade. Draw or upload each unit’s area there and link it to the unit
							(<a href="?tab=map&layers=units">the Map tab’s Hydrological units layer</a>); the units are listed below meanwhile.
						</p>
					{/if}

					<div class="legend" data-testid="allocation-map-legend">
						<h3 class="sub-h">Key: modelled use ÷ registered volume, {period}</h3>
						<ul>
							{#each USE_BANDS as b (b)}
								<li data-band={b}>
									<span class="sw sw-{b}" style:--sw={swatch(b)} aria-hidden="true"></span>
									<span>{BAND_LABEL[b]}</span>
									<span class="muted small">{counts[b] ? `${counts[b]} unit${counts[b] === 1 ? '' : 's'}` : 'none'}</span>
								</li>
							{/each}
							<li data-band="dashed"><span class="sw sw-dashed" aria-hidden="true"></span><span>Dashed outline: no whole water year to compare, or a unit this run doesn’t have</span></li>
						</ul>
						<p class="small muted">
							Each unit carries its share of the registered volume (“132 %”). These bands are fixed for this map. The comparison above judges against the
							project’s ±{fmtNum(comparison.tolerance * 100, 0)} % band, so 90–100 % counts as “within band” there and green here.
						</p>
					</div>

					{#if shading.unplaced.length}
						<h3 class="sub-h" id="alloc-map-unplaced-h">Hydrological units with no area on the map</h3>
						<ul class="unplaced" aria-labelledby="alloc-map-unplaced-h" data-testid="allocation-map-unplaced">
							{#each shading.unplaced as u (u.nodeId)}
								<li data-node={u.nodeId} data-band={u.band ?? 'nodata'}>
									<a href={withParam(url, 'unit', u.nodeId)} onclick={(e) => {
										if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
										e.preventDefault();
										onpick(u.nodeId);
									}}>{u.name}</a>
									<span class="chip" style:--sw={u.band ? swatch(u.band) : 'transparent'} style:color={u.band && u.band !== 'none' ? colours[u.band].text : undefined} data-band={u.band ?? 'nodata'}>{u.label}</span>
									<span class="small muted">{u.band ? BAND_SHORT[u.band] : 'No whole water year'}</span>
									<span class="visually-hidden">{useSentence(u.name, u.use, period)}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if shading.notInRun.length}
						<p class="small muted" data-testid="allocation-map-not-in-run">
							Drawn as a dashed outline, not in this run (added since it ran): {shading.notInRun.map((u) => u.name).join(', ')}.
						</p>
					{/if}
				{/if}
			</LoadState>
		{/if}
	</div>
</section>

<style>
	.lead {
		margin: 0 0 0.6rem;
		max-width: 100ch;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.6rem 1.25rem;
		margin-bottom: 0.6rem;
	}
	.seg-field {
		border: 0;
		margin: 0;
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
	.year {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.year select {
		min-height: 36px;
	}
	.note {
		margin: 0 0 0.6rem;
	}
	.small {
		font-size: 0.8rem;
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
	.sw {
		display: inline-block;
		width: 1.4rem;
		height: 0.9rem;
		border: 2px solid var(--text);
		border-radius: 3px;
		background: var(--sw);
		flex: none;
	}
	.sw-unregistered,
	.chip[data-band='unregistered'] {
		background:
			repeating-linear-gradient(45deg, transparent 0 3px, color-mix(in srgb, var(--text) 50%, transparent) 3px 5px),
			var(--sw);
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
		font-size: 0.75rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.chip[data-band='none'],
	.chip[data-band='nodata'] {
		color: var(--text);
		background: var(--surface);
	}
	.chip[data-band='nodata'] {
		border-style: dashed;
	}
	@media (max-width: 640px) {
		.seg label,
		.year select {
			min-height: 44px;
		}
	}
</style>
