<script lang="ts">
	// Units & supply → the picked unit (issue #17): its supply against its
	// abstraction demand, day by day, with the days it was short shaded, and
	// its dam's storage. The unit detail panel of Runs & results, moved here:
	// the same series (fetched once each, through the Runs cache) and the same
	// words, one chart at a time behind a switch, with the 30 days / 1 year /
	// All windows. With `fit` the chart fills the height its panel is given.
	import type { DailySeries, FarmSummary } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { FLOW_OPEN_DAYS, FLOW_WINDOWS } from '$lib/components/overview/summaryChart';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { storagePct } from '$lib/components/runs/results';
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
		fit = false
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
		/** Fill the panel's height (the page's window-fitting layout) instead of a fixed chart height. */
		fit?: boolean;
	} = $props();

	const band = $derived(forecastBand(forecastFrom));
	const has = (key: string, nodeId: string) => refs.some((r) => r.key === key && r.nodeId === nodeId);
	const get = (key: string, nodeId: string): Promise<DailySeries> => cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	let data = $state.raw<{ storage?: DailySeries; demand?: DailySeries; supplied?: DailySeries }>({});
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
			has('dam_storage', id) ? get('dam_storage', id) : Promise.resolve(undefined),
			has('demand', id) ? get('demand', id) : Promise.resolve(undefined),
			has('supplied', id) ? get('supplied', id) : Promise.resolve(undefined)
		])
			.then(([storage, demand, supplied]) => {
				if (id === farm.nodeId && run === runId) data = { storage, demand, supplied };
			})
			.catch((e) => {
				if (id === farm.nodeId && run === runId) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === farm.nodeId && run === runId) loading = false;
			});
	});

	const hasDam = $derived(capacity >= 1);
	let view = $state<'supply' | 'storage'>('supply');
	const shown = $derived(hasDam ? view : 'supply');
	const supplySeries = $derived.by<ChartSeries[]>(() => {
		const out: ChartSeries[] = [];
		const { demand, supplied } = data;
		if (demand) out.push({ label: 'Abstraction demand', startDate: demand.startDate, values: demand.values, color: '--series-2', style: 'dashed', width: 1.25 });
		if (supplied) out.push({ label: 'Supplied', startDate: supplied.startDate, values: supplied.values, color: '--series-1', width: 1.25 });
		return out;
	});
	const storageSeries = $derived.by<ChartSeries[]>(() => {
		const s = data.storage;
		const pct = s ? storagePct(s.values, capacity) : null;
		return s && pct ? [{ label: 'Dam storage', startDate: s.startDate, values: pct, color: '--series-1' }] : [];
	});
	const shade = $derived(deficit ? shortRanges(deficit) : []);

	// Filling: the plot gets what the slot leaves after the chart's own head, legend and caption (DamsTab's way).
	const FIXED_H = 260;
	const MIN_H = 180;
	let slot: HTMLDivElement | undefined = $state();
	let fig: HTMLDivElement | undefined = $state();
	let fillH = $state(FIXED_H);
	$effect(() => {
		if (!fit || !slot || !fig) return;
		const s = slot;
		const f = fig;
		const measure = () => {
			const wrap = f.querySelector<HTMLElement>('.u-wrap');
			if (!wrap) return;
			const target = Math.max(MIN_H, Math.floor(s.clientHeight - (f.offsetHeight - wrap.offsetHeight)));
			if (Math.abs(target - fillH) > 2) fillH = target;
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(s);
		ro.observe(f);
		return () => ro.disconnect();
	});
	const chartH = $derived(fit ? fillH : FIXED_H);
</script>

<section class="panel detail" class:fit id="res-farm" aria-labelledby="farm-h" aria-busy={loading}>
	<div class="panel-head">
		<h2 id="farm-h"><span class="visually-hidden">Unit detail:</span> {name}</h2>
		{#if hasDam}
			<span class="seg" role="group" aria-label="Chart">
				<button type="button" class="btn btn-sm" aria-pressed={shown === 'supply'} onclick={() => (view = 'supply')}>Supply vs demand</button>
				<button type="button" class="btn btn-sm" aria-pressed={shown === 'storage'} onclick={() => (view = 'storage')}>Dam storage</button>
			</span>
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
	{:else}
		<div class="slot" bind:this={slot}>
			<div bind:this={fig}>
				{#if shown === 'supply'}
					{#if supplySeries.length}
						<LineChart
							title="Supply vs demand"
							unit="m³/day"
							height={chartH}
							series={supplySeries}
							recentDays={FLOW_OPEN_DAYS}
							windows={FLOW_WINDOWS}
							{shade}
							{band}
							caption={shade.length ? 'Shaded: the days the unit got less than its demand.' : undefined}
						/>
					{:else}
						<div class="chart-ph" style:height="{chartH}px" role="status">{loading ? 'Loading…' : 'No demand series.'}</div>
					{/if}
				{:else if storageSeries.length}
					<LineChart title="Dam storage, % of capacity" unit="%" height={chartH} series={storageSeries} recentDays={FLOW_OPEN_DAYS} windows={FLOW_WINDOWS} {band} />
				{:else if loading}
					<div class="chart-ph" style:height="{chartH}px" role="status">Loading…</div>
				{:else}
					<p class="muted nodam">This unit has no dam storage in the run.</p>
				{/if}
			</div>
		</div>
	{/if}
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
	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
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
	.nodam {
		padding: 2rem 0;
		text-align: center;
	}
	.fit {
		min-height: 0;
	}
	.fit .slot {
		flex: 1 1 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
