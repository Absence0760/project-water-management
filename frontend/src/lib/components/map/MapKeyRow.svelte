<!--
	The map's key (issue #326 E7 and A1; docs/ui.md § Map), in the Key panel
	over the map's bottom-left corner (a row under the map until 2026-10-02):
	what the areas are coloured by (`measure=`, days short by default, "Kind"
	the colours before results), for editors and owners which run (`run=`; the
	published run by default, any run, the newest when nothing is published),
	which run that is in words, and the key: each band's word, what it means
	and how many units it holds, then the kinds drawn on the map (MapTab cuts
	the key to them, mapList.ts presentKey). Every choice is in the URL (a
	history entry, so Back undoes it). Each band swatch carries the colour the
	map was given (`data-colour`, with its token and the theme it was read in
	on the row), so a test can check the colours follow the app's theme
	without reading the map's pixels.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { KeyItem } from './mapList';
	import { ewrLine, legendRows, MEASURE_PARAM, noRunLine, RUN_PARAM, runCaption, runOption, unlinkedAreas, VIEW_OPTIONS, viewLabel, viewParam, type MapView } from './mapResults';
	import type { MapResults } from './mapResults.svelte';
	import type { MapFeature } from '$lib/api/types';

	let {
		results,
		key,
		features,
		canEdit,
		dark
	}: {
		results: MapResults;
		/** The kinds' key (mapList.ts keyGroups), in the map's colours. */
		key: { label: string; items: KeyItem[] }[];
		features: readonly MapFeature[];
		canEdit: boolean;
		dark: boolean;
	} = $props();

	const uid = $props.id();
	const go = (href: string) => goto(href, { noScroll: true, keepFocus: true });
	function pickView(view: MapView) {
		const v = viewParam(view);
		const q = new URLSearchParams(page.url.search);
		if (v) q.set(MEASURE_PARAM, v);
		else q.delete(MEASURE_PARAM);
		void go(`?${q}`);
	}
	function pickRun(id: string) {
		const q = new URLSearchParams(page.url.search);
		q.set(RUN_PARAM, id);
		void go(`?${q}`);
	}

	const measure = $derived(results.view === 'kind' ? null : results.view);
	const rows = $derived(measure && results.ready ? legendRows(measure, results.units, unlinkedAreas(features)) : []);
	const ewr = $derived(results.ready ? ewrLine(results.ewr) : null);
	const caption = $derived(runCaption(results.choice));
	// While a measure shows, the areas' kinds give way to the bands: the key keeps the boundary, the lines and the points.
	const otherKinds = $derived(key.map((g) => ({ ...g, items: g.items.filter((i) => g.label !== 'Areas' || i.swatch === 'dashed') })).filter((g) => g.items.length));
</script>

{#snippet kindKey(groups: { label: string; items: KeyItem[] }[])}
	<div class="key small" role="group" aria-label="Key" data-testid="map-key">
		{#each groups as g (g.label)}
			<span class="key-group">
				<span class="key-h">{g.label}</span>
				{#each g.items as k (g.label + k.label)}
					<span class="key-item" class:noted={!!k.note} data-key-item={k.label}
						><span class="sw sw-{k.swatch}" style:--c={k.colour} aria-hidden="true"></span><span
							>{k.label}{#if k.note}<span class="muted">: {k.note}</span>{/if}</span
						></span
					>
				{/each}
			</span>
		{/each}
	</div>
{/snippet}

<div class="key-row" data-testid="map-results" data-view={results.on ? results.view : 'kind'} data-fill-theme={dark ? 'dark' : 'light'} data-ready={results.on ? (results.ready ? 'true' : 'false') : undefined}>
	{#if results.run}
		<div class="pickers small">
			<label class="pick">
				<span>Colour areas by <HelpTip key="map-results" /></span>
				<select value={results.view} onchange={(e) => pickView(e.currentTarget.value as MapView)} data-testid="map-measure">
					{#each VIEW_OPTIONS as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
				</select>
			</label>
			{#if canEdit && results.runs.length > 1}
				<label class="pick">
					<span>Run</span>
					<select value={results.run.id} onchange={(e) => pickRun(e.currentTarget.value)} data-testid="map-run">
						{#each results.runs as r (r.id)}<option value={r.id}>{runOption(r)}</option>{/each}
					</select>
				</label>
			{/if}
			{#if results.on}
				<span class="status" role="status">
					{#if results.loading}
						Loading the run’s results…
					{:else if results.error}
						Couldn’t load the run’s results. <button type="button" class="btn btn-sm" onclick={() => results.retry()}>Retry</button>
					{:else if results.view === 'damLevel' && results.damLoading}
						Loading dam levels ({results.damLoading.done} of {results.damLoading.of})…
					{:else if results.view === 'damLevel' && results.damError}
						Couldn’t load the dam levels. <button type="button" class="btn btn-sm" onclick={() => results.retryDams()}>Retry</button>
					{/if}
				</span>
			{/if}
		</div>
	{:else}
		<div class="pickers small">
			<p class="small muted no-run" data-testid="map-no-run">{noRunLine(canEdit, results.runs.length > 0)}</p>
		</div>
	{/if}

	{#if results.on}
		{#if caption}<p class="small muted caption" data-testid="map-run-caption">{caption}</p>{/if}
		{#if rows.length}
			<div class="legend small" role="group" aria-labelledby="{uid}-legend-h" data-testid="map-legend">
				<span class="key-h" id="{uid}-legend-h">{viewLabel(results.view)}</span>
				<ul class="legend-items">
				{#each rows as r (r.band)}
					<li class="legend-item" data-band={r.band} data-token={r.token} data-colour={results.colours[r.band]}>
						<span class="sw sw-band" style:--c={results.colours[r.band]} aria-hidden="true"></span>
						<strong>{r.word}</strong>
						<span>{r.text}{' '}<span class="muted">({r.count} {r.count === 1 ? 'unit' : 'units'})</span></span>
					</li>
				{/each}
				</ul>
			</div>
		{/if}
		{#if ewr}<p class="small ewr" data-testid="map-ewr-line">{ewr}; each gauge’s card and Every feature say which.</p>{/if}
		{#if otherKinds.length}{@render kindKey(otherKinds)}{/if}
	{:else if key.length}
		{@render kindKey(key)}
	{/if}
</div>

<style>
	.key-row {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}
	.pickers {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	/* The label over its select: the panel is narrow. */
	.pick {
		display: grid;
		gap: 0.15rem;
	}
	.pick span {
		color: var(--text-muted);
	}
	.pick select {
		width: 100%;
		min-height: 32px;
	}
	.status {
		color: var(--text-muted);
	}
	.status:empty {
		display: none;
	}
	.caption,
	.no-run,
	.ewr {
		margin: 0;
	}
	.legend,
	.legend-items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		color: var(--text-2);
	}
	.legend-item {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: baseline;
		gap: 0.35rem;
	}
	.key {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		color: var(--text-2);
	}
	.key-group {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
		align-items: center;
	}
	.key-h {
		font-weight: 600;
		color: var(--text);
	}
	.key-item {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	/* An entry that says what it is for (the terrain channels, the river network beside them) takes its own line. */
	.key-item.noted {
		flex-basis: 100%;
		align-items: baseline;
	}
	.key-item.noted .sw {
		align-self: center;
	}
	/* Each swatch drawn as the map draws its kind, in the colour mapStyle gives it (--c). */
	.sw {
		display: inline-block;
		flex: none;
	}
	.sw-dashed,
	.sw-line,
	.sw-dotted {
		width: 1.4rem;
		height: 0;
		border-top: 3px solid var(--c);
	}
	.sw-dashed {
		border-top-style: dashed;
	}
	.sw-dotted {
		border-top-style: dotted;
	}
	.sw-area {
		width: 1rem;
		height: 0.75rem;
		border: 2px solid var(--c);
		background: color-mix(in srgb, var(--c) 25%, transparent);
	}
	/* A band: the area as the map fills it (RESULT_FILL_OPACITY over the ground), outlined in the band's own colour. */
	.sw-band {
		width: 1rem;
		height: 0.75rem;
		border: 2px solid var(--c);
		background: color-mix(in srgb, var(--c) 75%, transparent);
	}
	.sw-gauge,
	.sw-dam,
	.sw-other {
		width: 0.85rem;
		height: 0.85rem;
		background: var(--c);
	}
	.sw-gauge {
		clip-path: polygon(50% 0, 100% 100%, 0 100%);
	}
	.sw-dam {
		border-radius: 50%;
	}
	.sw-other {
		clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
	}
</style>
