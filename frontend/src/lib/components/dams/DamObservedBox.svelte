<!--
	Dams → "Seen from space" (issue #604 R5-B; docs/ui.md § Dams, docs/model.md § Modelled vs observed dam area).
	Inside the picked dam's chart panel, under its storage chart, folded to one line named "Seen from space:"
	(observedLine): how many clear satellite views were compared with the run's surface area and how many
	disagree. No heading of its own: the fold's line carries the name, so the closed box is one line and the
	panel fits a 1280×800 window (it had an h3 over the fold until the R5-B review). Opened: the match
	notes (an outline DE Africa Waterbodies merged with a neighbour, or doesn't have), the full area and a
	summary in words, how many views each source gave (Sentinel-2, WOfS, Sentinel-1 radar, Waterbodies; a day
	several saw goes to the sharpest, issue #624), the chart of the run's modelled surface area (the
	`dam_area` column, ha) beside the views (radar's as rings), the flags as lanes along its
	foot (disagree, seen full, seen empty, and a doubled strip for the radar days, never a flag) with the
	axis making room for them under 0 ha, the newest views in a table (VIEWS_SHOWN, "Show all N views" for
	the rest), and the credit (Copernicus's too when Sentinel views are listed). A viewer (`readonly`) is told an editor draws the outline, not to draw it. The observations are one request for the run (GET …/dams/observations?run=), so picking another
	dam reads no more; the modelled series comes through the Runs cache when the fold opens.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { DailySeries } from '@water-management/engine';
	import { api, type DamObservations } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import Fold from '#lib/components/common/Fold.svelte';
	import { FLOW_WINDOWS } from '#lib/components/overview/summaryChart.js';
	import { cachedSeries } from '#lib/components/runs/cache.js';
	import { fmtNum } from '#lib/format/number.js';
	import { mapNodeHref } from '#lib/workspace/mapLinks.js';
	import { creditLine, fullAreaWords, matchNotes, observedChartSeries, observedFor, observedLanes, observedLine, RADAR_LANES_NOTE, sourcesLine, summaryWords, viewRows, VIEWS_SHOWN } from './observed';
	import { foldList } from '#lib/components/common/fold.js';

	let {
		projectId,
		runId,
		nodeId,
		name,
		readonly = false,
		open = $bindable(false)
	}: {
		projectId: string;
		/** The run the Dams tab shows: the observations are compared with its dam_area. */
		runId: string;
		/** The picked dam's unit. */
		nodeId: string;
		name: string;
		/** A viewer: can't draw an outline, so the no-outline line says an editor does. */
		readonly?: boolean;
		open?: boolean;
	} = $props();

	const uid = $props.id();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	// --- the run's observations, all dams at once ---
	let data = $state.raw<DamObservations | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	let dataKey = '';
	$effect(() => {
		const key = `${projectId}|${runId}|${attempt}`;
		untrack(() => {
			if (key === dataKey) return;
			dataKey = key;
			data = null;
			error = null;
			loading = true;
			api
				.damObservations(projectId, runId)
				.then((d) => {
					if (dataKey === key) data = d;
				})
				.catch((e) => {
					if (dataKey === key) error = msg(e);
				})
				.finally(() => {
					if (dataKey === key) loading = false;
				});
		});
	});

	const dam = $derived(observedFor(data, nodeId));

	// --- the run's modelled surface area for the picked dam, once the fold is open ---
	let modelled = $state.raw<DailySeries | null>(null);
	let modelledError = $state<string | null>(null);
	let modelledAttempt = $state(0);
	let modelledKey = '';
	$effect(() => {
		const key = open && dam?.inRun ? `${runId}|${nodeId}|${modelledAttempt}` : '';
		untrack(() => {
			if (key === modelledKey) return;
			modelledKey = key;
			modelled = null;
			modelledError = null;
			if (!key) return;
			cachedSeries(runId, 'dam_area', nodeId, () => api.runs.series(projectId, runId, 'dam_area', nodeId))
				.then((s) => {
					if (modelledKey === key) modelled = s;
				})
				.catch((e) => {
					if (modelledKey === key) modelledError = msg(e);
				});
		});
	});

	const withinShare = $derived(data?.thresholds.withinShare ?? 0.1);
	const line = $derived(observedLine(dam, loading, error, withinShare));
	const waiting = $derived(!!dam?.inRun && !modelled && !modelledError);
	const series = $derived(dam && !waiting ? observedChartSeries(dam, modelled, data?.run?.forecastFrom) : []);
	const lanes = $derived(dam ? observedLanes(dam) : []);
	const lanesNote = $derived(lanes.some((l) => l.doubled) ? RADAR_LANES_NOTE : '');
	const sources = $derived(dam ? sourcesLine(dam) : null);
	const rows = $derived(dam ? viewRows(dam) : []);
	// The newest views, the rest behind "Show all N views" (ui-playbook.md § 2, fold every long list); a new dam shuts it.
	let allViews = $state(false);
	$effect(() => {
		void nodeId;
		allViews = false;
	});
	const folded = $derived(foldList(rows, (r) => r.key, null, allViews, VIEWS_SHOWN));
	const notes = $derived(dam ? matchNotes(dam) : []);
	const summary = $derived(dam && data ? summaryWords(dam, withinShare) : null);
	const minClear = $derived(data ? fmtNum(data.thresholds.minPctObserved) : '90');
</script>

<section class="observed" aria-label="{name} seen from space" data-testid="dam-observed" data-ready={!loading && (!open || !waiting) ? 'true' : 'false'}>
	<Fold name="Seen from space:" {line} readonly problem={false} body="stack" class="observed-fold" lineTestid="dam-observed-line" bind:open>
		{#if error}
			<p class="err small" role="alert">
				The satellite views couldn’t be loaded: {error}
				<button type="button" class="btn btn-sm" onclick={() => attempt++}>Try again</button>
			</p>
		{:else if loading}
			<p class="muted small" role="status">Loading the satellite views…</p>
		{:else if !dam}
			<p class="muted small" data-testid="dam-observed-no-outline">
				{#if readonly}
					No outline of {name}’s dam on the map. Satellites are compared inside the dam’s outline, which an editor draws on the Map.
				{:else}
					No outline of {name}’s dam on the map. Satellites are compared inside the dam’s outline: draw its water surface as a polygon on
					the Map and link it to {name}.
				{/if}
				<a href={mapNodeHref(nodeId)}>Open the Map</a>
			</p>
		{:else}
			{#each notes as n (n)}<p class="small note" data-testid="dam-observed-match">{n}</p>{/each}
			{#if !dam.points.length}
				<p class="muted small" data-testid="dam-observed-empty">
					No satellite views of {name}’s dam yet. They are read each week from Digital Earth Africa once the dam’s outline is on the map.
				</p>
			{:else}
				{#if !dam.inRun}
					<p class="muted small">{name} isn’t in this run, so the views are shown without the model’s area.</p>
				{/if}
				{#if fullAreaWords(dam) || summary}
					<p class="small" data-testid="dam-observed-summary">{fullAreaWords(dam) ?? ''} {summary ?? ''}</p>
				{/if}
				{#if sources}
					<p class="small note" data-testid="dam-observed-sources">{sources}</p>
				{/if}
				{#if modelledError}
					<p class="err small" role="alert">
						The run’s surface area couldn’t be loaded: {modelledError}
						<button type="button" class="btn btn-sm" onclick={() => modelledAttempt++}>Try again</button>
					</p>
				{:else if waiting}
					<p class="muted small" role="status">Loading the run’s surface area…</p>
				{:else if series.length}
					<LineChart
						title="{name}: surface area, modelled and seen from space"
						unit="ha"
						height={240}
						{series}
						windows={FLOW_WINDOWS}
						{lanes}
						lanesLabel={lanesNote ? 'Flags and radar days' : 'Flags'}
						{lanesNote}
						lanesRoom
						pannable={false}
						toolsLabel="Seen from space chart controls"
						caption="Points: clear satellite views (at least {minClear}% of the dam seen{lanesNote ? '; rings: radar' : ''}). Line: the run’s surface area at the start of each day. Dashed: the area when full."
					/>
				{/if}
				<details class="views">
					<summary>The {fmtNum(rows.length)} view{rows.length === 1 ? '' : 's'}, newest first</summary>
					<div class="rows-box"><div class="table-wrap">
						<table class="data compact" id="{uid}-views" data-testid="dam-observed-views">
							<caption class="visually-hidden">Satellite views of {name}’s dam, newest first, beside the run’s surface area</caption>
							<thead>
								<tr>
									<th scope="col">Date</th>
									<th scope="col">Source</th>
									<th scope="col" class="num">Seen</th>
									<th scope="col" class="num">Clear</th>
									<th scope="col" class="num">Modelled</th>
									<th scope="col">Compared</th>
								</tr>
							</thead>
							<tbody>
								{#each folded.shown as r (r.key)}
									<tr class:mismatch={r.mismatch}>
										<th scope="row">{r.date}</th>
										<td data-label="Source">{r.source}</td>
										<td class="num" data-label="Seen">{r.seen}</td>
										<td class="num" data-label="Clear">{r.clear}</td>
										<td class="num" data-label="Modelled">{r.modelled}</td>
										<td class="note-cell" data-label="Compared">{r.note}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div></div>
					{#if folded.hidden || allViews}
						<button type="button" class="btn btn-sm more" aria-expanded={allViews} aria-controls="{uid}-views" onclick={() => (allViews = !allViews)}>
							{allViews ? `Show the newest ${fmtNum(VIEWS_SHOWN)} views` : `Show all ${fmtNum(rows.length)} views`}
						</button>
					{/if}
				</details>
			{/if}
			{#if data}<p class="fine muted" data-testid="dam-observed-credit">{creditLine(data.attribution, dam)}</p>{/if}
		{/if}
	</Fold>
</section>

<style>
	.observed {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		min-width: 0;
		margin: 1rem 0 0;
	}
	.observed :global(.observed-fold .fold-stack) {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
	}
	.small,
	.fine {
		font-size: 0.85rem;
		margin: 0;
	}
	.note {
		color: var(--text-2);
	}
	.err {
		color: var(--danger);
	}
	.views summary {
		cursor: pointer;
		min-height: 24px;
		font-size: 0.85rem;
	}
	/* No inner scroll: the list is folded to the newest views instead (a phone showed two rows at a time in a 20rem box). */
	.table-wrap {
		max-height: none;
		margin-top: 0.4rem;
	}
	.more {
		margin-top: 0.4rem;
	}
	.num {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	tr.mismatch th,
	tr.mismatch td:last-child {
		color: var(--danger);
	}
	/* Narrower than the table's columns (a phone): each view is a block, its date on top, its figures side by side
	   under their labels, then what the comparison says, so nothing scrolls sideways (ui-playbook.md § 2 "Fit a wide
	   table by stacking"; DamProposalsBox's rows). 36rem = 504 px at the 14 px root. */
	.rows-box {
		container: dam-observed-rows / inline-size;
	}
	@container dam-observed-rows (max-width: 36rem) {
		table,
		tbody {
			display: block;
		}
		thead {
			display: none;
		}
		tr {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 0.3rem 0.75rem;
			padding: 0.5rem 0.25rem;
		}
		tr + tr {
			border-top: 1px solid var(--border);
		}
		table.data th,
		table.data td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			min-width: 0;
		}
		th[scope='row'],
		td[data-label='Source'],
		.note-cell {
			grid-column: 1 / -1;
		}
		td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: var(--font-xs);
			color: var(--text-2);
		}
	}
</style>
