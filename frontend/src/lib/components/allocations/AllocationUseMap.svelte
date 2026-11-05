<script lang="ts">
	// "On the map" (issue #510, docs/allocations.md § The map, docs/ui.md §
	// Allocations): the compared run against what is registered, each
	// hydrological unit's polygon shaded by band, for the measure picked
	// (`mapMeasure=`): its water use (the default: modelled use ÷ registered
	// volume), its irrigated area (planted in the run ÷ registered) or its dam
	// (capacity in the run ÷ registered storage). Every unit's figures for that
	// measure are listed under the key. Folded until
	// asked for (`map=1`, so Back closes it); only then are the Map tab's
	// features fetched and the map's code loaded (AllocationMap.svelte, a chunk
	// of its own, and MapLibre after it). The source (surface by default) and
	// the period (the mean of the whole water years, or one) are picked here;
	// the legend names every band in words, and every unit with no polygon is
	// listed under the map with its band, so none is silently missing. The
	// measure, the source and the year are in the URL (`mapMeasure=area|storage`,
	// `mapSource=groundwater|both`, `mapYear=<first year>`; the defaults leave
	// them out; the source and year only read the water use), so a reload or a
	// shared link keeps them, and each choice is a step Back returns from. A
	// click on a unit opens its comparison above (`onpick`). It reads only
	// what the comparison already gives this reader: AllocationsTab doesn't
	// offer it to a viewer who sees totals only (D3), and no holder's name
	// is anywhere in it.
	// Show (`mapShade=registered`): beside the compared-to-run bands, "What is
	// registered" shades each unit by what its registered users in force today
	// register for the measure, on a sequential scale (registeredMap.ts), from
	// the Registered users table's subtotals: no run needed, so with no run (or
	// a run with nothing to compare) it is the only shading offered.
	import { PUBLIC_TILES_GLYPHS_URL, PUBLIC_TILES_URL } from '$app/env/public';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { withoutParam, withParam } from '#lib/workspace/overlays.js';
	import type { AllocationComparison } from '@water-management/engine';
	import { api, type MapFeature } from '#lib/api/index.js';
	import ChunkFailed from '#lib/components/common/ChunkFailed.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { appIsDark, watchAppTheme } from '#lib/components/map/appTheme.js';
	import { glyphsUrl } from '#lib/components/map/mapStyle.js';
	import { fmtNum } from '#lib/format/number.js';
	import { waterYearLabel } from './allocations';
	import { registeredColours, registeredScheme, registeredShading, REGISTERED_STEPS, REGISTERED_TITLE, stepLabel, type RegisteredStep } from './registeredMap';
	import type { RegisteredFigures } from './registeredUsers';
	import {
		bandColours,
		MAP_MEASURES,
		MEASURE_BAND_LABEL,
		MEASURE_BAND_SHORT,
		MEASURE_RATIO,
		measureFigure,
		useSentence,
		useScheme,
		useShading,
		USE_BANDS,
		USE_SOURCE_ID,
		USE_SOURCES,
		wholeWaterYears,
		type MapMeasure,
		type ShadedUnit,
		type UseBand,
		type UseSource
	} from './useMap';

	let {
		projectId,
		comparison,
		registered,
		open,
		picked = null,
		onpick,
		onpickRegistered
	}: {
		projectId: string;
		/** The compared run's comparison; null with no run, or nothing in it to compare: then only what is registered is shaded. */
		comparison: AllocationComparison | null;
		/** The project's units and each one's registered figures in force today (the Registered users table's subtotals). */
		registered: { units: readonly { id: string; name: string }[]; subtotals: ReadonlyMap<string, RegisteredFigures> };
		open: boolean;
		picked?: string | null;
		onpick: (nodeId: string) => void;
		/** A unit picked while what is registered is shaded (its registered users); `onpick` when absent. */
		onpickRegistered?: (nodeId: string) => void;
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

	// The source and the year, from the URL (ui-playbook § "A pick is a step in history": every filter is in the URL,
	// so a reload keeps it); anything unknown reads as the default.
	const measureParam = $derived(url.searchParams.get('mapMeasure'));
	const measure = $derived<MapMeasure>(MAP_MEASURES.find((m) => m.id === measureParam)?.id ?? 'use');
	const sourceParam = $derived(url.searchParams.get('mapSource'));
	const source = $derived<UseSource>(USE_SOURCES.find((s) => s.id === sourceParam)?.id ?? 'surface');
	const yearParam = $derived(url.searchParams.get('mapYear'));
	/** null: the mean of the whole water years. */
	const year = $derived(yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : null);
	// What is shaded: against the run (the default when there is one to compare) or what is registered (`mapShade=registered`).
	const shadeParam = $derived(url.searchParams.get('mapShade'));
	const view = $derived<'run' | 'registered'>(comparison && shadeParam !== 'registered' ? 'run' : 'registered');
	/** The page with one of the map's choices set (null or the default: left out). A choice pushes, so Back returns to the one before. */
	function choose(name: 'mapMeasure' | 'mapSource' | 'mapYear' | 'mapShade', value: string | null) {
		void goto(value === null ? withoutParam(url, name) : withParam(url, name, value), { reset: false });
	}
	/** Hide the map: its choices go with it. */
	function hide() {
		const q = new URLSearchParams(url.search);
		for (const k of ['map', 'mapMeasure', 'mapSource', 'mapYear', 'mapShade']) q.delete(k);
		const s = q.toString();
		void goto(`${url.pathname}${s ? `?${s}` : ''}${url.hash}`, { reset: false });
	}
	const years = $derived(comparison ? wholeWaterYears(comparison) : []);
	// A year the newly compared run doesn't cover falls back to the mean.
	const shownYear = $derived(year !== null && years.includes(year) ? year : null);
	const period = $derived(
		shownYear !== null ? `water year ${waterYearLabel(shownYear)}` : `the mean of ${years.length} whole water year${years.length === 1 ? '' : 's'}`
	);
	/** The key's heading: what it divides, and for the water use the period (the area and the dam are the run's inputs). */
	const keyTitle = $derived(view === 'registered' ? `Key: ${REGISTERED_TITLE[measure]}, in force today` : `Key: ${MEASURE_RATIO[measure]}${measure === 'use' ? `, ${period}` : ''}`);
	const runShading = $derived(features && comparison && view === 'run' ? useShading(comparison, features, source, shownYear, measure) : null);
	const regShading = $derived(features && view === 'registered' ? registeredShading(registered.units, registered.subtotals, features, measure) : null);
	const shading = $derived(runShading ?? regShading);
	const pick = $derived(view === 'registered' ? (onpickRegistered ?? onpick) : onpick);
	const scheme = $derived(view === 'registered' ? registeredScheme(measure, USE_SOURCE_ID) : useScheme(period, measure));
	const regCounts = $derived.by(() => {
		const c: Partial<Record<RegisteredStep, number>> = {};
		for (const u of [...(regShading?.drawn ?? []), ...(regShading?.unplaced ?? [])]) c[u.band] = (c[u.band] ?? 0) + 1;
		return c;
	});

	const BAND_RANK: Record<UseBand, number> = { far: 0, over: 1, unregistered: 2, near: 3, under: 4, none: 5 };
	/** Every unit with its figures for the measure, in the order to look into them (the list under the key). */
	const figures = $derived.by(() => {
		if (!runShading) return [];
		const placed = new Set(runShading.drawn.map((u) => u.nodeId));
		const rank = (u: ShadedUnit) => (u.band ? BAND_RANK[u.band] : 6);
		return [...runShading.drawn, ...runShading.unplaced]
			.map((u) => ({ ...u, placed: placed.has(u.nodeId) }))
			.sort((a, b) => rank(a) - rank(b) || (b.use?.ratio ?? 0) - (a.use?.ratio ?? 0) || a.name.localeCompare(b.name));
	});
	const figureCell = (v: number | undefined) => (v === undefined ? '–' : measureFigure(measure, v));
	const modelledHead = $derived(measure === 'use' ? 'Modelled use' : measure === 'area' ? 'Planted in the run' : 'Dam in the run');
	const counts = $derived.by(() => {
		const c: Partial<Record<UseBand, number>> = {};
		for (const u of [...(runShading?.drawn ?? []), ...(runShading?.unplaced ?? [])]) if (u.band) c[u.band] = (c[u.band] ?? 0) + 1;
		return c;
	});
	let dark = $state(false);
	$effect(() => {
		dark = appIsDark();
		return watchAppTheme(() => (dark = appIsDark()));
	});
	const colours = $derived(bandColours(dark));
	const regColours = $derived(registeredColours(dark));
	const swatch = (b: UseBand) => (b === 'none' ? 'transparent' : colours[b].fill);
</script>

<section class="panel" aria-labelledby="alloc-map-h" data-testid="allocation-use-map">
	<div class="panel-head">
		<h2 id="alloc-map-h">On the map</h2>
		{#if open}
			<button type="button" class="btn btn-sm" aria-expanded="true" aria-controls="alloc-map-body" onclick={hide}>Hide the map</button>
		{:else}
			<a class="btn btn-sm" href={withParam(url, 'map', '1')} data-sveltekit-noscroll data-sveltekit-keepfocus aria-expanded="false" aria-controls="alloc-map-body">Show the map</a>
		{/if}
	</div>
	<p class="small muted lead">
		{#if comparison}
			Each hydrological unit’s area on the Map tab, shaded by what the run has as a share of what is registered for it (its water use, its irrigated area or
			its dam; modelled, not metered: a difference is something to look into, not a finding), or by what is registered alone, with no run needed.
		{:else}
			Each hydrological unit’s area on the Map tab, shaded by what its registered users register in force today: their water use, irrigated area or farm dam
			capacity, the Registered users table’s subtotals. No run is needed.
		{/if}
	</p>
	<div id="alloc-map-body">
		{#if open}
			<div class="controls">
				{#if comparison}
					<fieldset class="seg-field">
						<legend class="small">Show</legend>
						<div class="seg">
							<label class:on={view === 'run'}>
								<input type="radio" name="alloc-map-view" value="run" checked={view === 'run'} onchange={() => choose('mapShade', null)} />
								Against the run
							</label>
							<label class:on={view === 'registered'}>
								<input type="radio" name="alloc-map-view" value="registered" checked={view === 'registered'} onchange={() => choose('mapShade', 'registered')} />
								What is registered
							</label>
						</div>
					</fieldset>
				{/if}
				<fieldset class="seg-field">
					<legend class="small">Shade by</legend>
					<div class="seg">
						{#each MAP_MEASURES as m (m.id)}
							<label class:on={measure === m.id}>
								<input type="radio" name="alloc-map-measure" value={m.id} checked={measure === m.id} onchange={() => choose('mapMeasure', m.id === 'use' ? null : m.id)} />
								{m.label}
							</label>
						{/each}
					</div>
				</fieldset>
				{#if view === 'run' && measure === 'use'}
					<fieldset class="seg-field">
						<legend class="small">Water source</legend>
						<div class="seg">
							{#each USE_SOURCES as s (s.id)}
								<label class:on={source === s.id}>
									<input type="radio" name="alloc-map-source" value={s.id} checked={source === s.id} onchange={() => choose('mapSource', s.id === 'surface' ? null : s.id)} />
									{s.label}
								</label>
							{/each}
						</div>
					</fieldset>
					<label class="year">
						<span class="small">Water year</span>
						<select value={shownYear === null ? '' : String(shownYear)} onchange={(e) => choose('mapYear', e.currentTarget.value || null)} disabled={!years.length}>
							<option value="">Mean of the whole water years</option>
							{#each years as y (y)}<option value={String(y)}>{waterYearLabel(y)}</option>{/each}
						</select>
					</label>
				{/if}
			</div>
			{#if view === 'registered'}
				<p class="small muted note" data-testid="allocation-map-registered-note">
					What is registered: each unit’s registered users added up, their authorisations in force today
					({measure === 'use' ? 'the volumes of their takes, surface and groundwater added' : measure === 'area' ? 'the irrigated areas their takes state' : 's21b rows and the storage stated on a take'}).
					No run is read. The figures are the Registered users table’s subtotals.
				</p>
			{:else}
				{#if measure === 'area'}<p class="small muted note">Irrigated area: the crop areas the run planted on the unit against the irrigated areas its registered users’ takes state (in force on any of the run’s days). The model never reads a registered area.</p>{/if}
				{#if measure === 'storage'}<p class="small muted note">Dam capacity: the unit’s dam in the run against the storage registered for it (s21b rows and storage stated on a take).</p>{/if}
				{#if measure === 'use' && source === 'both'}<p class="small muted note">Both together: the unit’s total modelled use ÷ its total registered volume, surface and groundwater added.</p>{/if}
			{/if}

			<LoadState loading={loading && !features} {error} retry={loadFeatures}>
				{#if shading}
					{#if view === 'run' && measure === 'use' && !years.length}
						<p class="alert alert-info slim" role="note">This run covers no whole water year (October–September), so the map has nothing to shade. Part years are left out, as in the comparison.</p>
					{/if}
					{#if shading.drawn.length || shading.notInRun.length}
						{#await import('./AllocationMap.svelte') then { default: AllocationMap }}
							<AllocationMap {shading} {tilesUrl} {glyphs} picked={view === 'run' ? picked : null} {scheme} onpick={pick} />
						{:catch}
							<ChunkFailed what="The map" />
						{/await}
					{:else}
						<p class="muted" data-testid="allocation-map-empty">
							No hydrological unit has an area on the Map tab yet, so there is nothing to shade. Draw or upload each unit’s area there and link it to the unit
							(<a href="?tab=map&layers=units">the Map tab’s Hydrological units layer</a>); the units are listed below meanwhile.
						</p>
					{/if}

					<div class="legend" data-testid="allocation-map-legend" data-view={view}>
						<h3 class="sub-h">{keyTitle}</h3>
						{#if regShading}
							<ul>
								{#each REGISTERED_STEPS as b (b)}
									<li data-band={b}>
										<span class="sw" style:--sw={regColours[b].fill} aria-hidden="true"></span>
										<span>{stepLabel(b, regShading.breaks, measure)}</span>
										<span class="muted small">{regCounts[b] ? `${regCounts[b]} unit${regCounts[b] === 1 ? '' : 's'}` : 'none'}</span>
									</li>
								{/each}
								<li data-band="none">
									<span class="sw" style:--sw="transparent" aria-hidden="true"></span>
									<span>Nothing registered (outline only)</span>
									<span class="muted small">{regCounts.none ? `${regCounts.none} unit${regCounts.none === 1 ? '' : 's'}` : 'none'}</span>
								</li>
							</ul>
							<p class="small muted">Each unit carries its registered figure. Five equal steps from 0 to the largest unit’s figure, rounded up; darker is more.</p>
						{:else}
							<ul>
								{#each USE_BANDS as b (b)}
									<li data-band={b}>
										<span class="sw sw-{b}" style:--sw={swatch(b)} aria-hidden="true"></span>
										<span>{MEASURE_BAND_LABEL[measure][b]}</span>
										<span class="muted small">{counts[b] ? `${counts[b]} unit${counts[b] === 1 ? '' : 's'}` : 'none'}</span>
									</li>
								{/each}
								<li data-band="dashed"><span class="sw sw-dashed" aria-hidden="true"></span><span>Dashed outline: {measure === 'use' ? 'no whole water year to compare' : 'no figures to compare'}, or a unit this run doesn’t have</span></li>
							</ul>
							<p class="small muted">
								Each unit carries its share of what is registered for it (“132 %”). These bands are fixed for this map. The comparison above judges against the
								project’s ±{fmtNum((comparison?.tolerance ?? 0.1) * 100, 0)} % band, so 90–100 % counts as “within band” there and green here.
							</p>
						{/if}
					</div>

					{#if figures.length}
						<h3 class="sub-h" id="alloc-map-figures-h">Every hydrological unit’s figures</h3>
						<div class="table-stack">
							<div class="table-wrap figures-wrap">
								<table class="data" aria-labelledby="alloc-map-figures-h" data-testid="allocation-map-figures" data-measure={measure}>
									<thead>
										<tr>
											<th scope="col">Hydrological unit or user</th>
											<th scope="col" class="num">Registered</th>
											<th scope="col" class="num">{modelledHead}</th>
											<th scope="col" class="num">Share of registered</th>
											<th scope="col">Band</th>
										</tr>
									</thead>
									<tbody>
										{#each figures as u (u.nodeId)}
											<tr data-node={u.nodeId} data-band={u.band ?? 'nodata'}>
												<th scope="row">{u.name}{#if !u.placed}<span class="sub muted">no area on the map</span>{/if}</th>
												<td class="num" data-label="Registered">{figureCell(u.use?.registered)}</td>
												<td class="num" data-label={modelledHead}>{figureCell(u.use?.modelled)}</td>
												<td class="num" data-label="Share of registered">{u.label}</td>
												<td data-label="Band"
													><span class="sw sw-{u.band ?? 'dashed'}" style:--sw={u.band ? swatch(u.band) : 'transparent'} aria-hidden="true"></span>
													{u.band ? MEASURE_BAND_SHORT[measure][u.band] : measure === 'use' ? 'No whole water year' : 'No figures'}</td
												>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					{#if runShading?.unplaced.length}
						<h3 class="sub-h" id="alloc-map-unplaced-h">Hydrological units with no area on the map</h3>
						<ul class="unplaced" aria-labelledby="alloc-map-unplaced-h" data-testid="allocation-map-unplaced">
							{#each runShading.unplaced as u (u.nodeId)}
								<li data-node={u.nodeId} data-band={u.band ?? 'nodata'}>
									<a href={withParam(url, 'unit', u.nodeId)} onclick={(e) => {
										if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
										e.preventDefault();
										onpick(u.nodeId);
									}}>{u.name}</a>
									<span class="chip" style:--sw={u.band ? swatch(u.band) : 'transparent'} style:color={u.band && u.band !== 'none' ? colours[u.band].text : undefined} data-band={u.band ?? 'nodata'}>{u.label}</span>
									<span class="small muted">{u.band ? MEASURE_BAND_SHORT[measure][u.band] : measure === 'use' ? 'No whole water year' : 'No figures'}</span>
									<span class="visually-hidden">{useSentence(u.name, u.use, period, measure)}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if regShading?.unplaced.length}
						<h3 class="sub-h" id="alloc-map-unplaced-h">Hydrological units with no area on the map</h3>
						<ul class="unplaced" aria-labelledby="alloc-map-unplaced-h" data-testid="allocation-map-unplaced">
							{#each regShading.unplaced as u (u.nodeId)}
								<li data-node={u.nodeId} data-band={u.band}>
									<a href="#alloc-users-{u.nodeId}" onclick={(e) => {
										if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
										e.preventDefault();
										pick(u.nodeId);
									}}>{u.name}</a>
									<span class="chip" style:--sw={u.band === 'none' ? 'transparent' : regColours[u.band].fill} style:color={u.band === 'none' ? undefined : regColours[u.band].text} data-band={u.band}>{u.label}</span>
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
		font-size: var(--font-xs);
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
