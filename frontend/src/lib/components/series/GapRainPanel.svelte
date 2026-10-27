<!--
	Data → Rain products side by side (issue #604 R4-E, docs/ui.md § Data):
	while Model settings → Rain gaps chooses ERA5-Land or IMERG Late
	(settings.gapRain), CHIRPS, ERA5-Land and IMERG Late over one CHIRPS feed's
	cells on one chart, as each product reads them, then the double mass of
	catchment rain against each product (the CHIRPS one is the panel above it),
	and the credits their values carry. The outlet's feed first, as the runs
	read it; a land unit's own CHIRPS feed from the picker. It fetches the
	products itself (GET …/feeds/gap-rain); the CHIRPS values are the page's. Its own chunk (SeriesTab loads it only with the setting).
-->
<script lang="ts">
	import { api } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import type { Daily } from './coverage';
	import DoubleMassPanel from './DoubleMassPanel.svelte';
	import { feedOptionLabel, fillProblems, gapRainApi, productChartCaption, productChartSeries, productDoubleMass, viewCredits, type GapRainView } from './gapRain';

	let {
		projectId,
		values,
		gapLine
	}: {
		projectId: string;
		/** The page's loaded series values by id: the picked feed's CHIRPS is read from it. */
		values: Record<string, Daily>;
		/** What the settings choose, in words ("ERA5-Land, and IMERG Late for the recent days"). */
		gapLine: string;
	} = $props();

	const uid = $props.id();
	let view = $state.raw<GapRainView | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let picked = $state<string | null>(null);
	let ask = 0;

	async function load(feed: string | null) {
		const n = ++ask;
		loading = true;
		error = null;
		try {
			const got = await gapRainApi(api, projectId).get(feed);
			if (n !== ask) return;
			view = got;
			picked = got.feed;
		} catch (e) {
			if (n === ask) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (n === ask) loading = false;
		}
	}
	$effect(() => {
		void load(null);
	});

	const feed = $derived(view?.feeds.find((f) => f.id === view?.feed) ?? null);
	const chirps = $derived(feed ? (values[feed.seriesId] ?? null) : null);
	const lines = $derived(productChartSeries(chirps, view));
	const held = $derived(!!(view?.era5l || view?.imergLate));
	const masses = $derived(productDoubleMass(view));
	const credits = $derived(viewCredits(view, new Date().toISOString().slice(0, 10)));
	// A failed fill on the runs' feed's latest fetch, said as such rather than as "nothing held yet".
	const problems = $derived(fillProblems(view));
	const WINDOWS = [
		{ label: '30 days', days: 30 },
		{ label: '1 year', days: 365 },
		{ label: 'All', days: null }
	] as const;
</script>

<section class="panel" aria-labelledby="{uid}-h" data-testid="gap-rain-products" aria-busy={loading}>
	<div class="panel-head">
		<h2 id="{uid}-h">Rain products side by side</h2>
		<HelpTip key="settings.gapRain" label="About the gap-filling products" />
	</div>
	<p class="summary">
		Gaps in the catchment rain are filled from {gapLine} (<a href="?tab=settings#set-rain">Rain gaps</a>). Each product is drawn as it reads, before a run corrects it to the catchment rain.
	</p>
	{#if view && view.feeds.length > 1}
		<div class="field pick">
			<label for="{uid}-feed">CHIRPS feed</label>
			<select
				id="{uid}-feed"
				value={picked}
				onchange={(e) => {
					picked = e.currentTarget.value;
					void load(picked);
				}}
			>
				{#each view.feeds as f (f.id)}<option value={f.id}>{feedOptionLabel(f)}{f.runsRead ? ' (the runs read this one)' : ''}</option>{/each}
			</select>
		</div>
	{/if}
	{#if error}
		<div class="alert alert-error" role="alert">
			Couldn’t load ERA5-Land and IMERG Late ({error}).
			<button
				type="button"
				class="btn btn-sm"
				data-retry
				onclick={(e) => {
					followRetry(e.currentTarget);
					void load(picked);
				}}>Try again</button
			>
		</div>
	{:else if loading && !view}
		<p class="muted" role="status" data-loading>Loading ERA5-Land and IMERG Late…</p>
	{:else if view && !view.feeds.length}
		<p class="muted" data-testid="gap-rain-empty">No CHIRPS feed writes this project’s CHIRPS, so there are no cells to read ERA5-Land or IMERG Late over. <a href="#data-feeds">Attach a CHIRPS feed</a> first.</p>
	{:else if view && !held && problems.length}
		{#each problems as p (p)}<p class="alert alert-warning" role="note" data-testid="gap-rain-fill-failed">{p}</p>{/each}
	{:else if view && !held}
		<p class="muted" data-testid="gap-rain-empty">
			Nothing held for these cells yet. The CHIRPS feed the runs read brings ERA5-Land and IMERG Late on its next fetch{feed && !feed.runsRead ? '; this feed’s cells are only filled where they share the runs’ cells' : ''}.
		</p>
	{:else if view}
		{#each problems as p (p)}<p class="alert alert-warning" role="note" data-testid="gap-rain-fill-failed">{p}</p>{/each}
		<LineChart
			title="Daily rain: CHIRPS, ERA5-Land and IMERG Late"
			unit="mm"
			height={260}
			series={lines}
			windows={WINDOWS}
			recentDays={365}
			toolsLabel="Rain products chart controls"
			caption={productChartCaption(view, feed)}
		/>
		{#each masses as m (m.product)}
			<DoubleMassPanel dm={m.dm} against={m.label} level={3} />
		{:else}
			<p class="muted small">No double mass against the products yet: it needs catchment rain and a product over at least a few water years (IMERG Late keeps a few weeks).</p>
		{/each}
	{/if}
	{#if credits.length}
		<ul class="credits muted" data-testid="gap-rain-credits" aria-label="Rain data credits">
			{#each credits as c (c.product)}{#each c.lines as l (l)}<li><strong>{c.name}:</strong> {l}</li>{/each}{/each}
		</ul>
	{/if}
</section>

<style>
	.panel-head {
		gap: 0.3rem;
		justify-content: flex-start;
	}
	.summary {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		max-width: 80ch;
	}
	.pick {
		max-width: 28rem;
		margin-bottom: 0.75rem;
	}
	.credits {
		margin: 0.75rem 0 0;
		padding-left: 1.1rem;
		font-size: var(--font-sm);
		max-width: 100ch;
	}
</style>
