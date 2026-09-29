<script lang="ts">
	// River & reserve → the run's outflow against the pragmatic EWR, the Runs
	// tab's "EWR vs simulated outflow" chart (flowSeries.ts), with a 30 days /
	// 1 year / All switch and the days below the reserve shaded (the run's
	// ewr_shortfall series, summaryChart.ts). Its own chunk (it pulls in uPlot),
	// loaded by RiverTab only once the run's record is in. Series come
	// through the Runs tab's cache, so opening the run there next draws at once.
	// The plot's height is the page's to give (`height`, a fixed number: the
	// page flows in the window's one scroll, so nothing sizes it to the window). The
	// Runs tab's old controls can be turned on: the m³/s ↔ m³/day switch
	// (`units`) and Earlier / Later by the window picked (`pannable`). The
	// shaded days are dates from the shortfall series, so they hold in both units.
	// The Summary drew this chart too until issue #162: it now shows the
	// days below the reserve by month (ReserveStrip.svelte) and links here.
	import type { DailySeries } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { EWR_RULE_CAPTION, EWR_RULE_KEY, ewrChartSeries, type CatchmentFlows } from '$lib/components/runs/flowSeries';
	import { toDisplayUnit } from '$lib/components/runs/results';
	import { fmtNum } from '$lib/format/number';
	import { belowReserve, FLOW_OPEN_DAYS, FLOW_WINDOWS } from './summaryChart';

	let {
		projectId,
		runId,
		refs,
		forecastFrom = null,
		height = 240,
		units = false,
		pannable = false
	}: {
		projectId: string;
		runId: string;
		/** The run's stored series (its detail record), so only series it has are fetched. */
		refs: RunSeriesRef[];
		/** A forecast run's first forecast day: the chart shades from it. */
		forecastFrom?: string | null;
		/** The plot's height in px. */
		height?: number;
		/** The m³/s ↔ m³/day switch (off: m³/s only). */
		units?: boolean;
		/** Earlier / Later through the record, by the window picked, and Shift+drag. */
		pannable?: boolean;
	} = $props();

	// The outlet's Reserve rule requirement too, when it has a table (issue #51): the headline judges that line.
	const SLOTS = [['simulated', 'simulated_outflow'], ['ewr', 'ewr'], EWR_RULE_KEY, ['shortfall', 'ewr_shortfall']] as const;

	// $state.raw: long daily arrays must not become deep proxies (RunCharts.svelte).
	let flows = $state.raw<CatchmentFlows & { shortfall?: DailySeries }>({});
	let loading = $state(true);
	let error = $state<string | null>(null);
	let log = $state(true);
	let attempt = $state(0);

	$effect(() => {
		const id = runId;
		void attempt;
		const present = SLOTS.filter(([, key]) => refs.some((r) => r.key === key && r.nodeId === null));
		loading = true;
		error = null;
		Promise.all(
			present.map(async ([slot, key]) => {
				const d = await cachedSeries(id, key, null, () => api.runs.series(projectId, id, key, null));
				return [slot, d] as const;
			})
		)
			.then((pairs) => {
				if (id === runId) flows = Object.fromEntries(pairs);
			})
			.catch((e) => {
				if (id === runId) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === runId) loading = false;
			});
	});

	let unit = $state<'m³/s' | 'm³/day'>('m³/s');
	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', unit).values;
	const series = $derived(ewrChartSeries(flows, conv));
	const band = $derived(forecastBand(forecastFrom));
	const shade = $derived(flows.shortfall ? belowReserve(flows.shortfall) : []);
	const shortDays = $derived(shade.reduce((n, r) => n + (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000 + 1, 0));
	const pragmatic = $derived(
		flows.shortfall && shortDays === 0
			? 'The outflow never fell below the pragmatic EWR line: the EWR was met every day.'
			: flows.shortfall
			? `Shaded: the ${fmtNum(shortDays)} day${shortDays === 1 ? '' : 's'} the outflow was below the pragmatic EWR line (EWR not met).`
			: 'Days the outflow dips below the pragmatic EWR line count as EWR not met.'
	);
	const caption = $derived(flows.ewrRule ? `${pragmatic} ${EWR_RULE_CAPTION}` : pragmatic);
</script>

{#snippet unitToggle()}
	<span class="seg" role="group" aria-label="Flow units">
		<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/s'} onclick={() => (unit = 'm³/s')}>m³/s</button>
		<button type="button" class="btn btn-sm" aria-pressed={unit === 'm³/day'} onclick={() => (unit = 'm³/day')}>m³/day</button>
	</span>
{/snippet}

<section class="panel flow" aria-labelledby="flow-h" aria-busy={loading}>
	<div class="head">
		<h2 id="flow-h">Flow vs reserve</h2>
	</div>
	<LoadState {loading} {error} retry={() => attempt++}>
		{#if series.length === 0}
			<p class="muted">This run stored no outflow or EWR series.</p>
		{:else}
			<LineChart
				title="EWR vs simulated outflow"
				{unit}
				{height}
				{series}
				{shade}
				logToggle
				bind:log
				recentDays={FLOW_OPEN_DAYS}
				windows={FLOW_WINDOWS}
				{pannable}
				toolbar={units ? unitToggle : undefined}
				{band}
				{caption}
			/>
		{/if}
	</LoadState>
</section>

<style>
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.25rem;
	}
	.flow h2 {
		margin: 0;
		font-size: 1.05rem;
	}
</style>
