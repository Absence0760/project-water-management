<script lang="ts">
	// Units & supply → the picked unit (issue #17): its supply against its
	// abstraction demand, day by day, with the days it was short shaded. The
	// unit detail panel of Runs & results, moved here: the same series
	// (fetched once each, through the Runs cache) and the same words, with the
	// 30 days / 1 year / All windows, at the plot height the page gives it. A
	// unit with a dam links to its storage on the Dams page (`?tab=dams&dam=`),
	// whose chart has the capacity and minimum lines this panel's own "Dam
	// storage" view lacked (removed 2026-09-29, issue #175). Under the chart,
	// the unit's assurance of supply (issue #444, reliability/NodeAssurance):
	// its reliability and its stress classes by month, with a link to every
	// year's grid in Assurance of supply below, which opens on this unit.
	import type { DailySeries, FarmSummary, SupplyAssurance } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { FLOW_OPEN_DAYS, FLOW_WINDOWS } from '$lib/components/overview/summaryChart';
	import { cachedSeries } from '$lib/components/runs/cache';
	import NodeAssurance from '$lib/components/reliability/NodeAssurance.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { shortRanges } from './supply';

	let {
		projectId,
		runId,
		refs,
		farm,
		name,
		capacity,
		deficit = null,
		forecastFrom = null,
		height = 260,
		assurance = null,
		engineVersion = null
	}: {
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		/** The unit's whole-record figures in the run. */
		farm: FarmSummary;
		/** Today's name (the run's when the unit has gone). */
		name: string;
		/** The unit's dam capacity in the run (m³); under 1 = no dam. */
		capacity: number;
		/** Its daily deficit, when the page has fetched it: the days short are shaded. */
		deficit?: DailySeries | null;
		forecastFrom?: string | null;
		/** The plot's height in px (taller beside the cards on a wide page). */
		height?: number;
		/** The run's assurance of supply (RunSummary.supplyAssurance; absent on a run before engine 0.32.0). */
		assurance?: SupplyAssurance | null;
		/** The run's engine version, for the "not computed" note on older runs. */
		engineVersion?: string | null;
	} = $props();

	const band = $derived(forecastBand(forecastFrom));
	// The plot's height: the page's, less the assurance under it when the page gives a tall plot (beside the
	// cards, where the panel sits level with them), never under PLOT_MIN; stacked, the page flows and the plot keeps its height.
	const PLOT_MIN = 240;
	let assuranceH = $state(0);
	const plotH = $derived(height > 300 ? Math.max(PLOT_MIN, height - assuranceH) : height);
	const has = (key: string, nodeId: string) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const get = (key: string, nodeId: string): Promise<DailySeries> => cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	let data = $state.raw<{ demand?: DailySeries; supplied?: DailySeries }>({});
	let loading = $state(false);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	$effect(() => {
		const id = farm.nodeId;
		const run = runId;
		void attempt;
		loading = true;
		error = null;
		data = {};
		Promise.all([
			has('demand', id) ? get('demand', id) : Promise.resolve(undefined),
			has('supplied', id) ? get('supplied', id) : Promise.resolve(undefined)
		])
			.then(([demand, supplied]) => {
				if (id === farm.nodeId && run === runId) data = { demand, supplied };
			})
			.catch((e) => {
				if (id === farm.nodeId && run === runId) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === farm.nodeId && run === runId) loading = false;
			});
	});

	const hasDam = $derived(capacity >= 1);
	const supplySeries = $derived.by<ChartSeries[]>(() => {
		const out: ChartSeries[] = [];
		const { demand, supplied } = data;
		if (demand) out.push({ label: 'Abstraction demand', startDate: demand.startDate, values: demand.values, color: '--series-2', style: 'dashed', width: 1.25 });
		if (supplied) out.push({ label: 'Supplied', startDate: supplied.startDate, values: supplied.values, color: '--series-1', width: 1.25 });
		return out;
	});
	const shade = $derived(deficit ? shortRanges(deficit) : []);
</script>

<section class="panel detail" id="res-farm" aria-labelledby="farm-h" aria-busy={loading}>
	<div class="panel-head">
		<h2 id="farm-h"><span class="visually-hidden">Hydrological unit detail:</span> {name}</h2>
		{#if hasDam}
			<a class="dam-link" href="?tab=dams&dam={encodeURIComponent(farm.nodeId)}">Dam storage on the Dams page</a>
		{/if}
	</div>
	<p class="muted small facts" data-testid="unit-facts">
		Abstraction demand {fmtNum(farm.avgDemandM3Day)} m³/day, supplied {fmtNum(farm.avgSuppliedM3Day)} m³/day
		({fmtPct(farm.fractionSupplied)}){hasDam ? ` · dam ${fmtNum(capacity)} m³` : ' · no dam'}.
	</p>
	{#if error}
		<div class="alert alert-error" role="alert">
			{error} <button type="button" class="btn btn-sm" onclick={() => attempt++}>Try again</button>
		</div>
	{:else if supplySeries.length}
		<LineChart
			title="Supply vs demand"
			unit="m³/day"
			height={plotH}
			series={supplySeries}
			recentDays={FLOW_OPEN_DAYS}
			windows={FLOW_WINDOWS}
			{shade}
			{band}
			caption={shade.length ? 'Shaded: the days the hydrological unit got less than its demand.' : undefined}
		/>
	{:else}
		<div class="chart-ph" style:height="{plotH}px" role="status">{loading ? 'Loading…' : 'No demand series.'}</div>
	{/if}
	<!-- Beside the cards (a tall plot), the plot gives up the assurance's height, so the panel keeps its size and the first screen. -->
	<div bind:clientHeight={assuranceH}>
		<NodeAssurance {assurance} nodeId={farm.nodeId} {engineVersion} heading="Assurance of supply: {name}">
			{#snippet more()}<a href="#res-assurance" data-testid="unit-assurance-link">Every year by month, in Assurance of supply below</a>{/snippet}
		</NodeAssurance>
	</div>
</section>

<style>
	.detail {
		margin: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.panel-head h2 {
		font-size: 1.05rem;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.dam-link {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		font-size: 0.9rem;
	}
	.facts {
		margin: 0 0 0.5rem;
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
</style>
