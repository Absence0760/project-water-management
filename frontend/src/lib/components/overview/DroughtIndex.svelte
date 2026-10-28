<!--
	Summary → Drought index (issue #620, docs/ui.md § Summary): SPI and SPEI over 3, 6 and 12 months for
	the last whole month of the latest run's history, from its own rain_final and pet (engine
	droughtBadge, docs/model.md §2.15b). A view of the run's record: nothing is stored. The headline is
	the driest index; each cell gives the value and its class, or why it has none. Workspace only.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { droughtBadge, type DailySeries, type DroughtBadge } from '@water-management/engine';
	import { api, type RunSeriesRef } from '#lib/api/index.js';
	import { cachedSeries } from '#lib/components/runs/cache.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { DROUGHT_PET, DROUGHT_RAIN, droughtHeadline, droughtRows, droughtSeries, monthText, noIndexText, referenceText } from './drought';

	let {
		projectId,
		runId,
		refs,
		lastDay,
		ready = $bindable(false)
	}: {
		projectId: string;
		runId: string;
		/** The run's stored series (its detail's list). */
		refs: RunSeriesRef[];
		/** The run's last day of history: a forecast run's forecast days are left out. */
		lastDay: string;
		/** True once the series have loaded or failed (the card has its final height); for the Summary's data-ready. */
		ready?: boolean;
	} = $props();

	const has = $derived(droughtSeries(refs));
	let badge = $state.raw<DroughtBadge | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let key = '';
	async function load() {
		const k = (key = `${runId}|${lastDay}`);
		badge = null;
		error = null;
		if (!has.rain) {
			loading = false;
			return;
		}
		loading = true;
		const get = (name: string): Promise<DailySeries> => cachedSeries(runId, name, null, () => api.runs.series(projectId, runId, name, null));
		try {
			const [rain, pet] = await Promise.all([get(DROUGHT_RAIN), has.pet ? get(DROUGHT_PET) : Promise.resolve(null)]);
			if (key === k) badge = droughtBadge({ rain, pet, lastDay });
		} catch (e) {
			if (key === k) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (key === k) loading = false;
		}
	}
	$effect(() => {
		const k = `${runId}|${lastDay}`;
		untrack(() => {
			if (k !== key) load();
		});
	});
	$effect(() => {
		ready = !loading;
	});

	const rows = $derived(badge ? droughtRows(badge) : []);
	const head = $derived(badge ? droughtHeadline(badge) : null);
	const reference = $derived(badge ? referenceText(badge) : null);
</script>

<section class="panel drought" aria-labelledby="drought-h" aria-busy={loading} data-testid="drought-index">
	<div class="panel-head">
		<h2 id="drought-h">Drought index <HelpTip key="drought-index" /></h2>
		{#if head}<span class="badge tone-{head.tone}" data-testid="drought-headline">{head.label} · {head.index}</span>{/if}
	</div>
	<LoadState {loading} {error} retry={load}>
		{#if !has.rain}
			<p class="muted small">This run has no final catchment rainfall to compute the index from.</p>
		{:else if badge && rows.length && !head}
			<!-- No index has a value: one line, not a table of dashes. -->
			<p class="muted small" data-testid="drought-none">
				{noIndexText(badge)}
			</p>
		{:else if badge && rows.length}
			<table class="data">
				<caption class="small">To the end of {monthText(badge.month!)}, the latest run’s last whole month</caption>
				<thead>
					<tr><th scope="col">Months</th><th scope="col">SPI (rain)</th><th scope="col">SPEI (rain − evaporation)</th></tr>
				</thead>
				<tbody>
					{#each rows as r (r.scale)}
						<tr data-scale={r.scale}>
							<th scope="row">{r.scale} <span class="muted">{r.period}</span></th>
							{#each [r.spi, r.spei] as c, j (j)}
								<td data-kind={j === 0 ? 'spi' : 'spei'} data-tone={c.tone ?? 'none'}>
									<span class="num">{c.value}</span>
									{#if c.label}<span class="cls {c.tone ? `tone-${c.tone}` : 'muted'}">{c.label}</span>{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="muted small">{reference ?? 'No calendar month has the 20 years a fit needs.'} Below −1 is drier than usual, above 1 wetter.</p>
		{:else}
			<p class="muted small">The latest run has no whole month of rain.</p>
		{/if}
	</LoadState>
</section>

<style>
	/* No margin of its own: the Summary's grids space it (OverviewTab). */
	.drought {
		margin: 0;
	}
	.panel-head h2 {
		font-size: 1.05rem;
	}
	caption {
		text-align: left;
		color: var(--text-muted);
		padding-bottom: 0.25rem;
	}
	td .num {
		font-variant-numeric: tabular-nums;
		margin-right: 0.4rem;
	}
	/* The class under its value, so the table fits a phone without scrolling sideways. */
	.cls {
		display: block;
		font-size: var(--font-xs);
	}
	th .muted {
		display: block;
		font-size: var(--font-xs);
		font-weight: 400;
	}
	/* The class is written out, so the colour only repeats it (WCAG 1.4.1). */
	.tone-dry {
		color: var(--warning);
	}
	.badge.tone-dry {
		background: var(--warning-soft);
		border-color: transparent;
	}
	.tone-wet {
		color: var(--accent);
	}
	.badge.tone-wet {
		background: var(--accent-soft);
		border-color: transparent;
	}
	.small {
		font-size: 0.85rem;
		margin: 0.4rem 0 0;
	}
</style>
